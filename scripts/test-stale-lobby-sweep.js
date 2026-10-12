#!/usr/bin/env node
/**
 * Verifies abandoned lobbies that never start are deleted from the database.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "stale-lobby-sweep-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const orchestrator = require("../src/game/lobby-orchestrator");
const scheduler = require("../src/game/scheduler");
const repo = require("../src/game/repository");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  await repo.initializeDatabase();

  const expiredEmpty = await engine.createGame({
    config: { minAgents: 3, maxAgents: 5, joiningWindowDurationMs: 1 },
    allowParallelLobbies: true
  });
  await sleep(5);
  const cancelled = await orchestrator.evaluateLobbyAutoStart(expiredEmpty.id);
  if (cancelled.reason !== "cancelled_insufficient_agents") {
    throw new Error(`expected cancelled_insufficient_agents, got ${cancelled.reason}`);
  }
  const expiredEmptyRow = await repo.getGameById(expiredEmpty.id);
  if (expiredEmptyRow) {
    throw new Error("expired empty lobby should be deleted from the database");
  }
  if (cancelled.deleted !== true) {
    throw new Error("expired empty lobby should report deleted: true");
  }

  const leftover = await engine.createGame({
    config: { minAgents: 3, maxAgents: 5, joiningWindowDurationMs: 60_000 },
    allowParallelLobbies: true
  });
  await engine.joinGame(leftover.id, { roditId: "ghost", displayName: "Ghost" });
  await repo.updateGame(leftover.id, { status: "cancelled" });

  const noWindow = await engine.createGame({
    config: {
      minAgents: 3,
      maxAgents: 5,
      joiningWindowDurationMs: 0,
      staleLobbyTtlMs: 1
    },
    allowParallelLobbies: true
  });
  await sleep(5);
  const swept = await orchestrator.sweepStaleLobbies();
  const noWindowResult = swept.find((r) => r.gameId === noWindow.id);
  if (noWindowResult?.reason !== "cancelled_insufficient_agents") {
    throw new Error(
      `no-window stale lobby should cancel, got ${JSON.stringify(noWindowResult)}`
    );
  }
  if (noWindowResult.deleted !== true) {
    throw new Error("no-window stale lobby should be deleted");
  }
  if (await repo.getGameById(noWindow.id)) {
    throw new Error("no-window stale lobby should be deleted from the database");
  }
  if (await repo.getGameById(leftover.id)) {
    throw new Error("pre-existing cancelled never-started game should be purged");
  }
  const leftoverAgents = await repo.listAgents(leftover.id);
  if (leftoverAgents.length !== 0) {
    throw new Error("purged game should have no leftover agents");
  }

  const ready = await engine.createGame({
    config: { minAgents: 1, maxAgents: 5, joiningWindowDurationMs: 50 },
    allowParallelLobbies: true
  });
  await engine.joinGame(ready.id, { roditId: "starter", displayName: "Starter" });
  await sleep(60);
  const started = await orchestrator.evaluateLobbyAutoStart(ready.id);
  if (!started.started) {
    throw new Error(`expected start after window with minAgents, got ${started.reason}`);
  }
  const readyRow = await repo.getGameById(ready.id);
  if (readyRow.status !== "running") {
    throw new Error(`ready lobby should be running, got ${readyRow.status}`);
  }

  const open = await engine.createGame({
    config: { minAgents: 3, maxAgents: 5, joiningWindowDurationMs: 60_000 },
    allowParallelLobbies: true
  });
  const waiting = await orchestrator.evaluateLobbyAutoStart(open.id);
  if (waiting.reason !== "waiting") {
    throw new Error(`open lobby should still be waiting, got ${waiting.reason}`);
  }
  const openRow = await repo.getGameById(open.id);
  if (openRow.status !== "lobby") {
    throw new Error(`open lobby should remain lobby, got ${openRow.status}`);
  }

  scheduler.unregisterGame("all");
  orchestrator.unregisterLobbyGame("all");
  await repo.closeDatabase();
  console.log("Stale lobby sweep test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
