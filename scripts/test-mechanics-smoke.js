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

async function testOpeningInventoryScout() {
  const scoutGame = await engine.createGame({
    config: {
      useRandomStartingInventory: false,
      startingInventory: { energy: 80, water: 80, compute: 80 },
      cradleCapacityMin: 100,
      cradleCapacityMax: 100,
      minAgents: 3,
      joiningWindowDurationMs: 0
    }
  });

  await engine.joinGame(scoutGame.id, { roditId: "scout-a", displayName: "A" });
  await engine.joinGame(scoutGame.id, { roditId: "scout-b", displayName: "B" });
  await engine.joinGame(scoutGame.id, { roditId: "scout-c", displayName: "C" });

  const joined = await repo.listAgents(scoutGame.id);
  const scoutAgent = joined.find((a) => a.roditId === "scout-b");
  // Lowest fill ratio (0.5 vs 0.8) — not merely lowest absolute total among equal capacities.
  await repo.updateAgentInventory(scoutAgent.id, { energy: 50, water: 50, compute: 50 });

  await engine.startGame(scoutGame.id);

  const scoutView = await engine.getPublicState(scoutGame.id, { viewerAgentId: scoutAgent.id });
  const otherAgent = joined.find((a) => a.roditId === "scout-a");
  const otherView = await engine.getPublicState(scoutGame.id, { viewerAgentId: otherAgent.id });

  if (!scoutView.openingInventoryReport) {
    throw new Error("Lowest-fill-ratio player should receive openingInventoryReport");
  }
  if (scoutView.openingInventoryReport.agents.length !== 3) {
    throw new Error("Opening inventory report should list every cradle");
  }
  const scoutEntry = scoutView.openingInventoryReport.agents.find((e) => e.agentId === scoutAgent.id);
  if (!scoutEntry || scoutEntry.total !== 150) {
    throw new Error("Report should snapshot pre-production opening inventories");
  }
  if (Math.abs((scoutEntry.fillRatio ?? 0) - 0.5) > 1e-9) {
    throw new Error("Report should include fillRatio for the scout cradle");
  }
  if (otherView.openingInventoryReport) {
    throw new Error("Only the opening-inventory scout may receive the report");
  }

  console.log("Opening inventory scout test passed.");
}

