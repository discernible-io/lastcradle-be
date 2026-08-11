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
      useSpecializedCradles: false,
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
      productionWaterCostRate: 0.1,
      storageEnergyCostRate: 0.1,
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
  if (oneRefreshed.productionCapacity.water !== one.productionCapacity.water + 10) {
    throw new Error("invest_production should grow water production by 10");
  }
  if (oneRefreshed.storageCapacity.water !== one.storageCapacity.water) {
    throw new Error("invest_production must not change storage");
  }

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

  if (!selfView.you?.actionHints || typeof selfView.you.actionHints.hiddenRivalCount !== "number") {
    throw new Error("viewer actionHints should include hiddenRivalCount");
  }
  if (selfView.you.actionHints.intelligenceMemoryTurns !== 2) {
    throw new Error("expected intelligenceMemoryTurns 2 on actionHints");
  }

  console.log("Smoke test passed.");

  await testIntelligenceMemoryWindow();
  await testSpecializedCradlesAndCombinedAction();
  await testSeparateStorageInvest();
  await testDualProductionAndStorageInvest();
  await testInvalidTransferRejected();
  await testMultiRecipientTransfers();

  await repo.closeDatabase();
}

async function testSeparateStorageInvest() {
  const game = await engine.createGame({
    config: {
      useRandomStartingInventory: false,
      startingInventory: { energy: 80, water: 80, compute: 80 },
      cradleCapacityMin: 100,
      cradleCapacityMax: 100,
      useSpecializedCradles: false,
      minAgents: 3,
      joiningWindowDurationMs: 0,
      productionWaterCostRate: 0,
      storageEnergyCostRate: 0,
      investProductionGainPerUnit: 1,
      investStorageGainPerUnit: 2,
      survivalCost: { energy: 1, water: 1, compute: 1 }
    }
  });

  await engine.joinGame(game.id, { roditId: "st1", displayName: "StOne" });
  await engine.joinGame(game.id, { roditId: "st2", displayName: "StTwo" });
  await engine.joinGame(game.id, { roditId: "st3", displayName: "StThree" });
  await engine.startGame(game.id);

  const agents = await repo.listAgents(game.id);
  const one = agents.find((a) => a.roditId === "st1");
  const two = agents.find((a) => a.roditId === "st2");
  const three = agents.find((a) => a.roditId === "st3");

  await engine.beginExecutionPhase(game.id);
  await engine.submitAction(game.id, one.id, buildInvestAction("energy", 5, "storage"));
  await engine.submitAction(game.id, two.id, { type: "none" });
  const completion = await engine.submitAction(game.id, three.id, { type: "none" });
  if (!completion.turnCompleted) throw new Error("storage invest turn did not complete");

  const oneAfter = await repo.getAgentById(one.id);
  if (oneAfter.storageCapacity.energy !== one.storageCapacity.energy + 10) {
    throw new Error(
      `invest_storage should grow energy storage by 10, got ${oneAfter.storageCapacity.energy}`
    );
  }
  if (oneAfter.productionCapacity.energy !== one.productionCapacity.energy) {
    throw new Error("invest_storage must not change production");
  }

  console.log("Separate storage invest test passed.");
}

async function testDualProductionAndStorageInvest() {
  const { buildDualInvestAction } = require("../src/game/defaults");
  const game = await engine.createGame({
    config: {
      useRandomStartingInventory: false,
      startingInventory: { energy: 100, water: 100, compute: 100 },
      cradleCapacityMin: 100,
      cradleCapacityMax: 100,
      useSpecializedCradles: false,
      minAgents: 3,
      joiningWindowDurationMs: 0,
      productionWaterCostRate: 0,
      storageEnergyCostRate: 0,
      investProductionGainPerUnit: 1,
      investStorageGainPerUnit: 2,
      survivalCost: { energy: 1, water: 1, compute: 1 }
    }
  });

  await engine.joinGame(game.id, { roditId: "du1", displayName: "DuOne" });
  await engine.joinGame(game.id, { roditId: "du2", displayName: "DuTwo" });
  await engine.joinGame(game.id, { roditId: "du3", displayName: "DuThree" });
  await engine.startGame(game.id);

  const agents = await repo.listAgents(game.id);
  const one = agents.find((a) => a.roditId === "du1");
  const two = agents.find((a) => a.roditId === "du2");
  const three = agents.find((a) => a.roditId === "du3");

  await engine.beginExecutionPhase(game.id);
  await engine.submitAction(
    game.id,
    one.id,
    buildDualInvestAction({
      production: { target: "water", amount: 4 },
      storage: { target: "energy", amount: 3 }
    })
  );
  await engine.submitAction(game.id, two.id, { type: "none" });
  const completion = await engine.submitAction(game.id, three.id, { type: "none" });
  if (!completion.turnCompleted) throw new Error("dual invest turn did not complete");

  const oneAfter = await repo.getAgentById(one.id);
  if (oneAfter.productionCapacity.water !== one.productionCapacity.water + 4) {
    throw new Error("dual invest should grow water production by 4");
  }
  if (oneAfter.storageCapacity.water !== one.storageCapacity.water) {
    throw new Error("water storage must be unchanged when only water production was invested");
  }
  if (oneAfter.storageCapacity.energy !== one.storageCapacity.energy + 6) {
    throw new Error("dual invest should grow energy storage by 6 (3×2)");
  }
  if (oneAfter.productionCapacity.energy !== one.productionCapacity.energy) {
    throw new Error("energy production must be unchanged when only energy storage was invested");
  }

  const actions = await repo.listTurnActions(game.id, 1);
  const row = actions.find((a) => a.agent_id === one.id);
  const payload = repo.parseJson(row.payload_json, {});
  if (payload.type !== "invest" || !payload.production || !payload.storage) {
    throw new Error(`Expected dual invest payload, got ${JSON.stringify(payload)}`);
  }

  console.log("Dual production+storage invest test passed.");
}

