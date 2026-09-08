/**
 * Contest series orchestration: practice week scheduling, lobby auto-start, prize hooks.
 */

const { RoditClient } = require("@rodit/rodit-auth-be");
const { ulid, decodeTime } = require("ulid");
const engine = require("./engine");
const repo = require("./repository");
const events = require("./events");
const prizeSettlement = require("./prize-settlement");
const { notifyOpeningInventoryReport, notifyGameFinished, onGamePhaseUpdated } = require("./webhooks");
const {
  DEFAULT_GAME_CONFIG,
  CONTEST_GAME_CONFIG,
  PRACTICE_GAME_CONFIG,
  mergeGameConfig
} = require("./defaults");

function scheduler() {
  return require("./scheduler");
}

const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();

const lobbyTimers = new Map();

const PRACTICE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
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
          component: "ContestOrchestrator",
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
    await syncContestStatusForGame(started);
    logger.infoWithContext("Lobby auto-started", {
      component: "ContestOrchestrator",
      gameId,
      agentCount,
      trigger: startTrigger
    });
    onGamePhaseUpdated(gameId).catch((err) => {
      logger.warnWithContext("Phase webhook delivery failed", {
        component: "ContestOrchestrator",
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

async function syncContestStatusForGame(game) {
  if (!game) return null;

  const contest = await repo.getContestByGameId(game.id);
  if (!contest) return null;

  let status = contest.status;
  const isPractice = game.id === contest.practiceGameId;
  const isDefinitive = game.id === contest.definitiveGameId;

  if (isPractice) {
    if (game.status === "lobby") status = "practice_lobby";
    else if (game.status === "running") status = "practice_running";
    else if (game.status === "finished" || game.status === "cancelled") {
      status = "practice_complete";
    }
  }

  if (isDefinitive) {
    if (game.status === "lobby") status = "definitive_lobby";
    else if (game.status === "running") status = "definitive_running";
    else if (game.status === "finished") status = "finished";
    else if (game.status === "cancelled") status = "cancelled";
  }

  if (status !== contest.status) {
    await repo.updateContest(contest.id, { status, updatedAt: new Date().toISOString() });
  }
  return status;
}

async function onGameFinished(game) {
  if (!game) return;

  events.publishGameEvent(game.id, {
    type: "game_finished",
    status: game.status,
    winnerIds: game.winnerIds || [],
    contestMode: game.config?.contestMode ?? null
  });

  notifyGameFinished(game).catch((err) => {
    logger.warnWithContext("Game finished webhook delivery failed", {
      component: "ContestOrchestrator",
      gameId: game.id,
      error: err.message
    });
  });

  try {
    const season = require("./season");
    await season.recordFinishedGame(game);
  } catch (err) {
    logger.errorWithContext("Season finish bookkeeping failed", {
      component: "ContestOrchestrator",
      gameId: game.id,
      error: err.message
    });
  }

  const contest = await repo.getContestByGameId(game.id);
  if (!contest) return;

  await syncContestStatusForGame(game);

  if (game.id === contest.definitiveGameId && game.config?.contestMode === "definitive") {
    const result = await prizeSettlement.settleContestPrize(contest.id, game);
    events.publishGameEvent(game.id, {
      type: "prize_settlement",
      contestId: contest.id,
      ...result
    });
  }
}

function registerLobbyGame(game) {
  scheduleLobbyAutoStart(game);
}

async function removeNeverStartedLobby(game, { agentCount, minAgents }) {
  const gameId = game.id;
  const trigger = game.joining_window_ends_at ? "join_window_end" : "stale_lobby";
  const contest = await repo.getContestByGameId(gameId);

  events.publishGameEvent(gameId, {
    type: "game_cancelled",
    reason: "insufficient_agents",
    agentCount,
    minAgents
  });
  clearLobbyTimer(gameId);

  if (contest) {
    await repo.updateGame(gameId, { status: "cancelled" });
    await syncContestStatusForGame(await repo.getGameById(gameId));
    logger.warnWithContext("Lobby cancelled — never started (contest row kept)", {
      component: "ContestOrchestrator",
      gameId,
      agentCount,
      minAgents,
      trigger
    });
    return { started: false, reason: "cancelled_insufficient_agents", deleted: false };
  }

  await repo.deleteGameCascade(gameId);
  logger.warnWithContext("Never-started lobby removed from database", {
    component: "ContestOrchestrator",
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
    const contest = await repo.getContestByGameId(game.id);
    if (contest) {
      continue;
    }
    await repo.deleteGameCascade(game.id);
    deleted += 1;
  }
  if (deleted > 0) {
    logger.infoWithContext("Purged cancelled never-started games", {
      component: "ContestOrchestrator",
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
        component: "ContestOrchestrator",
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
        component: "ContestOrchestrator",
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
  logger.infoWithContext("Contest orchestrator resumed lobby watches", {
    component: "ContestOrchestrator",
    count: lobbies.length,
    cancelled: swept.filter((r) => r.reason === "cancelled_insufficient_agents").length,
    deleted: swept.filter((r) => r.deleted).length,
    started: swept.filter((r) => r.started).length
  });
}

async function createContestSeries({
  practiceStartsAt,
  practiceWindowMs = PRACTICE_WEEK_MS,
  definitiveJoiningStartsAt = null,
  prizeAmountYoctoNear = null,
  configOverrides = {}
} = {}) {
  if (!practiceStartsAt) {
    throw engine.gameError(
      "PRACTICE_START_REQUIRED",
      "practiceStartsAt is required (ISO timestamp)",
      400
    );
  }

  const practiceStart = new Date(practiceStartsAt);
  if (Number.isNaN(practiceStart.getTime())) {
    throw engine.gameError("INVALID_PRACTICE_START", "practiceStartsAt must be a valid ISO timestamp", 400);
  }

  const practiceEnd = new Date(practiceStart.getTime() + practiceWindowMs);
  const definitiveStart = definitiveJoiningStartsAt
    ? new Date(definitiveJoiningStartsAt)
    : practiceEnd;
  if (Number.isNaN(definitiveStart.getTime())) {
    throw engine.gameError(
      "INVALID_DEFINITIVE_START",
      "definitiveJoiningStartsAt must be a valid ISO timestamp",
      400
    );
  }

  const contestId = ulid();
  const sharedOverrides = { ...configOverrides, contestSeriesId: contestId };

  // Reserve both practice + definitive slots up front so the series cannot
  // partially create when the host is one game under the simultaneous cap.
  await engine.assertSimultaneousGameCapacity({ slotsNeeded: 2 });

  const practiceGame = await engine.createGame({
    config: mergeGameConfig({
      ...PRACTICE_GAME_CONFIG,
      ...sharedOverrides,
      joiningWindowDurationMs: practiceWindowMs
    }),
    joiningWindowStartsAt: practiceStart.toISOString(),
    bypassSimultaneousCap: true
  });

  const definitiveConfig = mergeGameConfig({
    ...CONTEST_GAME_CONFIG,
    ...sharedOverrides,
    joiningWindowDurationMs:
      configOverrides.joiningWindowDurationMs ?? CONTEST_GAME_CONFIG.joiningWindowDurationMs
  });
  const definitiveGame = await engine.createGame({
    config: definitiveConfig,
    joiningWindowStartsAt: definitiveStart.toISOString(),
    bypassSimultaneousCap: true
  });

  const contest = await repo.createContest({
    status: "scheduled",
    practiceGameId: practiceGame.id,
    definitiveGameId: definitiveGame.id,
    practiceWindowStartsAt: practiceStart.toISOString(),
    practiceWindowEndsAt: practiceEnd.toISOString(),
    definitiveJoiningStartsAt: definitiveStart.toISOString(),
    prizeAmountYocto: prizeAmountYoctoNear,
    prizeStatus: prizeAmountYoctoNear ? "pending" : null
  });

  registerLobbyGame(practiceGame);
  registerLobbyGame(definitiveGame);

  logger.infoWithContext("Contest series created", {
    component: "ContestOrchestrator",
    contestId: contest.id,
    practiceGameId: practiceGame.id,
    definitiveGameId: definitiveGame.id,
    practiceStartsAt: practiceStart.toISOString(),
    definitiveJoiningStartsAt: definitiveStart.toISOString()
  });

  return { contest, practiceGame, definitiveGame };
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
  createContestSeries,
  evaluateLobbyAutoStart,
  registerLobbyGame,
  resumeLobbyGames,
  sweepStaleLobbies,
  onGameFinished,
  syncContestStatusForGame,
  unregisterLobbyGame,
  PRACTICE_WEEK_MS,
  LOBBY_SWEEP_INTERVAL_MS
};
