/**
 * HTTP routes for the Resource Negotiation Survival Game.
 */

const express = require("express");
const router = express.Router();
const { ulid } = require("ulid");
const { RoditClient, errorResponse } = require("@rodit/rodit-auth-be");
const { sendError } = errorResponse;
const { validateContentType, validateJsonBody } = require("../middleware/requestvalidationmw");
const engine = require("./engine");
const scheduler = require("./scheduler");
const orchestrator = require("./contest-orchestrator");
const repo = require("./repository");
const events = require("./events");
const { notifyTerritoryAssigned } = require("./webhooks");
const {
  isPrivilegedRoditId,
  isOfficialContestConfig
} = require("./permissions");
const {
  DEFAULT_GAME_CONFIG,
  CONTEST_GAME_CONFIG,
  PRACTICE_GAME_CONFIG,
  mergeGameConfig
} = require("./defaults");

const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();

function resolveRoditId(req) {
  return req.user?.roditId || req.user?.sub || req.user?.id || null;
}

function handleGameError(res, err, requestId) {
  return sendError(res, {
    statusCode: err.statusCode || 500,
    requestId,
    code: err.code || "GAME_ERROR",
    message: err.message,
    details: err.details || undefined
  });
}

function denyUnlessPrivileged(req, res, requestId) {
  if (isPrivilegedRoditId(req)) {
    return true;
  }
  sendError(res, {
    statusCode: 403,
    requestId,
    code: "FORBIDDEN",
    message: "Privileged RODiT identity required for this operation"
  });
  return false;
}

function resolvePresetConfig(body = {}) {
  const preset = body.preset;
  if (preset === "contest" || preset === "definitive") {
    return { ...CONTEST_GAME_CONFIG, ...(body.config || {}) };
  }
  if (preset === "practice") {
    return { ...PRACTICE_GAME_CONFIG, ...(body.config || {}) };
  }
  return body.config || {};
}

function summarizeGame(game, agentCount = null) {
  return {
    id: game.id,
    status: game.status,
    contestMode: game.config?.contestMode ?? null,
    contestSeriesId: game.config?.contestSeriesId ?? null,
    agentCount,
    joiningWindow: engine.joiningWindowDetails(game),
    currentTurn: game.current_turn,
    phase: game.phase,
    startedAt: game.started_at,
    finishedAt: game.finished_at,
    winnerIds: game.winnerIds || [],
    createdAt: game.created_at
  };
}

/**
 * @swagger
 * /api/game/games:
 *   get:
 *     summary: List survival games (filter by status or contest mode)
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-permission-scopes: [entityAndProperties, propertiesOnly, entityOnly]
 */
