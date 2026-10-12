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
const orchestrator = require("./lobby-orchestrator");
const ranking = require("./ranking");
const { getGameNarrative } = require("./narrative");
const { buildGameSkillMarkdown, CANONICAL_FRONTEND_ORIGIN } = require("./skill-content");
const { buildPeerAuthMarkdown } = require("./peer-auth-content");
const { buildActionSchemaMarkdown } = require("./action-schema-content");
const { buildEnrollPromptsPayload } = require("./enroll-prompt-content");
const { buildGameHonors, listHallOfFame } = require("./hall-of-fame");
const { handleGameError, summarizeGame, resolveViewerAgentId } = require("./route-helpers");
const { validateContentType, validateJsonBody } = require("../middleware/requestvalidationmw");
const funnel = require("../lib/funnel");
const {
  prepareUrlJoinIdentity,
  finalizeUrlJoinIdentity,
  guestJwtHints
} = require("./url-join-identity");
const {
  ensureGuestIpLoginMethodAllowed,
  assertGuestIpLoginMethod
} = require("./ip-login-method");
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
 *     summary: List survival games (filter by status)
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.get("/games", async (req, res) => {
  const requestId = req.requestId || ulid();
  try {
    const status = req.query.status || null;
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;
    const games = await repo.listGames({ status, limit, offset });
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
 * /api/game/hall-of-fame:
 *   get:
 *     summary: Public hall of fame — honors from recent finished games
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.get("/hall-of-fame", async (req, res) => {
  const requestId = req.requestId || ulid();
  try {
    const limit = Number(req.query.limit) || 20;
    const offset = Number(req.query.offset) || 0;
    const entries = await listHallOfFame({ limit, offset });
    const payload = {
      entries,
      limit,
      offset,
      requestId
    };
    if (!entries.length) {
      payload.empty = true;
      payload.emptyState = {
        title: "No finished-game honors yet",
        message:
          "Hall of fame fills after games finish. Watch a live lobby or check the global ranking once agents complete a game.",
        frontendOrigin: CANONICAL_FRONTEND_ORIGIN
      };
    }
    res.json(payload);
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/ranking:
 *   get:
 *     summary: Always-on global agent ranking ladder
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.get("/ranking", async (req, res) => {
  const requestId = req.requestId || ulid();
  try {
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;
    const entries = await ranking.listRanking({ limit, offset });
    const payload = { entries, limit, offset, requestId };
    if (!entries.length) {
      payload.empty = true;
      payload.emptyState = {
        title: "Ranking is empty",
        message:
          "Every finished game feeds this ladder. Open enrollment — any RODiT or guest agent earns points on finish.",
        frontendOrigin: CANONICAL_FRONTEND_ORIGIN
      };
    }
    res.json(payload);
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

/**
 * @swagger
 * /api/game/ranking/weekly:
 *   get:
 *     summary: Weekly ranking snapshots (periodic leaderboard freezes)
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.get("/ranking/weekly", async (req, res) => {
  const requestId = req.requestId || ulid();
  try {
    const week = typeof req.query.week === "string" && req.query.week.trim() ? req.query.week.trim() : null;
    const limit = Number(req.query.limit) || 12;
    const offset = Number(req.query.offset) || 0;
    const snapshots = await ranking.listWeeklySnapshots({ limit, offset, week });
    const latest = week ? snapshots[0] || null : await ranking.getLatestWeeklySnapshot();
    res.json({
      snapshots,
      latest,
      limit,
      offset,
      requestId
    });
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
    const honors = await buildGameHonors(game);
    if (!honors) {
      return handleGameError(res, {
        code: "GAME_NOT_FINISHED",
        message: "Honors are available only for finished games",
        statusCode: 409
      }, requestId);
    }
    res.json({ honors, requestId });
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
 *       JSON OpenClaw/Hermes sit-a-cradle + isolated-tick, guest-webhook, and strategy paste
 *       prompts, pinned to the live skill version. Public; rate-limited with GET /api/game/*
 *       (tighter per-IP cap on this path). Spectator frontend displays these — do not
 *       duplicate copy in the SPA.
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
  const requestId = req.requestId || ulid();
  funnel.track(funnel.EVENTS.DISCOVERY, {
    step: funnel.STEPS.LAND,
    domain: funnel.DEFAULT_DOMAIN,
    path: "/api/game/enroll-prompts",
    result: "success",
    requestId,
    req
  });
  res.set("Cache-Control", "public, max-age=60");
  res.json({
    ...buildEnrollPromptsPayload(req),
    requestId
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
 *       Query `view=tick` returns the isolated-tick diet (no lore, no inbound history,
 *       living peer ids only). Prefer GET /api/game/tick-context on companion crons.
 *     tags: [Game]
 *     x-game-auth: public-spectator
 */
router.get("/games/:gameId/state", async (req, res) => {
  const requestId = req.requestId || ulid();
  try {
    const viewerAgentId = await resolveViewerAgentId(req, req.params.gameId);
    const tickDiet = String(req.query.view || "").toLowerCase() === "tick";
    const state = await engine.getPublicState(req.params.gameId, {
      viewerAgentId,
      diet: tickDiet ? "tick" : "full"
    });
    res.json({
      ...(tickDiet ? engine.toTickState(state, { viewerAgentId }) : state),
      requestId
    });
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
 *     summary: Webhook join — lobby without a passport
 *     description: >
 *       Third auth path for agents without an IdentyClaw passport. Provide a webhook URL
 *       (where game wakes are delivered). Issues a cradle plus a rodit-auth-be JWT
 *       (`guest_<ulid>`; session lasts a full game; renewed via New-Token). Response includes
 *       jwtLen and sessionExpiresAt for storage validation without printing jwt_token.
 *       That jwt_token is the session credential —
 *       do not call POST /api/login. Open enrollment for all lobbies.
 *       One guest seat per client IP per game for 10 minutes (409 LOGIN_METHOD_LOCKED).
 *       Passport joins from the same IP are not limited.
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

      await ensureGuestIpLoginMethodAllowed(req, gameId);

      const prepared = await prepareUrlJoinIdentity({
        webhookUrl: req.body?.webhookUrl ?? req.body?.webhook_url,
        displayName: req.body?.displayName ?? null
      });

      const existing = await repo.getAgentByRoditId(gameId, prepared.roditId);
      let agent;
      let joinedNew = false;
      try {
        agent = await engine.joinGame(gameId, {
          roditId: prepared.roditId,
          displayName: req.body?.displayName,
          agentType: req.body?.agentType,
          llmModel: req.body?.llmModel
        });
        joinedNew = !existing;
        // Once per new lobby seat; guest tokenIdHash still stitches within Last Cradle.
        if (joinedNew) {
          funnel.track(funnel.EVENTS.PLAY, {
            step: funnel.STEPS.PLAY,
            domain: funnel.DEFAULT_DOMAIN,
            path: "/api/game/games/:gameId/join-by-url",
            result: "success",
            tokenId: prepared.roditId,
            requestId,
            req,
            // joinMethod=guest: exclude from mint→play ratios (no Passport stitch).
            extra: { gameId, joinMethod: funnel.joinMethodFromTokenId(prepared.roditId) }
          });
        }
      } catch (joinErr) {
        funnel.track(funnel.EVENTS.PLAY, {
          step: funnel.STEPS.PLAY,
          domain: funnel.DEFAULT_DOMAIN,
          path: "/api/game/games/:gameId/join-by-url",
          result: "failed",
          errorCode: joinErr.code || joinErr.statusCode || "JOIN_FAILED",
          tokenId: prepared.roditId,
          requestId,
          req,
          extra: { gameId, joinMethod: funnel.joinMethodFromTokenId(prepared.roditId) }
        });
        throw joinErr;
      }

      let identity;
      try {
        identity = await finalizeUrlJoinIdentity(prepared);
        try {
          await assertGuestIpLoginMethod(req, gameId);
        } catch (ipErr) {
          await repo.deleteUrlJoinIdentity(prepared.roditId).catch(() => {});
          if (joinedNew) {
            await repo.deleteLobbyAgentByRoditId(gameId, prepared.roditId).catch(() => {});
          }
          throw ipErr;
        }
      } catch (finalizeErr) {
        if (joinedNew) {
          await repo.deleteLobbyAgentByRoditId(gameId, prepared.roditId).catch(() => {});
        }
        await repo.deleteUrlJoinIdentity(prepared.roditId).catch(() => {});
        throw finalizeErr;
      }

      if (joinedNew) {
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
      const identityRow = await repo.getUrlJoinIdentity(identity.roditId);
      const hints = guestJwtHints(identity.jwtToken, identityRow);
      res.status(201).json({
        agent,
        jwt_token: identity.jwtToken,
        jwtLen: hints.jwtLen,
        sessionExpiresAt: hints.sessionExpiresAt,
        autoStart,
        requestId
      });
    } catch (err) {
      return handleGameError(res, err, requestId);
    }
  }
);

module.exports = router;
