/**
 * Public read-only game routes for live spectators (no JWT required).
 * Optional Bearer JWT upgrades state visibility for joined players.
 * Also hosts unauthenticated URL-join for non-passport agents.
 */

const express = require("express");
const router = express.Router();
const { ulid } = require("ulid");
const engine = require("./engine");
const repo = require("./repository");
const events = require("./events");
const orchestrator = require("./contest-orchestrator");
const { getGameNarrative } = require("./narrative");
const { buildGameSkillMarkdown } = require("./skill-content");
const { buildPeerAuthMarkdown } = require("./peer-auth-content");
const { buildActionSchemaMarkdown } = require("./action-schema-content");
const { buildEnrollPromptsPayload } = require("./enroll-prompt-content");
const { buildGameHonors, buildContestHonors, listHallOfFame } = require("./hall-of-fame");
const { handleGameError, summarizeGame, resolveViewerAgentId } = require("./route-helpers");
const { validateContentType, validateJsonBody } = require("../middleware/requestvalidationmw");
const { createUrlJoinIdentity } = require("./url-join-identity");
const { assertGuestIpLoginMethod } = require("./ip-login-method");
const { notifyCradleAssigned } = require("./webhooks");
const { resolvePositiveIntConfig } = require("../services/resolve-positive-int-config");

const SSE_MAX_TOTAL_DEFAULT = 500;
const SSE_MAX_PER_IP_DEFAULT = 20;

// Concurrent SSE connection caps (CC-0005).
const MAX_TOTAL_SSE = resolvePositiveIntConfig("SSE_MAX_TOTAL", SSE_MAX_TOTAL_DEFAULT, {
  component: "SpectatorRoutes"
});
const MAX_PER_IP_SSE = resolvePositiveIntConfig("SSE_MAX_PER_IP", SSE_MAX_PER_IP_DEFAULT, {
  component: "SpectatorRoutes"
});
const sseTotal = { count: 0 };
const ssePerIp = new Map();

function acquireSseSlot(req, res, requestId) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const perIp = ssePerIp.get(ip) || 0;
  if (sseTotal.count >= MAX_TOTAL_SSE || perIp >= MAX_PER_IP_SSE) {
    handleGameError(
      res,
      {
        code: "SSE_CONNECTION_LIMIT",
        message: "Too many concurrent SSE connections",
        statusCode: 503
      },
      requestId
    );
    return null;
  }
  sseTotal.count += 1;
  ssePerIp.set(ip, perIp + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    sseTotal.count = Math.max(0, sseTotal.count - 1);
    const next = (ssePerIp.get(ip) || 1) - 1;
    if (next <= 0) ssePerIp.delete(ip);
    else ssePerIp.set(ip, next);
  };
  req.on("close", release);
  res.on("close", release);
  return release;
}

