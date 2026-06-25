/**
 * Public read-only game routes for live spectators (no JWT required).
 * Optional Bearer JWT upgrades state visibility for joined players.
 */

const express = require("express");
const router = express.Router();
const { ulid } = require("ulid");
const engine = require("./engine");
const repo = require("./repository");
const events = require("./events");
const { getGameNarrative } = require("./narrative");
const { handleGameError, summarizeGame, resolveViewerAgentId } = require("./route-helpers");

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
 * /api/game/games/{gameId}/state:
 *   get:
 *     summary: Get public game state
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

    const turnNumber = Number(req.query.turn) || game.current_turn || 0;
    const trades = await repo.listPublicTrades(req.params.gameId, turnNumber);

    res.json({ trades, turnNumber, requestId });
  } catch (err) {
    return handleGameError(res, err, requestId);
  }
});

module.exports = router;
