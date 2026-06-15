/**
 * Schedules automatic phase transitions for running games.
 */

const { RoditClient } = require("@rodit/rodit-auth-be");
const repo = require("./repository");
const engine = require("./engine");

const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();

const timers = new Map();

function clearGameTimers(gameId) {
  const existing = timers.get(gameId);
  if (!existing) return;
  if (existing.negotiation) clearTimeout(existing.negotiation);
  if (existing.execution) clearTimeout(existing.execution);
  timers.delete(gameId);
}

function schedulePhaseTransition(gameId, phase, endsAtIso, handler) {
  if (!endsAtIso) return;

  const endsAt = new Date(endsAtIso).getTime();
  const delay = Math.max(0, endsAt - Date.now());

  const entry = timers.get(gameId) || {};
  if (phase === "negotiation") {
    if (entry.negotiation) clearTimeout(entry.negotiation);
    entry.negotiation = setTimeout(async () => {
      try {
        await handler();
      } catch (err) {
        logger.errorWithContext("Negotiation phase transition failed", {
          component: "GameScheduler",
          gameId,
          error: err.message
        });
      }
    }, delay);
  } else if (phase === "execution") {
    if (entry.execution) clearTimeout(entry.execution);
    entry.execution = setTimeout(async () => {
      try {
        await handler();
      } catch (err) {
        logger.errorWithContext("Execution phase transition failed", {
          component: "GameScheduler",
          gameId,
          error: err.message
        });
      }
    }, delay);
  }
  timers.set(gameId, entry);
}

async function onNegotiationEnd(gameId) {
  const game = await engine.beginMessageReportPhase(gameId);
  if (!game || game.status !== "running") {
    clearGameTimers(gameId);
    return;
  }
  clearGameTimers(gameId);
  logger.infoWithContext("Message report phase started; awaiting all agent self-reports", {
    component: "GameScheduler",
    gameId,
    turn: game.current_turn
  });
}

function onTurnCompleted(game) {
  clearGameTimers(game.id);
  if (!game || game.status !== "running") {
    logger.infoWithContext("Game finished", {
      component: "GameScheduler",
      gameId: game?.id,
      winners: game?.winnerIds
    });
    return;
  }
  scheduleGame(game);
}

function scheduleGame(game) {
  if (!game || game.status !== "running") return;

  if (game.phase === "negotiation") {
    schedulePhaseTransition(game.id, "negotiation", game.negotiation_ends_at, () =>
      onNegotiationEnd(game.id)
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
  onTurnCompleted
};