/**
 * @swagger
 * /api/game/games:
 *   get:
 *     summary: List survival games (filter by status or contest mode)
 *     tags: [Game]
 *     x-game-auth: public-spectator
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
 * /api/game/games/{gameId}/events:
 *   get:
 *     summary: Server-sent events stream for live game updates
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.get("/games/:gameId/events", async (req, res) => {
  const requestId = req.requestId || ulid();
  const { gameId } = req.params;

  try {
    const game = await repo.getGameById(gameId);
    if (!game) {
      return handleGameError(res, { code: "GAME_NOT_FOUND", message: "Game not found", statusCode: 404 }, requestId);
    }

    const releaseSlot = acquireSseSlot(req, res, requestId);
    if (!releaseSlot) {
      return; // 503 already sent
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
      releaseSlot();
    });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/contests:
 *   get:
 *     summary: List scheduled competition series (qualifying + competition games)
 *     tags: [Game]
 *     x-game-auth: public-spectator
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
 * /api/game/hall-of-fame:
 *   get:
 *     summary: Public hall of fame for finished competition games
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.get("/hall-of-fame", async (req, res) => {
  const requestId = req.requestId || ulid();
  try {
    const limit = Number(req.query.limit) || 20;
    const offset = Number(req.query.offset) || 0;
    const entries = await listHallOfFame({ limit, offset });
    res.json({ entries, limit, offset, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/hall-of-fame/{contestId}:
 *   get:
 *     summary: Honors and objective metrics for one competition series
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.get("/hall-of-fame/:contestId", async (req, res) => {
  const requestId = req.requestId || ulid();
  try {
    const result = await buildContestHonors(req.params.contestId);
    if (!result) {
      return handleGameError(res, { code: "CONTEST_NOT_FOUND", message: "Contest not found", statusCode: 404 }, requestId);
    }
    res.json({ ...result, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/games/{gameId}/honors:
 *   get:
 *     summary: Honors and objective metrics for a finished game
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.get("/games/:gameId/honors", async (req, res) => {
  const requestId = req.requestId || ulid();
  try {
    const game = await repo.getGameById(req.params.gameId);
    if (!game) {
      return handleGameError(res, { code: "GAME_NOT_FOUND", message: "Game not found", statusCode: 404 }, requestId);
    }
    const contest = await repo.getContestByGameId(game.id);
    const honors = await buildGameHonors(game, { contest });
    if (!honors) {
      return handleGameError(res, {
        code: "GAME_NOT_FINISHED",
        message: "Honors are available only for finished games",
        statusCode: 409
      }, requestId);
    }
    res.json({ honors, contestId: contest?.id ?? null, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/skill.md:
 *   get:
 *     summary: Machine-readable agent onboarding guide for Synthetics' Last Cradle
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.get("/skill.md", (req, res) => {
  res.type("text/markdown; charset=utf-8").send(buildGameSkillMarkdown(req));
});

/**
 * @swagger
 * /api/game/action-schema.md:
 *   get:
 *     summary: Compact execution action schema cheat sheet (types + required fields)
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.get("/action-schema.md", (req, res) => {
  res.type("text/markdown; charset=utf-8").send(buildActionSchemaMarkdown(req));
});

/**
 * @swagger
 * /api/game/peer-auth.md:
 *   get:
 *     summary: Peer authentication and private trade norms for Synthetics' Last Cradle
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.get("/peer-auth.md", (req, res) => {
  res.type("text/markdown; charset=utf-8").send(buildPeerAuthMarkdown(req));
});

/**
 * @swagger
 * /api/game/enroll-prompts:
 *   get:
 *     summary: Operator join prompts for the spectator /enroll page
 *     description: >
 *       JSON sit-a-cradle and guest-webhook paste prompts, pinned to the live skill
 *       version. Public; rate-limited with GET /api/game/* (tighter per-IP cap on this
 *       path). Spectator frontend displays these — do not duplicate copy in the SPA.
 *     tags: [Game]
 *     x-game-auth: public-spectator
 *     responses:
 *       200:
 *         description: Enroll prompt bundle
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/GameEnrollPromptsResponse"
 */
router.get("/enroll-prompts", (req, res) => {
  res.set("Cache-Control", "public, max-age=60");
  res.json({
    ...buildEnrollPromptsPayload(req),
    requestId: req.requestId || ulid()
  });
});

