#!/usr/bin/env node
/**
 * Smoke test for redesigned production/storage/survival/intelligence mechanics.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "mechanics-smoke.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const { buildInvestAction } = require("../src/game/defaults");

async function main() {
  await repo.initializeDatabase();

  const game = await engine.createGame({
    config: {
      useRandomStartingInventory: false,
      startingInventory: { energy: 80, water: 80, compute: 80 },
      territoryCapacityMin: 50,
      territoryCapacityMax: 50,
      minAgents: 3,
      productionEnergyCostRate: 0.1,
      storageWaterCostRate: 0.1,
      investProductionGainPerUnit: 1,
      investStorageGainPerUnit: 2,
      survivalCost: { energy: 5, water: 5, compute: 5 }
    }
  });

  await engine.joinGame(game.id, { roditId: "p1", displayName: "One" });
  await engine.joinGame(game.id, { roditId: "p2", displayName: "Two" });
  await engine.joinGame(game.id, { roditId: "p3", displayName: "Three" });
  await engine.startGame(game.id);

  const agents = await repo.listAgents(game.id);
  const one = agents.find((a) => a.roditId === "p1");
  const two = agents.find((a) => a.roditId === "p2");
  const three = agents.find((a) => a.roditId === "p3");

  await engine.beginMessageReportPhase(game.id);
  for (const a of agents) {
    await engine.submitMessageReport(game.id, a.id, { sent: 0, received: 0 });
  }

  await engine.submitAction(game.id, one.id, {
    ...buildInvestAction("water", 10),
    hide: 5
  });
  await engine.submitAction(game.id, two.id, {
    type: "none",
    find: [{ targetAgentId: one.id, compute: 5 }]
  });
  const completion = await engine.submitAction(game.id, three.id, { type: "none" });
  if (!completion.turnCompleted) throw new Error("Turn did not complete");

  const oneRefreshed = await repo.getAgentById(one.id);
  console.log("After invest/hide:", {
    inventory: oneRefreshed.inventory,
    production: oneRefreshed.productionCapacity,
    storage: oneRefreshed.storageCapacity
  });

  const hiddenFromTwo = await engine.getPublicState(game.id, { viewerAgentId: two.id });
  const viewOfOne = hiddenFromTwo.agents.find((a) => a.id === one.id);
  console.log("Two sees One hidden (find 5 vs hide 5, tie):", viewOfOne.intelligenceHidden === true);
  console.log("Two sees One inventory hidden:", viewOfOne.inventory === null);

  const foundFromThree = await engine.getPublicState(game.id, { viewerAgentId: three.id });
  const viewOfOneFromThree = foundFromThree.agents.find((a) => a.id === one.id);
  console.log("Three sees One hidden (no find spend):", viewOfOneFromThree.intelligenceHidden === true);
  console.log("Three sees One inventory hidden:", viewOfOneFromThree.inventory === null);

  const selfView = await engine.getPublicState(game.id, { viewerAgentId: two.id });
  const viewOfSelf = selfView.agents.find((a) => a.id === two.id);
  console.log("Two sees own inventory:", viewOfSelf.inventory !== null);

  console.log("Smoke test passed.");
  await repo.closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
