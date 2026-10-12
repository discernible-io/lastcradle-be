#!/usr/bin/env node
/**
 * Verifies timed phase transitions advance turns with auto-defaults for absent players.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "phase-timers-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const scheduler = require("../src/game/scheduler");
const repo = require("../src/game/repository");

const PHASE_MS = 40;
const TIMED_CONFIG = {
  minAgents: 2,
  maxAgents: 2,
  joiningWindowDurationMs: 0,
  negotiationDurationMs: PHASE_MS,
  executionDurationMs: PHASE_MS,
  finishSurvivorCount: 1
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  await repo.initializeDatabase();

  const game = await engine.createGame({ config: TIMED_CONFIG });
  await engine.joinGame(game.id, { roditId: "p1", displayName: "P1" });
  await engine.joinGame(game.id, { roditId: "p2", displayName: "P2" });
  const started = await engine.startGame(game.id);
  scheduler.registerGame(started);

  if (started.phase !== "negotiation" || started.current_turn !== 1) {
    throw new Error("expected turn 1 negotiation after start");
  }

  const advanceDeadline = Date.now() + PHASE_MS * 2 + 200;
  let afterTurn = await repo.getGameById(game.id);
  while (afterTurn.current_turn < 2 && Date.now() < advanceDeadline) {
    await sleep(10);
    afterTurn = await repo.getGameById(game.id);
  }

  if (afterTurn.status !== "running") {
    throw new Error(`expected game still running, got ${afterTurn.status}`);
  }
  if (afterTurn.current_turn < 2) {
    throw new Error(`expected turn to advance past 1, got turn ${afterTurn.current_turn}`);
  }
  if (afterTurn.phase !== "negotiation" && afterTurn.phase !== "execution") {
    throw new Error(`expected negotiation or execution on turn ${afterTurn.current_turn}, got ${afterTurn.phase}`);
  }

  const state = await engine.getPublicState(game.id, { viewerAgentId: null });
  const aliveWithInventory = state.agents.filter(
    (a) => a.status === "alive" && a.inventory != null
  );
  if (aliveWithInventory.length > 0) {
    throw new Error("spectators must not see agent inventories");
  }
  scheduler.unregisterGame(game.id);

  const deadlineGame = await engine.createGame({
    config: {
      ...TIMED_CONFIG,
      maxTurns: 1,
      finishSurvivorCount: 1,
      negotiationDurationMs: 10,
      executionDurationMs: 10
    }
  });
  await engine.joinGame(deadlineGame.id, { roditId: "d1", displayName: "D1" });
  await engine.joinGame(deadlineGame.id, { roditId: "d2", displayName: "D2" });
  await engine.startGame(deadlineGame.id);
  await engine.beginExecutionPhase(deadlineGame.id);
  await engine.applyDefaultActionsForPendingAgents(deadlineGame.id);
  const turnDone = await engine.tryCompleteTurn(deadlineGame.id);
  if (!turnDone.turnCompleted) {
    throw new Error("expected turn 1 to complete with defaults");
  }
  const finishedGame = await repo.getGameById(deadlineGame.id);
  if (finishedGame.status !== "finished") {
    throw new Error("expected maxTurns=1 to force finish after turn 1");
  }
  if (finishedGame.current_turn !== 1) {
    throw new Error(`expected finish on turn 1, got turn ${finishedGame.current_turn}`);
  }

  console.log("Phase timer test passed.");
  scheduler.unregisterGame("all");
  await repo.closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
