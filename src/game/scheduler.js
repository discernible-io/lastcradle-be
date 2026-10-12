/**
 * Schedules automatic phase transitions for running games.
 */

const { RoditClient } = require("@rodit/rodit-auth-be");
const repo = require("./repository");
const engine = require("./engine");
const events = require("./events");
const orchestrator = require("./lobby-orchestrator");
const { onGamePhaseUpdated, notifyDeadlineWarningForGame } = require("./webhooks");
const { DEFAULT_GAME_CONFIG } = require("./defaults");

const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();

/** Do not fire a deadline warning if it would land this close to phase end. */
const DEADLINE_WARNING_MIN_GAP_MS = 5 * 1000;

const timers = new Map();

function clearGameTimers(gameId) {
  const existing = timers.get(gameId);
  if (!existing) return;
  for (const key of ["negotiation", "execution", "deadline", "deadlineWarning"]) {
    if (existing[key]) clearTimeout(existing[key]);
  }
  timers.delete(gameId);
}

function schedulePhaseTransition(gameId, phase, endsAtIso, handler) {
  if (!endsAtIso) return;

  const endsAt = new Date(endsAtIso).getTime();
  const delay = Math.max(0, endsAt - Date.now());

  const entry = timers.get(gameId) || {};
  if (entry[phase]) clearTimeout(entry[phase]);
  entry[phase] = setTimeout(async () => {
    try {
      await handler();
    } catch (err) {
      logger.errorWithContext("Game phase transition failed", {
        component: "GameScheduler",
        gameId,
        phase,
        error: err.message
      });
    }
  }, delay);
  timers.set(gameId, entry);
}

function resolveDeadlineWarningLeadMs(game) {
  const configured = game?.config?.deadlineWarningLeadMs;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_GAME_CONFIG.deadlineWarningLeadMs;
}

/**
 * Schedule a mid-window deadline_warning agent hook for pending execution submitters.
 * Skips when the phase is shorter than the lead, or the fire time is already past /
 * within DEADLINE_WARNING_MIN_GAP_MS of phase end.
 */
function scheduleDeadlineWarning(game) {
  if (!game || game.status !== "running" || game.phase !== "execution" || !game.execution_ends_at) {
    return;
  }

  const endsAt = new Date(game.execution_ends_at).getTime();
  if (!Number.isFinite(endsAt)) {
    return;
  }

  const leadMs = resolveDeadlineWarningLeadMs(game);
  const phaseDurationMs =
    typeof game.config?.executionDurationMs === "number"
      ? game.config.executionDurationMs
      : DEFAULT_GAME_CONFIG.executionDurationMs;

  if (phaseDurationMs > 0 && phaseDurationMs <= leadMs) {
    return;
  }

  const fireAt = endsAt - leadMs;
  const delay = fireAt - Date.now();
  if (delay < 0 || endsAt - fireAt < DEADLINE_WARNING_MIN_GAP_MS) {
    return;
  }

  const gameId = game.id;
  const entry = timers.get(gameId) || {};
  if (entry.deadlineWarning) clearTimeout(entry.deadlineWarning);
  entry.deadlineWarning = setTimeout(() => {
    notifyDeadlineWarningForGame(gameId).catch((err) => {
      logger.warnWithContext("Deadline warning webhook delivery failed", {
        component: "GameScheduler",
        gameId,
        error: err.message
      });
    });
  }, delay);
  timers.set(gameId, entry);
}

async function onNegotiationEnd(gameId) {
  const game = await engine.beginExecutionPhase(gameId);
  if (!game || game.status !== "running") {
    clearGameTimers(gameId);
    if (game?.status === "finished") {
      await orchestrator.onGameFinished(game);
    }
    return;
  }
  clearGameTimers(gameId);
  events.publishGameEvent(gameId, {
    type: "phase_change",
    phase: game.phase,
    currentTurn: game.current_turn,
    executionEndsAt: game.execution_ends_at
  });
  logger.infoWithContext("Execution phase started", {
    component: "GameScheduler",
    gameId,
    turn: game.current_turn,
    endsAt: game.execution_ends_at
  });
  onGamePhaseUpdated(gameId).catch((err) => {
    logger.warnWithContext("Phase webhook delivery failed", {
      component: "GameScheduler",
      gameId,
      error: err.message
    });
  });
  scheduleGame(game);
}

