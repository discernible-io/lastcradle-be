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
const {
  resolvePresetConfig,
  DEFAULT_GAME_CONFIG,
  CONTEST_GAME_CONFIG,
  PRACTICE_GAME_CONFIG,
  QUALIFYING_GAME_CONFIG,
  MAX_SIMULTANEOUS_GAMES,
  publicGameConfig
} = require("./defaults");
const { resolveRoditId, handleGameError } = require("./route-helpers");
const season = require("./season");
const { listActiveGamesForRodit, listTasksInboxForRodit, listTickContextForRodit } = require("./agent-tasks");
const { runAgentTick } = require("./tick");
const { assertPassportIpLoginMethod } = require("./ip-login-method");
const { AGENT_TYPES } = require("./agent-profile");
const { LLM_MODEL_MAX_LEN } = require("./input-limits");
const funnel = require("../lib/funnel");

const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();

function trackFunnelPlay(req, { tokenId, path, result, errorCode, requestId, extra }) {
  const baseExtra = extra && typeof extra === "object" ? { ...extra } : {};
  if (!baseExtra.joinMethod) {
    baseExtra.joinMethod = funnel.joinMethodFromTokenId(tokenId);
  }
  funnel.track(funnel.EVENTS.PLAY, {
    step: funnel.STEPS.PLAY,
    domain: funnel.DEFAULT_DOMAIN,
    path,
    result,
    errorCode: errorCode || null,
    tokenId,
    requestId,
    req,
    extra: baseExtra
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

/**
 * @swagger
 * /api/game/games:
 *   post:
 *     summary: Create a new survival game lobby
 *     description: Defaults to auto-joining the creator (set autoJoin false for a host-only lobby). Rejects with 409 OPEN_LOBBY_AVAILABLE while any joinable casual lobby still has seats (full = maxAgents, default 15). Rejects with 409 TOO_MANY_ACTIVE_GAMES when lobby/running count would exceed GAME_MAX_SIMULTANEOUS_GAMES (see GET /api/game/defaults maxSimultaneousGames).
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

    const autoJoin = req.body?.autoJoin !== false;
    const roditId = resolveRoditId(req);
    if (autoJoin && !roditId) {
      return sendError(res, {
        statusCode: 401,
        requestId,
        code: "AUTH_REQUIRED",
        message: "Authenticated agent identity required"
      });
    }

    const joiningWindowStartsAt = req.body?.joiningWindowStartsAt ?? null;
    const game = await engine.createGame({ config: configOverrides, joiningWindowStartsAt });
    orchestrator.registerLobbyGame(game);

    const gamePayload = {
      id: game.id,
      status: game.status,
      config: publicGameConfig(game.config),
      joiningWindow: engine.joiningWindowDetails(game)
    };

    if (!autoJoin) {
      return res.status(201).json({
        game: gamePayload,
        agent: null,
        autoStart: null,
        requestId
      });
    }

    await assertPassportIpLoginMethod(req, game.id, roditId);
    let agent;
    try {
      agent = await engine.joinGame(game.id, {
        roditId,
        displayName: req.body?.displayName,
        agentType: req.body?.agentType,
        llmModel: req.body?.llmModel
      });
      // First seat for create+autoJoin; no cross-game dedupe (emit per successful new seat).
      trackFunnelPlay(req, {
        tokenId: roditId,
        path: "/api/game/games",
        result: "success",
        requestId,
        extra: { gameId: game.id }
      });
    } catch (joinErr) {
      trackFunnelPlay(req, {
        tokenId: roditId,
        path: "/api/game/games",
        result: "failed",
        errorCode: joinErr.code || joinErr.statusCode || "JOIN_FAILED",
        requestId,
        extra: { gameId: game.id }
      });
      throw joinErr;
    }
    await notifyCradleAssigned(req, { gameId: game.id, game, agent, roditId });
    const autoStart = await orchestrator.evaluateLobbyAutoStart(game.id);

    res.status(201).json({
      game: gamePayload,
      agent,
      autoStart,
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
 * /api/game/tick-context:
 *   get:
 *     summary: Isolated-tick diet — tasks plus compact per-game execute context
 *     description: >
 *       One Bearer GET for companion crons and `/hooks/agent`. Returns tasks + waitingOn
 *       plus slim contexts (you/inventory/actionHints/last-turn inbound/living peer ids,
 *       no skill/lore/full state dump). Isolated ticks should project then submit from this
 *       payload — do not re-fetch skill.md. Optional `gameId` filters to one membership.
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-game-auth: jwt-passport
 */
router.get("/tick-context", async (req, res) => {
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
    const gameId =
      typeof req.query.gameId === "string" && req.query.gameId.trim()
        ? req.query.gameId.trim()
        : null;
    const { tasks, waitingOn, contexts } = await listTickContextForRodit(roditId, {
      includeFinished,
      gameId
    });
    res.json({ tasks, waitingOn, contexts, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/tick:
 *   post:
 *     summary: Submit one required execution action (explicit action body required)
 *     description: REST mirror of MCP slc_tick. Prefer over multi-step GET /tasks + POST when advancing submission-gated phases. Empty body does not submit none — returns action_required. AFK timeout still applies none via the scheduler.
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
    const result = await runAgentTick(roditId, body);
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
    await assertPassportIpLoginMethod(req, gameId, roditId);
    const existing = await repo.getAgentByRoditId(gameId, roditId);
    let agent;
    try {
      agent = await engine.joinGame(gameId, {
        roditId,
        displayName: req.body?.displayName,
        agentType: req.body?.agentType,
        llmModel: req.body?.llmModel
      });
      // Prefer once per new lobby seat (!existing). Re-join of same seat is skipped;
      // across games we emit again (no cross-game first-seat store).
      if (!existing) {
        trackFunnelPlay(req, {
          tokenId: roditId,
          path: "/api/game/games/:gameId/join",
          result: "success",
          requestId,
          extra: { gameId }
        });
      }
    } catch (joinErr) {
      trackFunnelPlay(req, {
        tokenId: roditId,
        path: "/api/game/games/:gameId/join",
        result: "failed",
        errorCode: joinErr.code || joinErr.statusCode || "JOIN_FAILED",
        requestId,
        extra: { gameId }
      });
      throw joinErr;
    }

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
 * /api/game/games/{gameId}/profile:
 *   patch:
 *     summary: Update agentType and/or llmModel for the authenticated cradle
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-game-auth: jwt-passport
 */
router.patch("/games/:gameId/profile", validateContentType, validateJsonBody, async (req, res) => {
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
    const agent = await engine.updateAgentProfile(req.params.gameId, roditId, {
      ...(Object.prototype.hasOwnProperty.call(req.body || {}, "agentType")
        ? { agentType: req.body.agentType }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(req.body || {}, "llmModel")
        ? { llmModel: req.body.llmModel }
        : {})
    });
    res.json({ agent, requestId });
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
 *     summary: Create an official competition series (qualifying week + competition prize game)
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
 *     summary: Create an official competition series (alias of POST /api/game/contests)
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-game-auth: privileged-rodit-id
 */
router.post("/contest-series", validateContentType, validateJsonBody, handleCreateContestSeries);

/**
 * @swagger
 * /api/game/seasons:
 *   post:
 *     summary: Create a multi-phase contest season (practice → qualifying → rostered final)
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-game-auth: privileged-rodit-id
 */
router.post("/seasons", validateContentType, validateJsonBody, async (req, res) => {
  const requestId = req.requestId || ulid();
  if (!denyUnlessPrivileged(req, res, requestId)) {
    return;
  }
  try {
    const created = await season.createSeason({
      name: req.body?.name,
      practiceStartsAt: req.body?.practiceStartsAt,
      practiceEndsAt: req.body?.practiceEndsAt,
      qualifyingStartsAt: req.body?.qualifyingStartsAt,
      qualifyingEndsAt: req.body?.qualifyingEndsAt,
      finalJoiningStartsAt: req.body?.finalJoiningStartsAt,
      prizeAmountYoctoNear: req.body?.prizeAmountYoctoNear
    });
    res.status(201).json({ season: created, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/seasons/{seasonId}/roster:
 *   put:
 *     summary: Publish the authorized final roster (subset of qualifying winners)
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-game-auth: privileged-rodit-id
 */
router.put("/seasons/:seasonId/roster", validateContentType, validateJsonBody, async (req, res) => {
  const requestId = req.requestId || ulid();
  if (!denyUnlessPrivileged(req, res, requestId)) {
    return;
  }
  try {
    const updated = await season.setFinalRoster(req.params.seasonId, req.body?.roditIds || []);
    res.json({ season: updated, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/seasons/{seasonId}/final:
 *   post:
 *     summary: Create the definitive final lobby for a season (roster must be set)
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-game-auth: privileged-rodit-id
 */
router.post("/seasons/:seasonId/final", validateContentType, validateJsonBody, async (req, res) => {
  const requestId = req.requestId || ulid();
  if (!denyUnlessPrivileged(req, res, requestId)) {
    return;
  }
  try {
    const result = await season.createSeasonFinal(req.params.seasonId, {
      joiningWindowStartsAt: req.body?.joiningWindowStartsAt,
      configOverrides: req.body?.config || {}
    });
    res.status(201).json({ ...result, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

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
 *     summary: Submit execution-phase action (transfer, invest_production, invest_storage, or none). Invest requires equal energy, water, and compute (amount N spends N of each = 3N total per side; N may be fractional to 4 decimal places). Optional free reduceStorage shrinks warehouse caps. Transfers may include optional rationale and curated privateDealSnippets. Optional hide (compute) and find (targetAgentId + compute) fields may accompany any action type.
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
 * /api/game/games/{gameId}/project:
 *   post:
 *     summary: Dry-run survival/action calculator (does not submit)
 *     description: >
 *       Project storage-tax + survival + outbound action effects without writing an action.
 *       Optional assumeInbound models hypothetical peer sends. Allowed in any running phase.
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-game-auth: jwt-passport
 */
router.post("/games/:gameId/project", validateContentType, validateJsonBody, async (req, res) => {
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
        message: "You must join the game before projecting actions"
      });
    }
    const { assumeInbound, stateRevision, stateAsOf, observedPhase, ...actionBody } = req.body || {};
    const result = await engine.projectAgentActionDryRun(req.params.gameId, agent.id, actionBody, {
      assumeInbound,
      stateRevision,
      stateAsOf,
      observedPhase
    });
    res.status(200).json({ ...result, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/games/{gameId}/recollection:
 *   post:
 *     summary: Submit or update a public post-elim / post-finish recollection for spectators
 *     description: >
 *       Recommended agent-authored memoir after deathReason (elimination) or winReport / gameOverReport
 *       (finished game). Cover relationships, espionage, investment, trade, incidents, and how the game went.
 *       Public once submitted via GET .../recollections.
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-game-auth: jwt-passport
 */
router.post("/games/:gameId/recollection", validateContentType, validateJsonBody, async (req, res) => {
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
        message: "You must join the game before submitting a recollection"
      });
    }
    const { submitRecollection } = require("./recollection");
    const result = await submitRecollection(req.params.gameId, agent.id, req.body);
    res.status(result.created ? 201 : 200).json({ ...result, requestId });
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
  res.json({
    defaults: {
      ...publicGameConfig(DEFAULT_GAME_CONFIG),
      maxSimultaneousGames: MAX_SIMULTANEOUS_GAMES,
      agentTypes: [...AGENT_TYPES],
      llmModelMaxLen: LLM_MODEL_MAX_LEN
    },
    requestId: req.requestId || ulid()
  });
});

/**
 * @swagger
 * /api/game/defaults/contest:
 *   get:
 *     summary: Get competition and qualifying game configuration presets
 *     tags: [Game]
 *     security:
 *       - bearerAuth: []
 *     x-game-auth: jwt-passport
 */
router.get("/defaults/contest", (req, res) => {
  res.json({
    definitive: publicGameConfig(CONTEST_GAME_CONFIG),
    practice: publicGameConfig(PRACTICE_GAME_CONFIG),
    qualifying: publicGameConfig(QUALIFYING_GAME_CONFIG),
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
