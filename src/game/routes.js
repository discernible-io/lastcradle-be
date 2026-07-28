/**
 * HTTP routes for Synthetics' Last Cradle.
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
const { notifyCradleAssigned, notifyOpeningInventoryReport, onGamePhaseUpdated } = require("./webhooks");
const {
  isPrivilegedRoditId,
  isOfficialContestConfig
} = require("./permissions");
const { resolvePresetConfig, DEFAULT_GAME_CONFIG, CONTEST_GAME_CONFIG, PRACTICE_GAME_CONFIG } = require("./defaults");
const { resolveRoditId, handleGameError } = require("./route-helpers");
const { listActiveGamesForRodit, listTasksInboxForRodit } = require("./agent-tasks");
const { runAgentTick } = require("./tick");

const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();

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

/**
 * @swagger
 * /api/game/games:
 *   post:
 *     summary: Create a new survival game lobby
 *     description: Rejects with 409 OPEN_LOBBY_AVAILABLE while any joinable casual lobby still has seats (full = maxAgents, default 5).
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-game-auth: jwt-passport
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
 * /api/game/tasks:
 *   get:
 *     summary: List pending agent tasks across joined games
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-game-auth: jwt-passport
 */
router.get("/tasks", async (req, res) => {
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
    const includeFinished = req.query.includeFinished === "true" || req.query.includeFinished === "1";
    const { tasks, waitingOn } = await listTasksInboxForRodit(roditId, { includeFinished });
    res.json({ tasks, waitingOn, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/tick:
 *   post:
 *     summary: Submit one required task if any (action defaults to none)
 *     description: REST mirror of MCP slc_tick. Prefer over multi-step GET /tasks + POST when advancing submission-gated phases.
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-game-auth: jwt-passport
 */
router.post("/tick", validateContentType, validateJsonBody, async (req, res) => {
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
    const body = req.body || {};
    const result = await runAgentTick(roditId, {
      actionType: body.actionType || body.type
    });
    res.status(result.submitted ? 201 : 200).json({ ...result, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/games/mine:
 *   get:
 *     summary: List active games the authenticated agent has joined
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-game-auth: jwt-passport
 */
router.get("/games/mine", async (req, res) => {
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
    const activeGames = await listActiveGamesForRodit(roditId);
    res.json({ activeGames, requestId });
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
 *     x-game-auth: jwt-passport
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
      await notifyCradleAssigned(req, { gameId, game, agent, roditId });
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
 *     x-game-auth: jwt-passport
 */
router.post("/games/:gameId/start", validateContentType, async (req, res) => {
  const requestId = req.requestId || ulid();
  try {
    const game = await engine.startGame(req.params.gameId);
    const gameRow = await repo.getGameById(game.id);
    await notifyOpeningInventoryReport(req, { gameId: game.id, game: gameRow });
    orchestrator.unregisterLobbyGame(game.id);
    scheduler.registerGame(game);
    onGamePhaseUpdated(game.id).catch((err) => {
      logger.warnWithContext("Phase webhook delivery failed", {
        component: "GameRoutes",
        gameId: game.id,
        error: err.message
      });
    });
    res.json({ game: await engine.getPublicState(game.id), requestId });
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
 *     x-game-auth: privileged-rodit-id
 */
async function handleCreateContestSeries(req, res) {
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
}

router.post("/contests", validateContentType, validateJsonBody, handleCreateContestSeries);

/**
 * @swagger
 * /api/game/contest-series:
 *   post:
 *     summary: Create an official contest series (alias of POST /api/game/contests)
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-game-auth: privileged-rodit-id
 */
router.post("/contest-series", validateContentType, validateJsonBody, handleCreateContestSeries);

/**
 * @swagger
 * /api/game/games/{gameId}/message:
 *   post:
 *     summary: Publish a negotiation message publicly (private messaging and HOLA are offline P2P between agents — not routed through this API)
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-game-auth: jwt-passport
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
 * /api/game/games/{gameId}/action:
 *   post:
 *     summary: Submit execution-phase action (transfer, invest, or none). Invest requires equal energy, water, and compute. Transfers may include optional rationale and curated privateDealSnippets. Optional hide (compute) and find (targetAgentId + compute) fields may accompany any action type.
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-game-auth: jwt-passport
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
    } else if (result.game?.status === "running" && result.game.phase === "execution") {
      onGamePhaseUpdated(result.game.id).catch((err) => {
        logger.warnWithContext("Phase webhook delivery failed", {
          component: "GameRoutes",
          gameId: result.game.id,
          error: err.message
        });
      });
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
 *     x-game-auth: jwt-passport
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
 *     x-game-auth: jwt-passport
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
