/**
 * Schedules automatic phase transitions for running games.
 */

const { RoditClient } = require("@rodit/rodit-auth-be");
const repo = require("./repository");
const engine = require("./engine");
const events = require("./events");
const orchestrator = require("./contest-orchestrator");

const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();

const timers = new Map();

function clearGameTimers(gameId) {
  const existing = timers.get(gameId);
  if (!existing) return;
  for (const key of ["negotiation", "messageReport", "execution", "deadline"]) {
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

async function onNegotiationEnd(gameId) {
  const game = await engine.beginMessageReportPhase(gameId);
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
    messageReportEndsAt: game.message_report_ends_at
  });
  logger.infoWithContext("Message report phase started", {
    component: "GameScheduler",
    gameId,
    turn: game.current_turn,
    endsAt: game.message_report_ends_at
  });
  scheduleGame(game);
}

async function onMessageReportEnd(gameId) {
  await engine.applyDefaultMessageReportsForPendingAgents(gameId);
  const completion = await engine.tryCompleteMessageReportPhase(gameId);

  const game = await repo.getGameById(gameId);
  if (!game || game.status !== "running") {
    clearGameTimers(gameId);
    return;
  }

  if (!completion.messageReportPhaseCompleted) {
    logger.warnWithContext("Message report phase incomplete after timeout defaults", {
      component: "GameScheduler",
      gameId,
      turn: game.current_turn
    });
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
  scheduleGame(game);
}

function scheduleGame(game) {
  if (!game || game.status !== "running") return;

  if (game.ends_at) {
    schedulePhaseTransition(game.id, "deadline", game.ends_at, () => onGameDeadline(game.id));
  }

  if (game.phase === "negotiation") {
    schedulePhaseTransition(game.id, "negotiation", game.negotiation_ends_at, () =>
      onNegotiationEnd(game.id)
    );
    return;
  }

  if (game.phase === "message_report") {
    schedulePhaseTransition(game.id, "messageReport", game.message_report_ends_at, () =>
      onMessageReportEnd(game.id)
    );
    return;
  }

  if (game.phase === "execution") {
    schedulePhaseTransition(game.id, "execution", game.execution_ends_at, () =>
      onExecutionEnd(game.id)
    );
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
  onMessageReportEnd,
  onExecutionEnd,
  onTurnCompleted
};
