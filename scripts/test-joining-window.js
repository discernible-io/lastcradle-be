#!/usr/bin/env node
/**
 * Verifies cradle assignment is gated to the configured joining window.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "joining-window-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");

async function expectJoinError(label, promise, code) {
  try {
    await promise;
    throw new Error(`${label}: expected ${code}`);
  } catch (err) {
    if (err.code !== code) {
      throw new Error(`${label}: expected ${code}, got ${err.code || err.message}`);
    }
  }
}

async function main() {
  await repo.initializeDatabase();

  const futureStart = new Date(Date.now() + 60_000).toISOString();
  const game = await engine.createGame({
    config: { joiningWindowDurationMs: 30_000, minAgents: 1 },
    joiningWindowStartsAt: futureStart,
    allowParallelLobbies: true
  });

  await expectJoinError(
    "before window",
    engine.joinGame(game.id, { roditId: "early", displayName: "Early" }),
    "JOIN_WINDOW_NOT_OPEN"
  );

  const immediate = await engine.createGame({
    config: { joiningWindowDurationMs: 1, minAgents: 1 },
    allowParallelLobbies: true
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  await expectJoinError(
    "after window",
    engine.joinGame(immediate.id, { roditId: "late", displayName: "Late" }),
    "JOIN_WINDOW_CLOSED"
  );

  const open = await engine.createGame({
    config: { joiningWindowDurationMs: 60_000, minAgents: 1 },
    allowParallelLobbies: true
  });
  const agent = await engine.joinGame(open.id, { roditId: "on-time", displayName: "On Time" });
  if (!agent.productionCapacity || agent.productionCapacity.energy <= 0) {
    throw new Error("expected cradle assignment during open window");
  }

  const legacy = await engine.createGame({
    config: { joiningWindowDurationMs: 0, minAgents: 1 },
    allowParallelLobbies: true
  });
  await engine.joinGame(legacy.id, { roditId: "legacy", displayName: "Legacy" });

  const state = await engine.getPublicState(open.id);
  if (!state.game.joiningWindow?.open) {
    throw new Error("expected joiningWindow.open in public state");
  }

  console.log("Joining window test passed.");
  await repo.closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