async function testIntelligenceMemoryWindow() {
  const game = await engine.createGame({
    config: {
      useRandomStartingInventory: false,
      startingInventory: { energy: 80, water: 80, compute: 80 },
      cradleCapacityMin: 100,
      cradleCapacityMax: 100,
      useSpecializedCradles: false,
      minAgents: 3,
      joiningWindowDurationMs: 0,
      productionWaterCostRate: 0,
      storageEnergyCostRate: 0,
      survivalCost: { energy: 1, water: 1, compute: 1 },
      intelligenceMemoryTurns: 2
    }
  });

  await engine.joinGame(game.id, { roditId: "mem-a", displayName: "MemA" });
  await engine.joinGame(game.id, { roditId: "mem-b", displayName: "MemB" });
  await engine.joinGame(game.id, { roditId: "mem-c", displayName: "MemC" });
  await engine.startGame(game.id);

  const agents = await repo.listAgents(game.id);
  const one = agents.find((a) => a.roditId === "mem-a");
  const two = agents.find((a) => a.roditId === "mem-b");
  const three = agents.find((a) => a.roditId === "mem-c");

  // Turn 1: two scouts one (find 2 > hide 0)
  await engine.beginExecutionPhase(game.id);
  await engine.submitAction(game.id, one.id, { type: "none" });
  await engine.submitAction(game.id, two.id, {
    type: "none",
    find: [{ targetAgentId: one.id, compute: 2 }]
  });
  const turn1 = await engine.submitAction(game.id, three.id, { type: "none" });
  if (!turn1.turnCompleted) throw new Error("turn 1 did not complete");

  let state = await engine.getPublicState(game.id, { viewerAgentId: two.id });
  let viewOfOne = state.agents.find((a) => a.id === one.id);
  if (viewOfOne.intelligenceHidden || !viewOfOne.inventory) {
    throw new Error("after turn 1, find should reveal one to two");
  }
  if (state.you.actionHints.hiddenRivalCount < 1) {
    // three still hidden
    throw new Error("expected at least one hidden rival (three) after scouting one");
  }

  // Turn 2: no find, no hide — memory window still includes turn 1
  await engine.beginExecutionPhase(game.id);
  await engine.submitAction(game.id, one.id, { type: "none" });
  await engine.submitAction(game.id, two.id, { type: "none" });
  const turn2 = await engine.submitAction(game.id, three.id, { type: "none" });
  if (!turn2.turnCompleted) throw new Error("turn 2 did not complete");

  state = await engine.getPublicState(game.id, { viewerAgentId: two.id });
  viewOfOne = state.agents.find((a) => a.id === one.id);
  if (viewOfOne.intelligenceHidden || !viewOfOne.inventory) {
    throw new Error("memory window should keep turn-1 find visible on turn 3 state");
  }

  // Turn 3: still no find — window is turns 2–3 only; fog returns
  await engine.beginExecutionPhase(game.id);
  await engine.submitAction(game.id, one.id, { type: "none" });
  await engine.submitAction(game.id, two.id, { type: "none" });
  const turn3 = await engine.submitAction(game.id, three.id, { type: "none" });
  if (!turn3.turnCompleted) throw new Error("turn 3 did not complete");

  state = await engine.getPublicState(game.id, { viewerAgentId: two.id });
  viewOfOne = state.agents.find((a) => a.id === one.id);
  if (!viewOfOne.intelligenceHidden || viewOfOne.inventory != null) {
    throw new Error("after window slides past turn 1, one should be hidden again");
  }

  // Hide escalation: find then target out-hides on the only window turns
  await engine.beginExecutionPhase(game.id);
  await engine.submitAction(game.id, one.id, { type: "none", hide: 3 });
  await engine.submitAction(game.id, two.id, {
    type: "none",
    find: [{ targetAgentId: one.id, compute: 1 }]
  });
  const turn4 = await engine.submitAction(game.id, three.id, { type: "none" });
  if (!turn4.turnCompleted) throw new Error("turn 4 did not complete");

  state = await engine.getPublicState(game.id, { viewerAgentId: two.id });
  viewOfOne = state.agents.find((a) => a.id === one.id);
  // Window turns 3–4: turn 3 no find, turn 4 find 1 <= hide 3 → still hidden
  if (!viewOfOne.intelligenceHidden) {
    throw new Error("hide 3 should beat find 1 within the memory window");
  }

  console.log("Intelligence memory window test passed.");
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
      cradleStockpileStorageMinRatio: 2.0,
      cradleStockpileStorageMaxRatio: 2.0,
      minAgents: 3,
      joiningWindowDurationMs: 0,
      productionWaterCostRate: 0,
      storageEnergyCostRate: 0,
      investProductionGainPerUnit: 1,
      investStorageGainPerUnit: 1,
      survivalCost: { energy: 1, water: 1, compute: 1 }
    }
  });

  await engine.joinGame(game.id, { roditId: "sp1", displayName: "SpOne" });
  await engine.joinGame(game.id, { roditId: "sp2", displayName: "SpTwo" });
  await engine.joinGame(game.id, { roditId: "sp3", displayName: "SpThree" });

  const agents = await repo.listAgents(game.id);
  const joinSpecialties = [];
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
    joinSpecialties.push(specialties[0]);
    if (secondaries.length !== 2) {
      throw new Error(`Expected two secondaries, got ${secondaries.join(",")}`);
    }
    if (agent.productionCapacity[specialties[0]] !== 120) {
      throw new Error(`Specialty prod should be 80*1.5=120, got ${agent.productionCapacity[specialties[0]]}`);
    }
    if (agent.storageCapacity[specialties[0]] !== 80) {
      throw new Error(`Specialty storage should stay at base 80, got ${agent.storageCapacity[specialties[0]]}`);
    }
    for (const k of secondaries) {
      if (agent.productionCapacity[k] !== 40) {
        throw new Error(`Secondary prod should be 40, got ${agent.productionCapacity[k]} for ${k}`);
      }
    }
    const stockpiles = secondaries.filter((k) => agent.storageCapacity[k] === 160);
    const baseSecondaries = secondaries.filter((k) => agent.storageCapacity[k] === 80);
    if (stockpiles.length !== 1 || baseSecondaries.length !== 1) {
      throw new Error(
        `Expected one stockpile storage=160 and one base secondary storage=80, got ${JSON.stringify(
          Object.fromEntries(secondaries.map((k) => [k, agent.storageCapacity[k]]))
        )}`
      );
    }
  }
  const expectedRoundRobin = ["energy", "water", "compute"];
  for (let i = 0; i < joinSpecialties.length; i++) {
    if (joinSpecialties[i] !== expectedRoundRobin[i]) {
      throw new Error(
        `Expected round-robin specialties ${expectedRoundRobin.join(" → ")}, got ${joinSpecialties.join(" → ")}`
      );
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
  if (!self.nextTurnSurvivalCost || !self.actionHints.nextTurnSurvivalCost) {
    throw new Error("Expected nextTurnSurvivalCost on viewer and actionHints");
  }
  if (!self.actionHints.survivalCostPerTurnIncrement) {
    throw new Error("Expected survivalCostPerTurnIncrement on actionHints");
  }
  if (!(self.nextTurnSurvivalCost.energy > self.thisTurnSurvivalCost.energy)) {
    throw new Error("nextTurnSurvivalCost should exceed thisTurnSurvivalCost while rivals remain");
  }
  const keys = ["energy", "water", "compute"];
  const specialties = keys.filter((k) => one.productionCapacity[k] > one.storageCapacity[k]);
  if (self.specialty !== specialties[0]) {
    throw new Error(`state specialty ${self.specialty} != derived ${specialties[0]}`);
  }

  await engine.beginExecutionPhase(game.id);
  await engine.submitAction(game.id, one.id, {
    type: "transfer_and_invest_production",
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
  if (
    !combined ||
    combined.action_type !== "transfer_and_invest" ||
    combined.status !== "executed"
  ) {
    throw new Error(`Expected executed transfer_and_invest, got ${JSON.stringify(combined)}`);
  }
  const payload = repo.parseJson(combined.payload_json, {});
  if (payload.transfer?.toAgentId !== two.id || payload.transfer?.energy !== 10) {
    throw new Error(`Unexpected transfer payload: ${JSON.stringify(payload.transfer)}`);
  }
  if (!Array.isArray(payload.transfers) || payload.transfers.length !== 1) {
    throw new Error(`Expected transfers[] mirror, got ${JSON.stringify(payload.transfers)}`);
  }
  if (payload.production?.target !== "water" || payload.production?.energy !== 5) {
    throw new Error(`Unexpected production invest: ${JSON.stringify(payload.production)}`);
  }
  // Turn advances and applies next-turn production before we read; capacity growth is the stable signal.
  if (oneAfter.productionCapacity.water !== one.productionCapacity.water + 5) {
    throw new Error("Production invest should grow water production by 5");
  }
  if (oneAfter.storageCapacity.water !== one.storageCapacity.water) {
    throw new Error("Production invest must not change water storage");
  }

  console.log("Specialized cradles + transfer_and_invest (production) test passed.");
}

async function testInvalidTransferRejected() {
  const game = await engine.createGame({
    config: {
      useRandomStartingInventory: false,
      startingInventory: { energy: 80, water: 80, compute: 80 },
      cradleCapacityMin: 100,
      cradleCapacityMax: 100,
      useSpecializedCradles: false,
      minAgents: 3,
      joiningWindowDurationMs: 0,
      survivalCost: { energy: 5, water: 5, compute: 5 }
    }
  });

  await engine.joinGame(game.id, { roditId: "it1", displayName: "ItOne" });
  await engine.joinGame(game.id, { roditId: "it2", displayName: "ItTwo" });
  await engine.joinGame(game.id, { roditId: "it3", displayName: "ItThree" });
  await engine.startGame(game.id);

  const agents = await repo.listAgents(game.id);
  const one = agents.find((a) => a.roditId === "it1");
  const two = agents.find((a) => a.roditId === "it2");
  const running = await repo.getGameById(game.id);

  await engine.beginExecutionPhase(game.id);

  async function expectInvalidTransfer(label, action) {
    try {
      await engine.submitAction(game.id, one.id, action);
      throw new Error(`${label}: expected INVALID_TRANSFER`);
    } catch (err) {
      if (err.code !== "INVALID_TRANSFER") {
        throw new Error(`${label}: expected INVALID_TRANSFER, got ${err.code || err.message}`);
      }
      if (!err.details?.reason) {
        throw new Error(`${label}: expected details.reason, got ${JSON.stringify(err.details)}`);
      }
    }
  }

  await expectInvalidTransfer("bad ULID on transfer", {
    type: "transfer",
    toAgentId: "not-a-real-agent-id",
    energy: 5,
    water: 0,
    compute: 0
  });

  await expectInvalidTransfer("displayName as toAgentId", {
    type: "transfer",
    toAgentId: two.displayName,
    energy: 5,
    water: 0,
    compute: 0
  });

  await expectInvalidTransfer("rodit id as toAgentId", {
    type: "transfer",
    toAgentId: two.roditId,
    energy: 5,
    water: 0,
    compute: 0
  });

  await expectInvalidTransfer("self transfer", {
    type: "transfer",
    toAgentId: one.id,
    energy: 5,
    water: 0,
    compute: 0
  });

  await expectInvalidTransfer("bad ULID on transfer_and_invest_production (must not downgrade to invest)", {
    type: "transfer_and_invest_production",
    transfer: { toAgentId: "01FAKEINVALIDTRANSFERULIDXX", energy: 10, water: 0, compute: 0 },
    invest: { target: "water", amount: 5 }
  });

  const actions = await repo.listTurnActions(game.id, running.current_turn);
  const fromOne = actions.filter((a) => a.agent_id === one.id);
  if (fromOne.length !== 0) {
    throw new Error(
      `Invalid transfers must not store an action; got ${fromOne.length}: ${JSON.stringify(fromOne)}`
    );
  }

  await engine.submitAction(game.id, one.id, {
    type: "transfer",
    toAgentId: two.id,
    energy: 5,
    water: 0,
    compute: 0
  });

  console.log("Invalid transfer rejection test passed.");
}

async function testMultiRecipientTransfers() {
  const game = await engine.createGame({
    config: {
      useRandomStartingInventory: false,
      startingInventory: { energy: 100, water: 100, compute: 100 },
      cradleCapacityMin: 200,
      cradleCapacityMax: 200,
      useSpecializedCradles: false,
      minAgents: 3,
      maxAgents: 4,
      maxTransferRecipients: 2,
      joiningWindowDurationMs: 0,
      survivalCost: { energy: 1, water: 1, compute: 1 },
      investProductionGainPerUnit: 1,
      investStorageGainPerUnit: 1
    }
  });

  await engine.joinGame(game.id, { roditId: "mr1", displayName: "MrOne" });
  await engine.joinGame(game.id, { roditId: "mr2", displayName: "MrTwo" });
  await engine.joinGame(game.id, { roditId: "mr3", displayName: "MrThree" });
  await engine.startGame(game.id);

  const agents = await repo.listAgents(game.id);
  const one = agents.find((a) => a.roditId === "mr1");
  const two = agents.find((a) => a.roditId === "mr2");
  const three = agents.find((a) => a.roditId === "mr3");

  const hints = await engine.getPublicState(game.id, { viewerAgentId: one.id });
  if (hints.you?.actionHints?.maxTransferRecipients !== 2) {
    throw new Error(
      `Expected actionHints.maxTransferRecipients=2, got ${hints.you?.actionHints?.maxTransferRecipients}`
    );
  }

  await engine.beginExecutionPhase(game.id);

  try {
    await engine.submitAction(game.id, one.id, {
      type: "transfer",
      transfers: [
        { toAgentId: two.id, energy: 1, water: 0, compute: 0 },
        { toAgentId: three.id, energy: 1, water: 0, compute: 0 },
        { toAgentId: two.id, energy: 1, water: 0, compute: 0 }
      ]
    });
    throw new Error("expected too_many_recipients or duplicate");
  } catch (err) {
    if (err.code !== "INVALID_TRANSFER") {
      throw new Error(`cap/dup: expected INVALID_TRANSFER, got ${err.code || err.message}`);
    }
    if (err.details?.reason !== "too_many_recipients") {
      throw new Error(`expected too_many_recipients, got ${JSON.stringify(err.details)}`);
    }
  }

  try {
    await engine.submitAction(game.id, one.id, {
      type: "transfer",
      transfers: [
        { toAgentId: two.id, energy: 1, water: 0, compute: 0 },
        { toAgentId: two.id, energy: 2, water: 0, compute: 0 }
      ]
    });
    throw new Error("expected duplicate_recipient");
  } catch (err) {
    if (err.code !== "INVALID_TRANSFER" || err.details?.reason !== "duplicate_recipient") {
      throw new Error(`expected duplicate_recipient, got ${err.code} ${JSON.stringify(err.details)}`);
    }
  }

  await engine.submitAction(game.id, one.id, {
    type: "transfer_and_invest_production",
    transfers: [
      { toAgentId: two.id, energy: 10, water: 0, compute: 0 },
      { toAgentId: three.id, energy: 0, water: 7, compute: 0 }
    ],
    invest: { target: "compute", amount: 3 }
  });
  await engine.submitAction(game.id, two.id, { type: "none" });
  const completion = await engine.submitAction(game.id, three.id, { type: "none" });
  if (!completion.turnCompleted) {
    throw new Error("multi-recipient turn did not complete");
  }

  const actions = await repo.listTurnActions(game.id, 1);
  const row = actions.find((a) => a.agent_id === one.id);
  const payload = repo.parseJson(row.payload_json, {});
  if (payload.type !== "transfer_and_invest" || payload.transfers?.length !== 2) {
    throw new Error(`Unexpected multi payload: ${JSON.stringify(payload)}`);
  }
  if (payload.transfer) {
    throw new Error("Multi-leg actions must not mirror single transfer field");
  }

  const trades = await repo.listPublicTrades(game.id, 1);
  if (trades.length !== 2) {
    throw new Error(`Expected 2 public trade legs, got ${trades.length}`);
  }
  const byTo = new Map(trades.map((t) => [t.toAgentId, t]));
  if (byTo.get(two.id)?.energy !== 10 || byTo.get(three.id)?.water !== 7) {
    throw new Error(`Unexpected trade legs: ${JSON.stringify(trades)}`);
  }

  const oneAfter = await repo.getAgentById(one.id);
  if (oneAfter.productionCapacity.compute !== one.productionCapacity.compute + 3) {
    throw new Error("Invest after multi-transfer should grow compute production by 3");
  }
  if (oneAfter.storageCapacity.compute !== one.storageCapacity.compute) {
    throw new Error("Production invest must not change compute storage");
  }

  console.log("Multi-recipient transfer test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