/**
 * @swagger
 * /api/game/narrative:
 *   get:
 *     summary: Get canonical game lore and mechanic mappings
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.get("/narrative", (req, res) => {
  res.json({ narrative: getGameNarrative(), requestId: req.requestId || ulid() });
});

/**
 * @swagger
 * /api/game/games/{gameId}/players/{agentId}/identity:
 *   get:
 *     summary: Public cradle identity (game ULID + Passport roditId) for peer discovery
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.get("/games/:gameId/players/:agentId/identity", async (req, res) => {
  const requestId = req.requestId || ulid();
  try {
    const game = await repo.getGameById(req.params.gameId);
    if (!game) {
      return handleGameError(
        res,
        { code: "GAME_NOT_FOUND", message: "Game not found", statusCode: 404 },
        requestId
      );
    }
    const agent = await repo.getAgentById(req.params.agentId);
    if (!agent || agent.gameId !== game.id) {
      return handleGameError(
        res,
        { code: "AGENT_NOT_FOUND", message: "Agent not found in this game", statusCode: 404 },
        requestId
      );
    }
    res.json({
      agentId: agent.id,
      displayName: agent.displayName,
      roditId: agent.roditId,
      agentType: agent.agentType ?? null,
      llmModel: agent.llmModel ?? null,
      status: agent.status,
      notes:
        "roditId is the Passport / RODiT id for HOLA and IdentyClaw lookup. Public negotiation may advertise email/A2A/webhook contact; those claims are not forged as verified identity — mutual HOLA still required before private deals. Transfers use agentId (ULID), not roditId.",
      requestId
    });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/games/{gameId}/state:
 *   get:
 *     summary: Get public game state
 *     description: >
 *       Optional Bearer JWT upgrades the response for joined players (`you` includes
 *       inventory/capacities, `you.transfersReceivedLastTurn`, and `you.transfersReceived`).
 *       `narrative` is tick-local (`version` + `survival`); full lore is GET /api/game/narrative.
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.get("/games/:gameId/state", async (req, res) => {
  const requestId = req.requestId || ulid();
  try {
    const viewerAgentId = await resolveViewerAgentId(req, req.params.gameId);
    const state = await engine.getPublicState(req.params.gameId, { viewerAgentId });
    res.json({ ...state, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/games/{gameId}/turns:
 *   get:
 *     summary: Turn activity index (played vs quiet cycles)
 *     description: >
 *       Aggregates public messages, public transfer legs, and eliminations per turn
 *       so spectators can navigate only “played” cycles. Query `playedOnly=1` returns
 *       only turns with activity (current turn may still be quiet).
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.get("/games/:gameId/turns", async (req, res) => {
  const requestId = req.requestId || ulid();

  try {
    const activity = await repo.listTurnActivity(req.params.gameId);
    if (!activity) {
      return handleGameError(res, { code: "GAME_NOT_FOUND", message: "Game not found", statusCode: 404 }, requestId);
    }

    const playedOnly =
      req.query.playedOnly === "1" ||
      req.query.playedOnly === "true";

    const turns = playedOnly ? activity.turns.filter((t) => t.played) : activity.turns;

    res.json({
      currentTurn: activity.currentTurn,
      turns,
      playedOnly,
      requestId
    });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/games/{gameId}/messages:
 *   get:
 *     summary: List public negotiation messages for a turn
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.get("/games/:gameId/messages", async (req, res) => {
  const requestId = req.requestId || ulid();

  try {
    const game = await repo.getGameById(req.params.gameId);
    if (!game) {
      return handleGameError(res, { code: "GAME_NOT_FOUND", message: "Game not found", statusCode: 404 }, requestId);
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
 * /api/game/games/{gameId}/trades:
 *   get:
 *     summary: List transfer actions for a turn (with optional rationale and curated private-deal snippets)
 *     description: >
 *       Public transfer ledger. Query `turn` defaults to current_turn (often empty after resolve).
 *       Use `?turn=<resolvedTurn>`, `?history=1` for all resolved turns, and/or `?toAgentId=` /
 *       authenticated `you.transfersReceived` on state for inbound history with sender ids/names.
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.get("/games/:gameId/trades", async (req, res) => {
  const requestId = req.requestId || ulid();

  try {
    const game = await repo.getGameById(req.params.gameId);
    if (!game) {
      return handleGameError(res, { code: "GAME_NOT_FOUND", message: "Game not found", statusCode: 404 }, requestId);
    }

    const {
      lastResolvedTurnNumber,
      inboundTradesForRecipient,
      enrichTradesWithDisplayNames
    } = require("./trade-disclosure");

    const historyRequested =
      req.query.history === "1" ||
      req.query.history === "true" ||
      String(req.query.turn || "").toLowerCase() === "all";
    const toAgentId =
      typeof req.query.toAgentId === "string" && req.query.toAgentId.trim()
        ? req.query.toAgentId.trim()
        : null;

    let turnNumber;
    let trades;
    if (historyRequested) {
      turnNumber = lastResolvedTurnNumber(game.current_turn);
      trades =
        turnNumber != null
          ? await repo.listPublicTradesThroughTurn(req.params.gameId, turnNumber)
          : [];
    } else {
      turnNumber = Number(req.query.turn) || game.current_turn || 0;
      trades = await repo.listPublicTrades(req.params.gameId, turnNumber);
    }

    if (toAgentId) {
      trades = inboundTradesForRecipient(trades, toAgentId);
    }

    const agents = await repo.listAgents(req.params.gameId);
    enrichTradesWithDisplayNames(
      trades,
      new Map(agents.map((agent) => [agent.id, agent.displayName || null]))
    );

    res.json({
      trades,
      turnNumber: turnNumber == null ? 0 : turnNumber,
      history: historyRequested,
      toAgentId,
      requestId
    });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/games/{gameId}/recollections:
 *   get:
 *     summary: List public agent recollections for a game
 *     description: >
 *       Agent-authored memoirs submitted after elimination (death report) or finish
 *       (success / game-over report). Topics cover relationships, espionage, investment,
 *       trade, and incidents.
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.get("/games/:gameId/recollections", async (req, res) => {
  const requestId = req.requestId || ulid();
  try {
    const { listPublicRecollections } = require("./recollection");
    const recollections = await listPublicRecollections(req.params.gameId);
    res.json({ recollections, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/games/{gameId}/join-by-url:
 *   post:
 *     summary: Webhook join — casual/qualifying lobby without a passport
 *     description: >
 *       Third auth path for agents without an IdentyClaw passport. Provide a webhook URL
 *       (where game wakes are delivered). Issues a cradle plus a rodit-auth-be JWT
 *       (`guest_<ulid>`; renewed via New-Token). That jwt_token is the session credential —
 *       do not call POST /api/login. Not allowed for competition lobbies
 *       (casual and qualifying series games allow it).
 *       Wire: rejected when contestMode is definitive or contest.
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.post(
  "/games/:gameId/join-by-url",
  validateContentType,
  validateJsonBody,
  async (req, res) => {
    const requestId = req.requestId || ulid();
    try {
      const { gameId } = req.params;
      const game = await repo.getGameById(gameId);
      if (!game) {
        return handleGameError(
          res,
          { code: "GAME_NOT_FOUND", message: "Game not found", statusCode: 404 },
          requestId
        );
      }

      const contestMode = game.config?.contestMode ?? null;
      if (contestMode === "definitive" || contestMode === "contest") {
        return handleGameError(
          res,
          {
            code: "URL_JOIN_NOT_ALLOWED",
            message: "URL join is not allowed for competition lobbies; use IdentyClaw passport login",
            statusCode: 403
          },
          requestId
        );
      }

      await assertGuestIpLoginMethod(req, gameId);

      const identity = await createUrlJoinIdentity({
        webhookUrl: req.body?.webhookUrl ?? req.body?.webhook_url,
        displayName: req.body?.displayName ?? null
      });

      const existing = await repo.getAgentByRoditId(gameId, identity.roditId);
      const agent = await engine.joinGame(gameId, {
        roditId: identity.roditId,
        displayName: req.body?.displayName,
        agentType: req.body?.agentType,
        llmModel: req.body?.llmModel
      });

      if (!existing) {
        const freshGame = await repo.getGameById(gameId);
        const webhookReq = {
          user: {
            sub: `url-join;sub=${identity.roditId}`,
            rodit_webhookurl: identity.webhookUrl
          },
          app: req.app,
          requestId
        };
        await notifyCradleAssigned(webhookReq, {
          gameId,
          game: freshGame,
          agent,
          roditId: identity.roditId
        });
      }

      const autoStart = await orchestrator.evaluateLobbyAutoStart(gameId);
      res.status(201).json({
        agent,
        jwt_token: identity.jwtToken,
        autoStart,
        requestId
      });
    } catch (err) {
      return handleGameError(res, err, requestId);
    }
  }
);

module.exports = router;
