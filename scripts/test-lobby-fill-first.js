#!/usr/bin/env node
/**
 * Verifies casual lobbies must fill (maxAgents) before another lobby can be created.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "lobby-fill-first-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const { DEFAULT_GAME_CONFIG } = require("../src/game/defaults");

async function expectCreateError(label, promise, code) {
  try {
    await promise;
    throw new Error(`${label}: expected ${code}`);
  } catch (err) {
    if (err.code !== code) {
      throw new Error(`${label}: expected ${code}, got ${err.code || err.message}`);
    }
    return err;
  }
}

async function main() {
  await repo.initializeDatabase();

  if (DEFAULT_GAME_CONFIG.maxAgents !== 5) {
    throw new Error(`expected casual maxAgents 5, got ${DEFAULT_GAME_CONFIG.maxAgents}`);
  }

  const first = await engine.createGame({
    config: { maxAgents: 5, minAgents: 2, joiningWindowDurationMs: 60_000 }
  });

  const blocked = await expectCreateError(
    "second lobby while first has seats",
    engine.createGame({
      config: { maxAgents: 5, minAgents: 2, joiningWindowDurationMs: 60_000 }
    }),
    "OPEN_LOBBY_AVAILABLE"
  );
  if (!blocked.details?.openLobbies?.some((l) => l.id === first.id)) {
    throw new Error("OPEN_LOBBY_AVAILABLE should list the open lobby");
  }

  for (let i = 0; i < 5; i += 1) {
    await engine.joinGame(first.id, { roditId: `fill-${i}`, displayName: `Fill ${i}` });
  }

  const second = await engine.createGame({
    config: { maxAgents: 5, minAgents: 2, joiningWindowDurationMs: 60_000 }
  });
  if (!second?.id) {
    throw new Error("expected create to succeed after first lobby is full");
  }

  const closed = await engine.createGame({
    config: { maxAgents: 5, minAgents: 1, joiningWindowDurationMs: 1 },
    allowParallelLobbies: true
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Closed-window empty lobby must not block create once open lobbies are full.
  // Second is still open and not full — fill it first.
  for (let i = 0; i < 5; i += 1) {
    await engine.joinGame(second.id, { roditId: `second-${i}`, displayName: `Second ${i}` });
  }

  const third = await engine.createGame({
    config: { maxAgents: 5, minAgents: 2, joiningWindowDurationMs: 60_000 }
  });
  if (!third?.id) {
    throw new Error("expected create after all open lobbies are full (closed window ignored)");
  }
  if (closed.status !== "lobby") {
    throw new Error("sanity: closed-window game should still be lobby status");
  }

  console.log("Lobby fill-first test passed.");
  await repo.closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
