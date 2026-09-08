#!/usr/bin/env node
/**
 * Unique displayName on join + aggregate water consumed tracking.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "display-name-water-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");

async function main() {
  await repo.initializeDatabase();

  const game = await engine.createGame({
    config: {
      minAgents: 2,
      maxAgents: 5,
      joiningWindowDurationMs: 0,
      negotiationDurationMs: 60_000,
      executionDurationMs: 60_000,
      useRandomStartingInventory: false,
      startingInventory: { energy: 200, water: 200, compute: 200 },
      cradleCapacityMin: 80,
      cradleCapacityMax: 80,
      survivalCost: { energy: 5, water: 5, compute: 5 },
      survivalCostTurnIncrement: 0,
      productionWaterCostRate: 0.1,
      finishSurvivorCount: 1
    }
  });

  await engine.joinGame(game.id, { roditId: "dn-alpha", displayName: "Aurora" });
  let clash = null;
  try {
    await engine.joinGame(game.id, { roditId: "dn-beta", displayName: " aurora " });
  } catch (err) {
    clash = err;
  }
  if (!clash || clash.code !== "DISPLAY_NAME_TAKEN") {
    throw new Error(`expected DISPLAY_NAME_TAKEN, got ${clash?.code || clash}`);
  }

  await engine.joinGame(game.id, { roditId: "dn-beta", displayName: "Borealis" });
  await engine.startGame(game.id);

  let afterStart = await repo.getGameById(game.id);
  if ((afterStart.aggregateWaterConsumed || 0) <= 0) {
    throw new Error("expected production water to increment aggregate after turn-1 production");
  }
  const afterProduction = afterStart.aggregateWaterConsumed;

  const agents = await repo.listAgents(game.id);
  await engine.beginExecutionPhase(game.id);
  for (const agent of agents) {
    await engine.submitAction(game.id, agent.id, { type: "none" });
  }

  const resolved = await repo.getGameById(game.id);
  if ((resolved.aggregateWaterConsumed || 0) <= afterProduction) {
    throw new Error(
      `expected survival water to increase aggregate (was ${afterProduction}, now ${resolved.aggregateWaterConsumed})`
    );
  }

  const state = await engine.getPublicState(game.id);
  if (state.game.aggregateWaterConsumed == null) {
    throw new Error("public state missing aggregateWaterConsumed");
  }

  console.log("✓ Unique display names + aggregate water tracking work");
  console.log(`  aggregateWaterConsumed=${resolved.aggregateWaterConsumed}`);
  await repo.closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
