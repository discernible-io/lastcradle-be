#!/usr/bin/env node
/**
 * Verifies a rodit may join only one lobby/running game at a time.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "one-active-game-test.sqlite");
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
    return err;
  }
}

async function main() {
  await repo.initializeDatabase();

  const lobbyConfig = {
    maxAgents: 5,
    minAgents: 2,
    joiningWindowDurationMs: 60_000
  };

  const gameA = await engine.createGame({
    config: lobbyConfig,
    allowParallelLobbies: true
  });
  const gameB = await engine.createGame({
    config: lobbyConfig,
    allowParallelLobbies: true
  });

  const agent = await engine.joinGame(gameA.id, {
    roditId: "agent-1",
    displayName: "Agent One"
  });
  if (!agent?.id) {
    throw new Error("expected join A to succeed");
  }

  const blockedLobby = await expectJoinError(
    "join B while in lobby A",
    engine.joinGame(gameB.id, { roditId: "agent-1", displayName: "Agent One" }),
    "AGENT_IN_ACTIVE_GAME"
  );
  if (blockedLobby.details?.activeGameId !== gameA.id) {
    throw new Error("AGENT_IN_ACTIVE_GAME should report activeGameId of A");
  }

  const rejoin = await engine.joinGame(gameA.id, {
    roditId: "agent-1",
    displayName: "Agent One"
  });
  if (rejoin.id !== agent.id) {
    throw new Error("same-game re-join should return existing agent");
  }

  await engine.joinGame(gameA.id, { roditId: "agent-2", displayName: "Agent Two" });
  await engine.startGame(gameA.id);

  const blockedRunning = await expectJoinError(
    "join B while A is running",
    engine.joinGame(gameB.id, { roditId: "agent-1", displayName: "Agent One" }),
    "AGENT_IN_ACTIVE_GAME"
  );
  if (blockedRunning.details?.activeGameStatus !== "running") {
    throw new Error("expected activeGameStatus running");
  }

  await repo.updateGame(gameA.id, {
    status: "finished",
    phase: null,
    finished_at: new Date().toISOString()
  });

  const afterFinish = await engine.joinGame(gameB.id, {
    roditId: "agent-1",
    displayName: "Agent One"
  });
  if (!afterFinish?.id) {
    throw new Error("expected join B after A finished");
  }

  console.log("One active game per agent test passed.");
  await repo.closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