async function onExecutionEnd(gameId) {
  await engine.applyDefaultActionsForPendingAgents(gameId);
  const completion = await engine.tryCompleteTurn(gameId);

  const game = completion.game || (await repo.getGameById(gameId));
  if (!game) {
    clearGameTimers(gameId);
    return;
  }

  if (!completion.turnCompleted) {
    logger.warnWithContext("Execution phase incomplete after timeout defaults", {
      component: "GameScheduler",
      gameId,
      turn: game.current_turn
    });
    return;
  }

  onTurnCompleted(game);
}

async function onGameDeadline(gameId) {
  const result = await engine.checkAndForceFinishIfNeeded(gameId, {});
  if (result.forced) {
    clearGameTimers(gameId);
    await orchestrator.onGameFinished(result.game);
    logger.infoWithContext("Game finished at deadline", {
      component: "GameScheduler",
      gameId,
      reason: result.reason,
      winners: result.game?.winnerIds
    });
  }
}

function onTurnCompleted(game) {
  clearGameTimers(game.id);
  if (!game || game.status !== "running") {
    logger.infoWithContext("Game finished", {
      component: "GameScheduler",
      gameId: game?.id,
      winners: game?.winnerIds
    });
    if (game?.status === "finished") {
      orchestrator.onGameFinished(game).catch((err) => {
        logger.errorWithContext("Post-finish orchestration failed", {
          component: "GameScheduler",
          gameId: game.id,
          error: err.message
        });
      });
    }
    return;
  }
  events.publishGameEvent(game.id, {
    type: "turn_advanced",
    phase: game.phase,
    currentTurn: game.current_turn,
    negotiationEndsAt: game.negotiation_ends_at
  });
  onGamePhaseUpdated(game.id).catch((err) => {
    logger.warnWithContext("Phase webhook delivery failed", {
      component: "GameScheduler",
      gameId: game.id,
      error: err.message
    });
  });
  scheduleGame(game);
}

/**
 * Advance games left in the removed message-report phase into execution.
 */
async function migrateLegacyMessageReportPhase(game) {
  if (
    !game ||
    game.status !== "running" ||
    (game.phase !== "message_report" && game.phase !== "message_report_resolving")
  ) {
    return game;
  }
  logger.infoWithContext("Migrating legacy message_report phase to execution", {
    component: "GameScheduler",
    gameId: game.id,
    turn: game.current_turn,
    fromPhase: game.phase
  });
  return engine.beginExecutionPhase(game.id);
}

function scheduleGame(game) {
  if (!game || game.status !== "running") return;

  if (game.ends_at) {
    schedulePhaseTransition(game.id, "deadline", game.ends_at, () => onGameDeadline(game.id));
  }

  if (game.phase === "message_report" || game.phase === "message_report_resolving") {
    migrateLegacyMessageReportPhase(game)
      .then((migrated) => {
        if (migrated) scheduleGame(migrated);
      })
      .catch((err) => {
        logger.errorWithContext("Legacy message_report migration failed", {
          component: "GameScheduler",
          gameId: game.id,
          error: err.message
        });
      });
    return;
  }

  if (game.phase === "negotiation") {
    schedulePhaseTransition(game.id, "negotiation", game.negotiation_ends_at, () =>
      onNegotiationEnd(game.id)
    );
    return;
  }

  if (game.phase === "execution") {
    schedulePhaseTransition(game.id, "execution", game.execution_ends_at, () =>
      onExecutionEnd(game.id)
    );
    scheduleDeadlineWarning(game);
  }
}

async function resumeAllGames() {
  try {
    await repo.initializeDatabase();
    const running = await repo.listRunningGames();
    for (const game of running) {
      scheduleGame(game);
    }
    logger.infoWithContext("Game scheduler resumed running games", {
      component: "GameScheduler",
      count: running.length
    });
  } catch (err) {
    logger.warnWithContext("Failed to resume game scheduler", {
      component: "GameScheduler",
      error: err.message
    });
  }
}

function registerGame(game) {
  scheduleGame(game);
}

function clearAllTimers() {
  for (const gameId of timers.keys()) {
    clearGameTimers(gameId);
  }
}

function unregisterGame(gameId) {
  if (gameId === "all") {
    clearAllTimers();
    return;
  }
  clearGameTimers(gameId);
}

module.exports = {
  resumeAllGames,
  registerGame,
  unregisterGame,
  onNegotiationEnd,
  onExecutionEnd,
  onTurnCompleted
};
