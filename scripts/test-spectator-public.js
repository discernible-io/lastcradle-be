#!/usr/bin/env node
/**
 * Verifies public spectator routes respond without JWT.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "spectator-public-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const express = require("express");
const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const spectatorRoutes = require("../src/game/spectator-routes");

async function requestJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function main() {
  await repo.initializeDatabase();

  const game = await engine.createGame({
    config: { minAgents: 1, maxAgents: 4, finishSurvivorCount: 1, maxTurns: 2 }
  });
  await engine.joinGame(game.id, { roditId: "spec-p1", displayName: "Cradle 1" });
  await engine.startGame(game.id);
  await engine.publishPublicMessage(game.id, (await repo.listAgents(game.id))[0].id, {
    body: "Public dispatch for spectators"
  });

  const app = express();
  app.use((req, _res, next) => {
    req.requestId = "test-request";
    next();
  });
  app.use("/api/game", spectatorRoutes);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = server.address().port;

  try {
    const list = await requestJson(port, "/api/game/games?status=running");
    if (list.status !== 200 || !list.body.games?.some((g) => g.id === game.id)) {
      throw new Error("expected running game in public list");
    }

    const state = await requestJson(port, `/api/game/games/${game.id}/state`);
    if (state.status !== 200) {
      throw new Error(`state failed: ${state.status}`);
    }
    const hidden = state.body.agents?.every((a) => a.inventory == null);
    if (!hidden) {
      throw new Error("spectators must not see agent inventories");
    }
    const narrative = state.body.narrative;
    if (!narrative?.version || !narrative?.survival) {
      throw new Error("state.narrative must include version + survival");
    }
    if (narrative.premise || narrative.mechanics || narrative.title) {
      throw new Error("state.narrative must not embed full static lore (use GET /narrative)");
    }

    const lore = await requestJson(port, "/api/game/narrative");
    if (lore.status !== 200 || !lore.body.narrative?.premise || !lore.body.narrative?.mechanics) {
      throw new Error("GET /narrative must still return full static lore");
    }

    const messages = await requestJson(port, `/api/game/games/${game.id}/messages`);
    if (messages.status !== 200 || !messages.body.messages?.length) {
      throw new Error("expected public messages without auth");
    }

    const turns = await requestJson(port, `/api/game/games/${game.id}/turns`);
    if (turns.status !== 200 || !Array.isArray(turns.body.turns)) {
      throw new Error("expected turn activity index without auth");
    }
    const turn1 = turns.body.turns.find((t) => t.turn === 1);
    if (!turn1?.played || !turn1.hasMessages) {
      throw new Error("expected turn 1 to be played with messages");
    }

    const playedOnly = await requestJson(port, `/api/game/games/${game.id}/turns?playedOnly=1`);
    if (playedOnly.status !== 200 || !playedOnly.body.playedOnly) {
      throw new Error("expected playedOnly flag");
    }
    if (!playedOnly.body.turns.every((t) => t.played)) {
      throw new Error("playedOnly must return only played turns");
    }

    console.log("✓ Public spectator routes work without JWT");
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
