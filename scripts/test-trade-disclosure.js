#!/usr/bin/env node
/**
 * Trade rationale / privateDealSnippets validation and public trades route.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "trade-disclosure-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const express = require("express");
const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const spectatorRoutes = require("../src/game/spectator-routes");
const { normalizeTransferDisclosure } = require("../src/game/trade-disclosure");

function assertThrows(fn, code) {
  try {
    fn();
    throw new Error(`expected ${code}`);
  } catch (err) {
    if (err.code !== code) throw err;
  }
}

async function requestJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function main() {
  assertThrows(
    () =>
      normalizeTransferDisclosure({
        type: "transfer",
        privateDealSnippets: [{ excerpt: "" }]
      }),
    "INVALID_TRADE_SNIPPETS"
  );

  const normalized = normalizeTransferDisclosure({
    type: "transfer",
    toAgentId: "x",
    rationale: "  pact honor  ",
    privateDealSnippets: [
      {
        taskType: "TRADE_ACCEPT",
        channel: "a2a",
        excerpt: "Agreed terms",
        holaVerified: true
      }
    ]
  });
  if (normalized.rationale !== "pact honor") throw new Error("rationale trim failed");
  if (normalized.privateDealSnippets.length !== 1) throw new Error("snippet normalize failed");

  await repo.initializeDatabase();

  const game = await engine.createGame({
    config: {
      minAgents: 2,
      maxAgents: 4,
      finishSurvivorCount: 1,
      maxTurns: 2,
      joiningWindowDurationMs: 0
    }
  });
  await engine.joinGame(game.id, { roditId: "trader-a", displayName: "Cradle A" });
  const agentB = await engine.joinGame(game.id, { roditId: "trader-b", displayName: "Cradle B" });
  await engine.startGame(game.id);

  const agents = await repo.listAgents(game.id);
  const agentA = agents.find((a) => a.roditId === "trader-a");

  await engine.beginExecutionPhase(game.id);

  const gameState = await repo.getGameById(game.id);
  if (gameState.phase !== "execution") {
    throw new Error(`expected execution phase, got ${gameState.phase}`);
  }

  await engine.submitAction(game.id, agentA.id, {
    type: "transfer",
    toAgentId: agentB.id,
    energy: 5,
    rationale: "Water alliance installment",
    privateDealSnippets: [
      {
        taskType: "TRADE_OFFER",
        channel: "email",
        peerTokenId: "trader-b.rodit.near",
        excerpt: "Send 5E now; I send 5W next cycle.",
        holaVerified: true
      }
    ]
  });
  const turnNumber = gameState.current_turn;
  await engine.submitAction(game.id, agentB.id, { type: "none" });

  const trades = await repo.listPublicTrades(game.id, turnNumber);
  if (!trades.length || trades[0].rationale !== "Water alliance installment") {
    throw new Error("expected public trade with rationale");
  }

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
    const res = await requestJson(port, `/api/game/games/${game.id}/trades?turn=${turnNumber}`);
    if (res.status !== 200 || !res.body.trades?.[0]?.privateDealSnippets?.length) {
      throw new Error("spectator trades route failed");
    }
    console.log("✓ Trade disclosure validation and public trades route work");
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }

  await repo.closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
