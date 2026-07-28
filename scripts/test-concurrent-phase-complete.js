#!/usr/bin/env node
/**
 * Regression: concurrent last-submit must not report "nobody submitted"
 * after a peer already advanced the turn (execution phase).
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "concurrent-phase-complete.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");

async function setupRunningGame() {
  const game = await engine.createGame({
    config: {
      minAgents: 3,
      maxAgents: 5,
      joiningWindowDurationMs: 0,
      executionDurationMs: 0,
      useRandomStartingInventory: false,
      startingInventory: { energy: 80, water: 80, compute: 80 },
      survivalCost: { energy: 1, water: 1, compute: 1 }
    }
  });

  await engine.joinGame(game.id, { roditId: "r1", displayName: "One" });
  await engine.joinGame(game.id, { roditId: "r2", displayName: "Two" });
  await engine.joinGame(game.id, { roditId: "r3", displayName: "Three" });
  await engine.startGame(game.id);

  const agents = await repo.listAgents(game.id);
  return { gameId: game.id, agents };
}

async function testLateTryCompleteTurnSeesSuccess() {
  const { gameId, agents } = await setupRunningGame();
  await engine.beginExecutionPhase(gameId);

  const [a, b, c] = agents;
  await engine.submitAction(gameId, a.id, { type: "none" });
  await engine.submitAction(gameId, b.id, { type: "none" });

  // Last submitter wins and advances the turn.
  const winner = await engine.submitAction(gameId, c.id, { type: "none" });
  if (!winner.turnCompleted) {
    throw new Error("Expected last submitter to complete the turn");
  }

  // Simulate a concurrent loser that upserted then called tryCompleteTurn after advance.
  const late = await engine.tryCompleteTurn(gameId);
  if (!late.turnCompleted) {
    throw new Error(`Late tryCompleteTurn should report turnCompleted=true, got ${JSON.stringify(late)}`);
  }
  if (late.execution !== null) {
    throw new Error(`Late tryCompleteTurn must not return next-turn pending lists, got ${JSON.stringify(late.execution)}`);
  }

  console.log("Late tryCompleteTurn race test passed.");
}

async function testConcurrentAllSubmitAdvancesOnce() {
  const { gameId, agents } = await setupRunningGame();
  await engine.beginExecutionPhase(gameId);

  const results = await Promise.all(
    agents.map((a) => engine.submitAction(gameId, a.id, { type: "none" }))
  );

  const completed = results.filter((r) => r.turnCompleted);
  if (completed.length < 1) {
    throw new Error("Expected at least one concurrent submitter to see turnCompleted=true");
  }
  for (const r of results) {
    if (r.turnCompleted && r.execution !== null) {
      throw new Error("Completed responses must not include execution pending lists");
    }
    if (!r.turnCompleted && r.execution?.pendingAgentIds?.length === agents.length) {
      throw new Error("Loser must not report every living agent as pending");
    }
  }

  const game = await repo.getGameById(gameId);
  if (game.phase !== "negotiation" && game.status !== "finished") {
    throw new Error(`Expected negotiation/finished after concurrent submit, got phase=${game.phase}`);
  }

  console.log("Concurrent all-submit advance test passed.");
}

async function main() {
  await repo.initializeDatabase();
  await testLateTryCompleteTurnSeesSuccess();
  await testConcurrentAllSubmitAdvancesOnce();
  console.log("All concurrent phase-complete tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
