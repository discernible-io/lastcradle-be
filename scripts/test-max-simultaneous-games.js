#!/usr/bin/env node
/**
 * Verifies host-wide max simultaneous lobby/running games (TOO_MANY_ACTIVE_GAMES).
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "max-simultaneous-games-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const { MAX_SIMULTANEOUS_GAMES, MAX_SIMULTANEOUS_GAMES_DEFAULT } = require("../src/game/defaults");

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

  if (MAX_SIMULTANEOUS_GAMES !== MAX_SIMULTANEOUS_GAMES_DEFAULT) {
    throw new Error(
      `expected resolved MAX_SIMULTANEOUS_GAMES ${MAX_SIMULTANEOUS_GAMES_DEFAULT}, got ${MAX_SIMULTANEOUS_GAMES}`
    );
  }

  const created = [];
  for (let i = 0; i < MAX_SIMULTANEOUS_GAMES; i += 1) {
    const game = await engine.createGame({
      config: {
        maxAgents: 2,
        minAgents: 2,
        joiningWindowDurationMs: 60_000
      },
      // Skip fill-first so we can open many games for this capacity test.
      allowParallelLobbies: true
    });
    // Mark running so fill-first does not mask TOO_MANY_ACTIVE_GAMES on later creates.
    await repo.updateGame(game.id, { status: "running" });
    created.push(game);
  }

  const active = await repo.countActiveGames();
  if (active !== MAX_SIMULTANEOUS_GAMES) {
    throw new Error(`expected ${MAX_SIMULTANEOUS_GAMES} active, got ${active}`);
  }

  const blockedAssert = await expectCreateError(
    "assert at capacity",
    engine.assertSimultaneousGameCapacity({ slotsNeeded: 1 }),
    "TOO_MANY_ACTIVE_GAMES"
  );
  if (blockedAssert.details?.activeGames !== MAX_SIMULTANEOUS_GAMES) {
    throw new Error(
      `expected activeGames ${MAX_SIMULTANEOUS_GAMES}, got ${blockedAssert.details?.activeGames}`
    );
  }
  if (blockedAssert.details?.maxSimultaneousGames !== MAX_SIMULTANEOUS_GAMES) {
    throw new Error("details.maxSimultaneousGames mismatch");
  }

  const blockedCreate = await expectCreateError(
    "create at capacity",
    engine.createGame({
      config: { maxAgents: 2, minAgents: 2, joiningWindowDurationMs: 60_000 }
    }),
    "TOO_MANY_ACTIVE_GAMES"
  );
  if (blockedCreate.details?.activeGames !== MAX_SIMULTANEOUS_GAMES) {
    throw new Error("create error should report activeGames at cap");
  }

  await expectCreateError(
    "contest needs 2 slots",
    engine.assertSimultaneousGameCapacity({ slotsNeeded: 2 }),
    "TOO_MANY_ACTIVE_GAMES"
  );

  // Free one slot — create should succeed again.
  await repo.updateGame(created[0].id, { status: "finished" });
  const afterFinish = await engine.createGame({
    config: { maxAgents: 2, minAgents: 2, joiningWindowDurationMs: 60_000 }
  });
  if (!afterFinish?.id) {
    throw new Error("expected create after finish to succeed");
  }

  console.log("ok: max simultaneous games cap");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