async function main() {
  await repo.initializeDatabase();

  await testOpeningInventoryScout();

  const game = await engine.createGame({
    config: {
      useRandomStartingInventory: false,
      startingInventory: { energy: 80, water: 80, compute: 80 },
      cradleCapacityMin: 100,
      cradleCapacityMax: 100,
      useSpecializedCradles: false,
      minAgents: 3,
      joiningWindowDurationMs: 0,
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

  await engine.beginExecutionPhase(game.id);

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

  await testSpecializedCradlesAndCombinedAction();

  await repo.closeDatabase();
}

async function testSpecializedCradlesAndCombinedAction() {
  const game = await engine.createGame({
    config: {
      useRandomStartingInventory: false,
      startingInventory: { energy: 100, water: 100, compute: 100 },
      cradleCapacityMin: 80,
      cradleCapacityMax: 80,
      useSpecializedCradles: true,
      cradleSpecialtyProductionMinRatio: 1.5,
      cradleSpecialtyProductionMaxRatio: 1.5,
      cradleSecondaryProductionMinRatio: 0.5,
      cradleSecondaryProductionMaxRatio: 0.5,
      minAgents: 3,
      joiningWindowDurationMs: 0,
      productionEnergyCostRate: 0,
      storageWaterCostRate: 0,
      investProductionGainPerUnit: 1,
      investStorageGainPerUnit: 1,
      survivalCost: { energy: 1, water: 1, compute: 1 }
    }
  });

  await engine.joinGame(game.id, { roditId: "sp1", displayName: "SpOne" });
  await engine.joinGame(game.id, { roditId: "sp2", displayName: "SpTwo" });
  await engine.joinGame(game.id, { roditId: "sp3", displayName: "SpThree" });

  const agents = await repo.listAgents(game.id);
  for (const agent of agents) {
    const keys = ["energy", "water", "compute"];
    const specialties = keys.filter(
      (k) => agent.productionCapacity[k] > agent.storageCapacity[k]
    );
    const secondaries = keys.filter(
      (k) => agent.productionCapacity[k] < agent.storageCapacity[k]
    );
    if (specialties.length !== 1) {
      throw new Error(`Expected exactly one specialty, got ${specialties.join(",")}`);
    }
    if (secondaries.length !== 2) {
      throw new Error(`Expected two secondaries, got ${secondaries.join(",")}`);
    }
    if (agent.productionCapacity[specialties[0]] !== 120) {
      throw new Error(`Specialty prod should be 80*1.5=120, got ${agent.productionCapacity[specialties[0]]}`);
    }
    for (const k of secondaries) {
      if (agent.productionCapacity[k] !== 40) {
        throw new Error(`Secondary prod should be 40, got ${agent.productionCapacity[k]} for ${k}`);
      }
    }
  }

  await engine.startGame(game.id);
  const [one, two, three] = [
    agents.find((a) => a.roditId === "sp1"),
    agents.find((a) => a.roditId === "sp2"),
    agents.find((a) => a.roditId === "sp3")
  ];

  const selfState = await engine.getPublicState(game.id, { viewerAgentId: one.id });
  const self = selfState.you;
  if (!self?.specialty || self.surplusByResource[self.specialty] <= 0) {
    throw new Error(`Expected specialty surplus on state.you, got ${JSON.stringify(self)}`);
  }
  if (!self.wasteIfNotExportedByNextProduction || !self.thisTurnSurvivalCost || !self.actionHints) {
    throw new Error("Expected waste/survival/actionHints on viewer state");
  }
  const keys = ["energy", "water", "compute"];
  const specialties = keys.filter((k) => one.productionCapacity[k] > one.storageCapacity[k]);
  if (self.specialty !== specialties[0]) {
    throw new Error(`state specialty ${self.specialty} != derived ${specialties[0]}`);
  }

  await engine.beginExecutionPhase(game.id);
  await engine.submitAction(game.id, one.id, {
    type: "transfer_and_invest",
    transfer: { toAgentId: two.id, energy: 10, water: 0, compute: 0 },
    invest: { target: "water", amount: 5 }
  });
  await engine.submitAction(game.id, two.id, { type: "none" });
  const completion = await engine.submitAction(game.id, three.id, { type: "none" });
  if (!completion.turnCompleted) {
    throw new Error("Combined-action turn did not complete");
  }

  const oneAfter = await repo.getAgentById(one.id);
  const actions = await repo.listTurnActions(game.id, 1);
  const combined = actions.find((a) => a.agent_id === one.id);
  if (!combined || combined.action_type !== "transfer_and_invest" || combined.status !== "executed") {
    throw new Error(`Expected executed transfer_and_invest, got ${JSON.stringify(combined)}`);
  }
  const payload = repo.parseJson(combined.payload_json, {});
  if (payload.transfer?.toAgentId !== two.id || payload.transfer?.energy !== 10) {
    throw new Error(`Unexpected transfer payload: ${JSON.stringify(payload.transfer)}`);
  }
  if (payload.invest?.target !== "water" || payload.invest?.energy !== 5) {
    throw new Error(`Unexpected invest payload: ${JSON.stringify(payload.invest)}`);
  }
  // Turn advances and applies next-turn production before we read; capacity growth is the stable signal.
  if (oneAfter.productionCapacity.water !== one.productionCapacity.water + 5) {
    throw new Error("Invest portion should grow water production by 5");
  }
  if (oneAfter.storageCapacity.water !== one.storageCapacity.water + 5) {
    throw new Error("Invest portion should grow water storage by 5");
  }

  console.log("Specialized cradles + transfer_and_invest test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