router.get("/games", async (req, res) => {
  const requestId = req.requestId || ulid();
  try {
    const status = req.query.status || null;
    const contestMode = req.query.contestMode || null;
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;
    const games = await repo.listGames({ status, contestMode, limit, offset });
    const summaries = [];
    for (const game of games) {
      const agentCount = await repo.countAgents(game.id);
      summaries.push(summarizeGame(game, agentCount));
    }
    res.json({ games: summaries, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/games:
 *   post:
 *     summary: Create a new survival game lobby
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-permission-scopes: [entityAndProperties, propertiesOnly, entityOnly]
 */
router.post("/games", validateContentType, validateJsonBody, async (req, res) => {
  const requestId = req.requestId || ulid();
  try {
    const configOverrides = resolvePresetConfig(req.body);
    if (isOfficialContestConfig(configOverrides) && !denyUnlessPrivileged(req, res, requestId)) {
      return;
    }

    const joiningWindowStartsAt = req.body?.joiningWindowStartsAt ?? null;
    const game = await engine.createGame({ config: configOverrides, joiningWindowStartsAt });
    orchestrator.registerLobbyGame(game);
    res.status(201).json({
      game: {
        id: game.id,
        status: game.status,
        config: game.config,
        joiningWindow: engine.joiningWindowDetails(game)
      },
      requestId
    });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/games/{gameId}/join:
 *   post:
 *     summary: Join a game lobby as an agent
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-permission-scopes: [entityAndProperties, propertiesOnly, entityOnly]
 */
router.post("/games/:gameId/join", validateContentType, validateJsonBody, async (req, res) => {
  const requestId = req.requestId || ulid();
  const roditId = resolveRoditId(req);
  if (!roditId) {
    return sendError(res, {
      statusCode: 401,
      requestId,
      code: "AUTH_REQUIRED",
      message: "Authenticated agent identity required"
    });
  }

  try {
    const { gameId } = req.params;
    const existing = await repo.getAgentByRoditId(gameId, roditId);
    const agent = await engine.joinGame(gameId, {
      roditId,
      displayName: req.body?.displayName
    });

    if (!existing) {
      const game = await repo.getGameById(gameId);
      await notifyTerritoryAssigned(req, { gameId, game, agent, roditId });
    }

    const autoStart = await orchestrator.evaluateLobbyAutoStart(gameId);
    res.status(201).json({ agent, autoStart, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/games/{gameId}/start:
 *   post:
 *     summary: Start the game when enough agents have joined
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-permission-scopes: [entityAndProperties, propertiesOnly, entityOnly]
 */
router.post("/games/:gameId/start", validateContentType, async (req, res) => {
  const requestId = req.requestId || ulid();
  try {
    const game = await engine.startGame(req.params.gameId);
    orchestrator.unregisterLobbyGame(game.id);
    scheduler.registerGame(game);
    res.json({ game: await engine.getPublicState(game.id), requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/games/{gameId}/events:
 *   get:
 *     summary: Server-sent events stream for live game updates
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-permission-scopes: [entityAndProperties, propertiesOnly, entityOnly]
 */
router.get("/games/:gameId/events", async (req, res) => {
  const requestId = req.requestId || ulid();
  const { gameId } = req.params;

  try {
    const game = await repo.getGameById(gameId);
    if (!game) {
      return sendError(res, { statusCode: 404, requestId, code: "GAME_NOT_FOUND", message: "Game not found" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    const writeEvent = (payload) => {
      res.write(`event: ${payload.type}\ndata: ${JSON.stringify({ ...payload, requestId })}\n\n`);
    };

    writeEvent({
      type: "connected",
      gameId,
      status: game.status,
      phase: game.phase,
      currentTurn: game.current_turn
    });

    const unsubscribe = events.subscribeGameEvents(gameId, writeEvent);
    const heartbeat = setInterval(() => {
      res.write(`: ping ${Date.now()}\n\n`);
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/contests:
 *   get:
 *     summary: List scheduled contest series (practice + definitive games)
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-permission-scopes: [entityAndProperties, propertiesOnly, entityOnly]
 */
router.get("/contests", async (req, res) => {
  const requestId = req.requestId || ulid();
  try {
    const status = req.query.status || null;
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;
    const contests = await repo.listContests({ status, limit, offset });
    res.json({ contests, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/contests:
 *   post:
 *     summary: Create an official contest series (practice week + definitive prize game)
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 */
router.post("/contests", validateContentType, validateJsonBody, async (req, res) => {
  const requestId = req.requestId || ulid();
  if (!denyUnlessPrivileged(req, res, requestId)) {
    return;
  }

  try {
    const result = await orchestrator.createContestSeries({
      practiceStartsAt: req.body?.practiceStartsAt,
      practiceWindowMs: req.body?.practiceWindowMs,
      definitiveJoiningStartsAt: req.body?.definitiveJoiningStartsAt,
      prizeAmountYoctoNear: req.body?.prizeAmountYoctoNear,
      configOverrides: req.body?.config || {}
    });
    res.status(201).json({ ...result, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/games/{gameId}/state:
 *   get:
 *     summary: Get public game state
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 */
router.get("/games/:gameId/state", async (req, res) => {
  const requestId = req.requestId || ulid();
  try {
    const roditId = resolveRoditId(req);
    let viewerAgentId = null;
    if (roditId) {
      const viewer = await repo.getAgentByRoditId(req.params.gameId, roditId);
      viewerAgentId = viewer?.id ?? null;
    }
    const state = await engine.getPublicState(req.params.gameId, { viewerAgentId });
    res.json({ ...state, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/games/{gameId}/message:
 *   post:
 *     summary: Publish a negotiation message publicly (offline messaging is not routed through the API)
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-permission-scopes: [entityAndProperties, propertiesOnly, entityOnly]
 */
router.post("/games/:gameId/message", validateContentType, validateJsonBody, async (req, res) => {
  const requestId = req.requestId || ulid();
  const roditId = resolveRoditId(req);
  if (!roditId) {
    return sendError(res, { statusCode: 401, requestId, code: "AUTH_REQUIRED", message: "Authentication required" });
  }

  const { body } = req.body || {};
  if (!body || typeof body !== "string" || !body.trim()) {
    return sendError(res, {
      statusCode: 400,
      requestId,
      code: "MESSAGE_BODY_REQUIRED",
      message: "Message body is required"
    });
  }

  try {
    const agent = await repo.getAgentByRoditId(req.params.gameId, roditId);
    if (!agent) {
      return sendError(res, {
        statusCode: 404,
        requestId,
        code: "AGENT_NOT_IN_GAME",
        message: "You must join the game before publishing a message"
      });
    }
    const result = await engine.publishPublicMessage(req.params.gameId, agent.id, { body });
    res.status(201).json({ ...result, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/games/{gameId}/messages:
 *   get:
 *     summary: List public negotiation messages for the current turn
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-permission-scopes: [entityAndProperties, propertiesOnly, entityOnly]
 */
router.get("/games/:gameId/messages", async (req, res) => {
  const requestId = req.requestId || ulid();

  try {
    const game = await repo.getGameById(req.params.gameId);
    if (!game) {
      return sendError(res, { statusCode: 404, requestId, code: "GAME_NOT_FOUND", message: "Game not found" });
    }

    const turnNumber = Number(req.query.turn) || game.current_turn || 0;
    const messages = await repo.listPublicMessages(req.params.gameId, turnNumber);

    res.json({ messages, turnNumber, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/games/{gameId}/message-report:
 *   post:
 *     summary: Self-report sent/received message counts at end of negotiation
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-permission-scopes: [entityAndProperties, propertiesOnly, entityOnly]
 */
router.post("/games/:gameId/message-report", validateContentType, validateJsonBody, async (req, res) => {
  const requestId = req.requestId || ulid();
  const roditId = resolveRoditId(req);
  if (!roditId) {
    return sendError(res, { statusCode: 401, requestId, code: "AUTH_REQUIRED", message: "Authentication required" });
  }

  const { sent, received } = req.body || {};
  if (sent === undefined || received === undefined) {
    return sendError(res, {
      statusCode: 400,
      requestId,
      code: "MESSAGE_REPORT_REQUIRED",
      message: "Both sent and received counts are required"
    });
  }

  try {
    const agent = await repo.getAgentByRoditId(req.params.gameId, roditId);
    if (!agent) {
      return sendError(res, {
        statusCode: 404,
        requestId,
        code: "AGENT_NOT_IN_GAME",
        message: "You must join the game before submitting a message report"
      });
    }
    const result = await engine.submitMessageReport(req.params.gameId, agent.id, { sent, received });
    if (result.messageReportPhaseCompleted) {
      const game = await repo.getGameById(req.params.gameId);
      if (game?.status === "running" && game.phase === "execution") {
        scheduler.registerGame(game);
      }
    }
    res.status(201).json({ ...result, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/games/{gameId}/action:
 *   post:
 *     summary: Submit execution-phase action (transfer, invest, or none). Invest requires equal energy, water, and compute. Optional hide (compute) and find (targetAgentId + compute) fields may accompany any action type.
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-permission-scopes: [entityAndProperties, propertiesOnly, entityOnly]
 */
router.post("/games/:gameId/action", validateContentType, validateJsonBody, async (req, res) => {
  const requestId = req.requestId || ulid();
  const roditId = resolveRoditId(req);
  if (!roditId) {
    return sendError(res, { statusCode: 401, requestId, code: "AUTH_REQUIRED", message: "Authentication required" });
  }

  try {
    const agent = await repo.getAgentByRoditId(req.params.gameId, roditId);
    if (!agent) {
      return sendError(res, {
        statusCode: 404,
        requestId,
        code: "AGENT_NOT_IN_GAME",
        message: "You must join the game before submitting actions"
      });
    }
    const result = await engine.submitAction(req.params.gameId, agent.id, req.body);
    if (result.turnCompleted && result.game) {
      scheduler.onTurnCompleted(result.game);
    }
    res.status(201).json({ ...result, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/defaults:
 *   get:
 *     summary: Get default game configuration parameters
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-permission-scopes: [entityAndProperties, propertiesOnly, entityOnly]
 */
router.get("/defaults", (req, res) => {
  res.json({ defaults: DEFAULT_GAME_CONFIG, requestId: req.requestId || ulid() });
});

/**
 * @swagger
 * /api/game/defaults/contest:
 *   get:
 *     summary: Get contest and practice game configuration presets
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-permission-scopes: [entityAndProperties, propertiesOnly, entityOnly]
 */
router.get("/defaults/contest", (req, res) => {
  res.json({
    definitive: CONTEST_GAME_CONFIG,
    practice: PRACTICE_GAME_CONFIG,
    requestId: req.requestId || ulid()
  });
});

router.use((req, res) => {
  const requestId = req.requestId || ulid();
  return sendError(res, {
    statusCode: 404,
    requestId,
    code: "ENDPOINT_NOT_FOUND",
    message: `Cannot ${req.method} ${req.path}`
  });
});

repo.initializeDatabase().catch((err) => {
  logger.errorWithContext("Game database initialization failed", {
    component: "GameRoutes",
    error: err.message
  });
});

module.exports = router;
