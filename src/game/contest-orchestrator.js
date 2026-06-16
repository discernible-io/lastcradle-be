/**
 * Contest series orchestration: practice week scheduling, lobby auto-start, prize hooks.
 */

const { RoditClient } = require("@rodit/rodit-auth-be");
const { ulid } = require("ulid");
const engine = require("./engine");
const repo = require("./repository");
const events = require("./events");
const prizeSettlement = require("./prize-settlement");
const { CONTEST_GAME_CONFIG, PRACTICE_GAME_CONFIG, mergeGameConfig } = require("./defaults");

function scheduler() {
  return require("./scheduler");
}

const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();

const lobbyTimers = new Map();

const PRACTICE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function clearLobbyTimer(gameId) {
  const timer = lobbyTimers.get(gameId);
  if (timer) {
    clearTimeout(timer);
    lobbyTimers.delete(gameId);
  }
}

function scheduleLobbyAutoStart(game) {
  if (!game || game.status !== "lobby" || !game.joining_window_ends_at) {
    return;
  }

  clearLobbyTimer(game.id);
  const endsAt = new Date(game.joining_window_ends_at).getTime();
  const delay = Math.max(0, endsAt - Date.now());

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
  const now = Date.now();
  const windowEnded =
    game.joining_window_ends_at && now >= new Date(game.joining_window_ends_at).getTime();
  const lobbyFull = agentCount >= maxAgents;

  if ((windowEnded || lobbyFull) && agentCount >= minAgents) {
    const started = await engine.startGame(gameId);
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
      trigger: lobbyFull ? "lobby_full" : "join_window_end"
    });
    return { started: true, game: started };
  }

  if (windowEnded && agentCount < minAgents) {
    await repo.updateGame(gameId, { status: "cancelled" });
    clearLobbyTimer(gameId);
    events.publishGameEvent(gameId, {
      type: "game_cancelled",
      reason: "insufficient_agents",
      agentCount,
      minAgents
    });
    await syncContestStatusForGame(await repo.getGameById(gameId));
    logger.warnWithContext("Lobby cancelled — insufficient agents at window end", {
      component: "ContestOrchestrator",
      gameId,
      agentCount,
      minAgents
    });
    return { started: false, reason: "cancelled_insufficient_agents" };
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

async function resumeLobbyGames() {
  const lobbies = await repo.listLobbyGames();
  for (const game of lobbies) {
    scheduleLobbyAutoStart(game);
    await evaluateLobbyAutoStart(game.id);
  }
  logger.infoWithContext("Contest orchestrator resumed lobby watches", {
    component: "ContestOrchestrator",
    count: lobbies.length
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

  const practiceGame = await engine.createGame({
    config: mergeGameConfig({
      ...PRACTICE_GAME_CONFIG,
      ...sharedOverrides,
      joiningWindowDurationMs: practiceWindowMs
    }),
    joiningWindowStartsAt: practiceStart.toISOString()
  });

  const definitiveConfig = mergeGameConfig({
    ...CONTEST_GAME_CONFIG,
    ...sharedOverrides,
    joiningWindowDurationMs:
      configOverrides.joiningWindowDurationMs ?? CONTEST_GAME_CONFIG.joiningWindowDurationMs
  });
  const definitiveGame = await engine.createGame({
    config: definitiveConfig,
    joiningWindowStartsAt: definitiveStart.toISOString()
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
  onGameFinished,
  syncContestStatusForGame,
  unregisterLobbyGame,
  PRACTICE_WEEK_MS
};
