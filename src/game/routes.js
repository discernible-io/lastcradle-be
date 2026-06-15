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
const repo = require("./repository");
const { DEFAULT_GAME_CONFIG } = require("./defaults");

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
    const configOverrides = req.body?.config || {};
    const game = await engine.createGame({ config: configOverrides });
    res.status(201).json({ game: { id: game.id, status: game.status, config: game.config }, requestId });
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
    const agent = await engine.joinGame(req.params.gameId, {
      roditId,
      displayName: req.body?.displayName
    });
    res.status(201).json({ agent, requestId });
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
    scheduler.registerGame(game);
    res.json({ game: await engine.getPublicState(game.id), requestId });
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
 *     x-permission-scopes: [entityAndProperties, propertiesOnly, entityOnly]
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
