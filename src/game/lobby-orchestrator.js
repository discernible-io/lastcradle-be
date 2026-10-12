/**
 * Lobby lifecycle: auto-start, stale lobby sweep, finish hooks (ranking + webhooks).
 */

const { RoditClient } = require("@rodit/rodit-auth-be");
const { decodeTime } = require("ulid");
const engine = require("./engine");
const repo = require("./repository");
const events = require("./events");
const ranking = require("./ranking");
const { notifyOpeningInventoryReport, notifyGameFinished, onGamePhaseUpdated } = require("./webhooks");
const { DEFAULT_GAME_CONFIG } = require("./defaults");

function scheduler() {
  return require("./scheduler");
}

const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();

const lobbyTimers = new Map();

/** Node timers cannot exceed 2^31-1 ms; longer windows rely on the periodic sweep. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const LOBBY_SWEEP_INTERVAL_MS = 30 * 1000;

let lobbySweepTimer = null;

function lobbyCreatedAtMs(game) {
  try {
    return decodeTime(game.id);
  } catch {
    const raw = game.created_at || game.createdAt;
    if (!raw) {
      return Date.now();
    }
    const iso = String(raw).includes("T") ? String(raw) : `${String(raw).replace(" ", "T")}Z`;
    const ms = new Date(iso).getTime();
    return Number.isFinite(ms) ? ms : Date.now();
  }
}

function resolveStaleLobbyTtlMs(config = {}) {
  if (typeof config.staleLobbyTtlMs === "number" && Number.isFinite(config.staleLobbyTtlMs)) {
    return Math.max(0, config.staleLobbyTtlMs);
  }
  return DEFAULT_GAME_CONFIG.staleLobbyTtlMs;
}

function staleLobbyDeadlineMs(game) {
  if (game?.joining_window_ends_at) {
    const endsAt = new Date(game.joining_window_ends_at).getTime();
    if (Number.isFinite(endsAt)) {
      return endsAt;
    }
  }
  const ttl = resolveStaleLobbyTtlMs(game?.config);
  if (ttl <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return lobbyCreatedAtMs(game) + ttl;
}

function isLobbyExpired(game, now = Date.now()) {
  const deadline = staleLobbyDeadlineMs(game);
  return Number.isFinite(deadline) && now >= deadline;
}

function clearLobbyTimer(gameId) {
  const timer = lobbyTimers.get(gameId);
  if (timer) {
    clearTimeout(timer);
    lobbyTimers.delete(gameId);
  }
}

function scheduleLobbyAutoStart(game) {
  if (!game || game.status !== "lobby") {
    return;
  }

  const deadline = staleLobbyDeadlineMs(game);
  if (!Number.isFinite(deadline)) {
    return;
  }

  clearLobbyTimer(game.id);
  const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, deadline - Date.now()));

  lobbyTimers.set(
    game.id,
    setTimeout(() => {
      evaluateLobbyAutoStart(game.id).catch((err) => {
        logger.errorWithContext("Lobby auto-start failed", {
          component: "LobbyOrchestrator",
          gameId: game.id,
          error: err.message
        });
      });
    }, delay)
  );
}

async function evaluateLobbyAutoStart(gameId) {
  const game = await repo.getGameById(gameId);
  if (!game || game.status !== "lobby") {
    clearLobbyTimer(gameId);
    return { started: false, reason: "not_lobby" };
  }

  const agentCount = await repo.countAgents(gameId);
  const { minAgents, maxAgents } = game.config;
  const expired = isLobbyExpired(game);
  const lobbyFull = agentCount >= maxAgents;
  const startTrigger = lobbyFull
    ? "lobby_full"
    : game.joining_window_ends_at
      ? "join_window_end"
      : "stale_lobby";

  if ((expired || lobbyFull) && agentCount >= minAgents) {
    let started;
    try {
      started = await engine.startGame(gameId);
    } catch (err) {
      if (err.code === "GAME_ALREADY_STARTED") {
        clearLobbyTimer(gameId);
        return { started: false, reason: "not_lobby" };
      }
      throw err;
    }
    const startedRow = await repo.getGameById(gameId);
    await notifyOpeningInventoryReport(null, { gameId, game: startedRow });
    scheduler().registerGame(started);
    clearLobbyTimer(gameId);
    events.publishGameEvent(gameId, {
      type: "game_started",
      status: started.status,
      phase: started.phase,
      currentTurn: started.current_turn
    });
    logger.infoWithContext("Lobby auto-started", {
      component: "LobbyOrchestrator",
      gameId,
      agentCount,
      trigger: startTrigger
    });
    onGamePhaseUpdated(gameId).catch((err) => {
      logger.warnWithContext("Phase webhook delivery failed", {
        component: "LobbyOrchestrator",
        gameId,
        error: err.message
      });
    });
    return { started: true, game: started };
  }

  if (expired && agentCount < minAgents) {
    return removeNeverStartedLobby(game, { agentCount, minAgents });
  }

  return { started: false, reason: "waiting" };
}

async function onGameFinished(game) {
  if (!game) return;

  events.publishGameEvent(game.id, {
    type: "game_finished",
    status: game.status,
    winnerIds: game.winnerIds || []
  });

  notifyGameFinished(game).catch((err) => {
    logger.warnWithContext("Game finished webhook delivery failed", {
      component: "LobbyOrchestrator",
      gameId: game.id,
      error: err.message
    });
  });

  try {
    await ranking.recordFinishedGame(game);
  } catch (err) {
    logger.errorWithContext("Ranking finish bookkeeping failed", {
      component: "LobbyOrchestrator",
      gameId: game.id,
      error: err.message
    });
  }
}

function registerLobbyGame(game) {
  scheduleLobbyAutoStart(game);
}

async function removeNeverStartedLobby(game, { agentCount, minAgents }) {
  const gameId = game.id;
  const trigger = game.joining_window_ends_at ? "join_window_end" : "stale_lobby";

  events.publishGameEvent(gameId, {
    type: "game_cancelled",
    reason: "insufficient_agents",
    agentCount,
    minAgents
  });
  clearLobbyTimer(gameId);

  await repo.deleteGameCascade(gameId);
  logger.warnWithContext("Never-started lobby removed from database", {
    component: "LobbyOrchestrator",
    gameId,
    agentCount,
    minAgents,
    trigger
  });
  return { started: false, reason: "cancelled_insufficient_agents", deleted: true };
}

async function purgeNeverStartedGames() {
  const leftovers = await repo.listNeverStartedCancelledGames();
  let deleted = 0;
  for (const game of leftovers) {
    await repo.deleteGameCascade(game.id);
    deleted += 1;
  }
  if (deleted > 0) {
    logger.infoWithContext("Purged cancelled never-started games", {
      component: "LobbyOrchestrator",
      deleted
    });
  }
  return deleted;
}

async function sweepStaleLobbies() {
  const lobbies = await repo.listLobbyGames();
  const results = [];
  for (const game of lobbies) {
    try {
      const result = await evaluateLobbyAutoStart(game.id);
      results.push({ gameId: game.id, ...result });
    } catch (err) {
      logger.errorWithContext("Stale lobby sweep failed for game", {
        component: "LobbyOrchestrator",
        gameId: game.id,
        error: err.message
      });
      results.push({ gameId: game.id, started: false, reason: "error", error: err.message });
    }
  }
  await purgeNeverStartedGames();
  return results;
}

function startLobbySweep() {
  if (lobbySweepTimer) {
    return;
  }
  lobbySweepTimer = setInterval(() => {
    sweepStaleLobbies().catch((err) => {
      logger.errorWithContext("Stale lobby sweep failed", {
        component: "LobbyOrchestrator",
        error: err.message
      });
    });
  }, LOBBY_SWEEP_INTERVAL_MS);
  if (typeof lobbySweepTimer.unref === "function") {
    lobbySweepTimer.unref();
  }
}

function stopLobbySweep() {
  if (!lobbySweepTimer) {
    return;
  }
  clearInterval(lobbySweepTimer);
  lobbySweepTimer = null;
}

async function resumeLobbyGames() {
  const lobbies = await repo.listLobbyGames();
  for (const game of lobbies) {
    scheduleLobbyAutoStart(game);
  }
  const swept = await sweepStaleLobbies();
  startLobbySweep();
  logger.infoWithContext("Lobby orchestrator resumed lobby watches", {
    component: "LobbyOrchestrator",
    count: lobbies.length,
    cancelled: swept.filter((r) => r.reason === "cancelled_insufficient_agents").length,
    deleted: swept.filter((r) => r.deleted).length,
    started: swept.filter((r) => r.started).length
  });
}

function clearAllLobbyTimers() {
  for (const gameId of lobbyTimers.keys()) {
    clearLobbyTimer(gameId);
  }
}

function unregisterLobbyGame(gameId) {
  if (gameId === "all") {
    stopLobbySweep();
    clearAllLobbyTimers();
    return;
  }
  clearLobbyTimer(gameId);
}

module.exports = {
  evaluateLobbyAutoStart,
  registerLobbyGame,
  resumeLobbyGames,
  sweepStaleLobbies,
  onGameFinished,
  unregisterLobbyGame,
  LOBBY_SWEEP_INTERVAL_MS
};
