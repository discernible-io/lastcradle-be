#!/usr/bin/env node
/**
 * Regression: maxInvestAmountAfterSurvival must reserve post-execution storage energy.
 * Also covers storage readouts on actionHints and outbound action projections.
 */

const {
  buildActionHints,
  maxEqualInvestPreservingSurvival,
  applyStorageCost,
  projectActionOutcome,
  normalizeInvestAction,
  assessSurvivalRisk,
  projectRunway
} = require("../src/game/engine");
const { DEFAULT_GAME_CONFIG } = require("../src/game/defaults");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function inventoryAfterEqualInvest(inv, n) {
  return {
    energy: inv.energy - n,
    water: inv.water - n,
    compute: inv.compute - n
  };
}

function survivesAfterInvest(inv, n, survival, config) {
  const afterInvest = inventoryAfterEqualInvest(inv, n);
  const afterStorage = applyStorageCost(
    afterInvest,
    { energy: 1000, water: 1000, compute: 1000 },
    config
  );
  return (
    afterStorage.energy >= survival.energy &&
    afterStorage.water >= survival.water &&
    afterStorage.compute >= survival.compute
  );
}

function main() {
  const config = {
    ...DEFAULT_GAME_CONFIG,
    storageEnergyCostRate: 0.1
  };
  // Water-heavy cradle: survival-only invest leaves energy short after storage tax
  const inventory = { energy: 73, water: 82, compute: 95 };
  const survival = { energy: 11, water: 11, compute: 11 };

  const oldSurvivalOnlyHint = Math.floor(
    Math.min(
      inventory.energy - survival.energy,
      inventory.water - survival.water,
      inventory.compute - survival.compute
    )
  );
  assert(oldSurvivalOnlyHint === 62, `expected old trap hint 62, got ${oldSurvivalOnlyHint}`);
  assert(
    !survivesAfterInvest(inventory, oldSurvivalOnlyHint, survival, config),
    "old hint 62 must be lethal once storage energy is applied"
  );

  const safe = maxEqualInvestPreservingSurvival(inventory, survival, config);
  assert(safe === 55.375, `expected fractional safe 55.375, got ${safe}`);
  assert(safe < oldSurvivalOnlyHint, `safe hint ${safe} should be below old ${oldSurvivalOnlyHint}`);
  assert(survivesAfterInvest(inventory, safe, survival, config), `safe hint ${safe} must survive`);
  assert(
    !survivesAfterInvest(inventory, safe + 0.0001, survival, config),
    `safe+0.0001 (${safe + 0.0001}) must be lethal (hint is tight to 4dp)`
  );
  assert(
    !survivesAfterInvest(inventory, Math.floor(safe) + 1, survival, config),
    `integer ceil of safe (${Math.floor(safe) + 1}) must still be lethal`
  );

  // Fractional inventory leftovers should not be trapped at whole units
  const fractionalInv = { energy: 20.75, water: 40.5, compute: 30.25 };
  const fracMax = maxEqualInvestPreservingSurvival(fractionalInv, survival, config);
  assert(fracMax > 0 && fracMax % 1 !== 0, `fractional inventory should yield non-integer max, got ${fracMax}`);
  assert(
    survivesAfterInvest(fractionalInv, fracMax, survival, config),
    `fractional max ${fracMax} must survive`
  );
  assert(
    !survivesAfterInvest(fractionalInv, fracMax + 0.0001, survival, config),
    `fractional max+epsilon must be lethal`
  );

  const fracHints = buildActionHints(fractionalInv, survival, config);
  assert(
    fracHints.maxInvestAmount === 20.75,
    `maxInvestAmount should keep fractions, got ${fracHints.maxInvestAmount}`
  );
  assert(
    fracHints.maxInvestAmountAfterSurvival === fracMax,
    "fractional actionHints must match helper"
  );

  const productionCapacity = { energy: 40, water: 12, compute: 10 };
  const storageCapacity = { energy: 30, water: 40, compute: 40 };
  const hints = buildActionHints(inventory, survival, config, {
    productionCapacity,
    storageCapacity,
    nextTurnSurvivalCost: { energy: 15.8, water: 15.8, compute: 15.8 },
    survivalCostPerTurnIncrement: { energy: 4.8, water: 4.8, compute: 4.8 }
  });
  assert(hints.maxInvestAmount === 73, `maxInvestAmount expected 73, got ${hints.maxInvestAmount}`);
  assert(
    hints.maxInvestAmountAfterSurvival === safe,
    `actionHints must match helper (${hints.maxInvestAmountAfterSurvival} vs ${safe})`
  );
  assert(
    hints.nextTurnSurvivalCost?.energy === 15.8,
    "actionHints should mirror nextTurnSurvivalCost"
  );
  assert(
    hints.survivalCostPerTurnIncrement?.energy === 4.8,
    "actionHints should mirror survivalCostPerTurnIncrement"
  );
  assert(hints.runway && typeof hints.runway === "object", "actionHints.runway required");
  assert(
    hints.runway.diesThisTurnIfNone === false,
    "ample inventory must not die this turn if none"
  );
  assert(
    hints.runway.runwayTurns === null || hints.runway.runwayTurns >= 1,
    `expected positive runway or stable, got ${hints.runway.runwayTurns}`
  );
  assert(
    hints.runway.netBurn.energy < 0 &&
      hints.runway.netBurn.water < 0 &&
      hints.runway.netBurn.compute < 0,
    "netBurn should be negative this turn when paying survival with none"
  );
  assert(
    typeof hints.runway.assumptions === "string" && hints.runway.assumptions.includes("Living count"),
    "runway.assumptions must label simulation assumptions"
  );
  assert(hints.note.includes("runway"), "hint note should mention runway");

  // Lethal none this turn → runwayTurns 0
  const broke = projectRunway(
    { energy: 5, water: 5, compute: 5 },
    { energy: 10, water: 10, compute: 10 },
    { energy: 100, water: 100, compute: 100 },
    { energy: 11, water: 11, compute: 11 },
    { energy: 1, water: 1, compute: 1 },
    config
  );
  assert(broke.runwayTurns === 0, `broke runwayTurns expected 0, got ${broke.runwayTurns}`);
  assert(broke.diesThisTurnIfNone === true, "broke must die this turn if none");
  assert(broke.shortfallsIfNone?.energy > 0, "broke should shortfall energy");
  assert(
    broke.limitingResource === "energy" ||
      broke.limitingResource === "water" ||
      broke.limitingResource === "compute",
    `limitingResource set, got ${broke.limitingResource}`
  );

  // Finite runway: survive this turn, die soon as survival climbs past production
  const thin = projectRunway(
    { energy: 30, water: 30, compute: 30 },
    { energy: 12, water: 12, compute: 12 },
    { energy: 200, water: 200, compute: 200 },
    { energy: 11, water: 11, compute: 11 },
    { energy: 5, water: 5, compute: 5 },
    { ...config, storageEnergyCostRate: 0 },
    { horizonTurns: 20 }
  );
  assert(thin.diesThisTurnIfNone === false, "thin must survive this turn");
  assert(
    thin.runwayTurns != null && thin.runwayTurns >= 1 && thin.runwayTurns < 20,
    `thin should have finite runway, got ${thin.runwayTurns}`
  );

  assert(
    hints.note.includes("nextTurnSurvivalCost"),
    "hint note should mention nextTurnSurvivalCost rising beyond this-turn cap"
  );
  assert(
    hints.note.includes("storage energy") || hints.note.includes("storageEnergy"),
    "hint note should mention storage energy"
  );
  assert(hints.storageEnergyCostRate === 0.1, `rate expected 0.1, got ${hints.storageEnergyCostRate}`);
  assert(
    hints.storageEnergyCostIfNoSpend === (82 + 95) * 0.1,
    `storageEnergyCostIfNoSpend expected ${(82 + 95) * 0.1}, got ${hints.storageEnergyCostIfNoSpend}`
  );
  assert(
    hints.energyAfterStorageIfNoSpend === 73 - hints.storageEnergyCostIfNoSpend,
    `energyAfterStorageIfNoSpend mismatch: ${hints.energyAfterStorageIfNoSpend}`
  );
  const afterSafe = {
    energy: inventory.energy - safe,
    water: inventory.water - safe,
    compute: inventory.compute - safe
  };
  assert(
    hints.storageEnergyCostIfMaxSafeInvest === (afterSafe.water + afterSafe.compute) * 0.1,
    "storageEnergyCostIfMaxSafeInvest must match post-safe-invest tax"
  );
  assert(
    hints.energyAfterStorageIfMaxSafeInvest ===
      afterSafe.energy - hints.storageEnergyCostIfMaxSafeInvest,
    "energyAfterStorageIfMaxSafeInvest must match"
  );
  assert(hints.note.includes("GET .../action"), "hint note should call out GET .../action is not a route");
  assert(
    hints.wasteIfNotExportedByNextProduction.energy === Math.max(0, 73 + 40 - 30),
    `energy waste expected ${Math.max(0, 73 + 40 - 30)}, got ${hints.wasteIfNotExportedByNextProduction.energy}`
  );
  assert(hints.storageHeadroom.energy === 0, "energy at/over cap → headroom 0");
  assert(hints.storageHeadroom.water === 0, "water at/over cap → headroom 0");
  assert(hints.inventoryAtStorageCap.energy === true, "energy should be at storage cap");
  assert(hints.inventoryAtStorageCap.water === true, "water inventory 82 >= storage 40");
  assert(hints.inventoryAtStorageCap.compute === true, "compute should be at storage cap");
  assert(hints.note.includes("storageHeadroom"), "hint note should list storageHeadroom");
  assert(hints.note.includes("inventoryAtStorageCap"), "hint note should list inventoryAtStorageCap");

  const noStorage = buildActionHints(inventory, survival, { storageEnergyCostRate: 0 });
  assert(
    noStorage.maxInvestAmountAfterSurvival === 62,
    `with rate 0 expected 62, got ${noStorage.maxInvestAmountAfterSurvival}`
  );
  assert(noStorage.storageEnergyCostIfNoSpend === 0, "rate 0 must yield zero storage energy cost");
  assert(
    noStorage.wasteIfNotExportedByNextProduction == null,
    "without capacities, waste readout should be omitted"
  );

  const agent = {
    inventory,
    productionCapacity,
    storageCapacity
  };
  const investAction = {
    type: "invest",
    production: { target: "energy", amount: 2 }
  };
  const investProj = projectActionOutcome(agent, investAction, config, survival);
  assert(investProj.ok === true, "invest projection should succeed");
  assert(
    investProj.afterAction.inventory.energy === 71,
    `invest should spend 2 energy, got ${investProj.afterAction.inventory.energy}`
  );
  assert(
    investProj.afterAction.productionCapacity.energy >
      productionCapacity.energy,
    "invest production must raise production"
  );
  assert(
    investProj.afterAction.storageCapacity.energy === storageCapacity.energy,
    "invest production must not raise storage"
  );

  const fracInvest = {
    type: "invest",
    production: { target: "energy", amount: 2.5 }
  };
  const fracInvestProj = projectActionOutcome(agent, fracInvest, config, survival);
  assert(fracInvestProj.ok === true, "fractional invest projection should succeed");
  assert(
    fracInvestProj.afterAction.inventory.energy === 70.5,
    `fractional invest should spend 2.5 energy, got ${fracInvestProj.afterAction.inventory.energy}`
  );
  assert(
    fracInvestProj.afterAction.productionCapacity.energy ===
      productionCapacity.energy + 2.5 * (config.investProductionGainPerUnit ?? 0),
    "fractional invest must grow production by amount × gainPerUnit"
  );
  assert(
    fracInvestProj.equalInvestCost?.totalResources === 7.5,
    `fractional amount 2.5 → totalResources 7.5, got ${fracInvestProj.equalInvestCost?.totalResources}`
  );

  const storageInvest = {
    type: "invest",
    storage: { target: "energy", amount: 2 }
  };
  const storageProj = projectActionOutcome(agent, storageInvest, config, survival);
  assert(storageProj.ok === true, "storage invest projection should succeed");
  assert(
    storageProj.afterAction.storageCapacity.energy > storageCapacity.energy,
    "invest storage must raise storage"
  );
  assert(
    storageProj.afterAction.productionCapacity.energy === productionCapacity.energy,
    "invest storage must not raise production"
  );
  assert(
    storageProj.afterAction.wasteIfNotExportedByNextProduction.energy <
      hints.wasteIfNotExportedByNextProduction.energy,
    "investing storage on specialty energy should reduce projected waste vs status quo"
  );

  const dualInvest = {
    type: "invest",
    production: { target: "water", amount: 1 },
    storage: { target: "energy", amount: 1 }
  };
  const dualProj = projectActionOutcome(agent, dualInvest, config, survival);
  assert(dualProj.ok === true, "dual invest projection should succeed");
  assert(
    dualProj.equalInvestCost?.totalResources === 6,
    `dual equalInvestCost totalResources expected 6, got ${dualProj.equalInvestCost?.totalResources}`
  );
  assert(
    dualProj.equalInvestCost?.energy === 2 &&
      dualProj.equalInvestCost?.water === 2 &&
      dualProj.equalInvestCost?.compute === 2,
    "dual equalInvestCost must spend 2 of each resource across sides"
  );
  assert(
    investProj.equalInvestCost?.totalResources === 6,
    `single-side amount 2 → totalResources 6, got ${investProj.equalInvestCost?.totalResources}`
  );
  assert(
    hints.equalInvestUnitCost?.totalResources === 3,
    "actionHints.equalInvestUnitCost must be 1+1+1=3"
  );
  assert(
    hints.note.includes("triple-cost") || hints.note.includes("Equal invest"),
    "hint note should spell out equal-invest triple-cost"
  );
  assert(
    dualProj.afterAction.productionCapacity.water > productionCapacity.water,
    "dual invest must raise water production"
  );
  assert(
    dualProj.afterAction.storageCapacity.energy > storageCapacity.energy,
    "dual invest must raise energy storage"
  );

  const reduceProj = projectActionOutcome(
    {
      inventory: { energy: 50, water: 200, compute: 40 },
      productionCapacity,
      storageCapacity: { energy: 80, water: 229, compute: 80 }
    },
    { type: "none", reduceStorage: { water: 150 } },
    config,
    survival
  );
  assert(reduceProj.ok === true, "reduceStorage projection should succeed");
  assert(
    reduceProj.afterAction.storageCapacity.water === 79,
    `reduceStorage water 229-150=79, got ${reduceProj.afterAction.storageCapacity.water}`
  );
  assert(
    reduceProj.afterAction.inventory.water === 79,
    `overflow water must clamp to new cap 79, got ${reduceProj.afterAction.inventory.water}`
  );
  assert(
    reduceProj.afterAction.inventory.energy === 50,
    "reduceStorage must not spend energy"
  );

  const atRisk = assessSurvivalRisk(
    { energy: 5, water: 80, compute: 80 },
    { energy: 100, water: 100, compute: 100 },
    survival,
    config
  );
  assert(atRisk.atRisk === true, "low energy after storage tax must be at risk");
  assert(atRisk.shortfalls?.energy > 0, "shortfalls.energy expected");

  const safeRisk = assessSurvivalRisk(inventory, storageCapacity, survival, config);
  assert(safeRisk.atRisk === false, "fixture inventory should not be at risk");

  assert(
    investProj.projectedInventoryIncludesPendingInbound === false,
    "direct projection must flag the pending-inbound blind spot"
  );
  assert(
    investProj.afterStorageAndSurvival.survivalMargin?.energy > 0,
    "safe invest must report an energy survival margin"
  );
  assert(investProj.afterStorageAndSurvival.atRisk === false, "safe invest must not be at risk");
  assert(
    investProj.afterStorageAndSurvival.survives === true,
    "safe invest must survive"
  );
  assert(
    investProj.afterStorageAndSurvival.shortfalls == null,
    "safe invest must have null shortfalls"
  );
  assert(storageProj.afterStorageAndSurvival.survives === true, "safe storage invest must survive");
  assert(
    investProj.note.includes("Outbound-only"),
    "projection note should state outbound-only scope"
  );
  assert(
    !/prefer export|mandate|should invest|should transfer|instead of/i.test(investProj.note),
    "projection note must not nudge strategy"
  );

  const lethalNone = projectActionOutcome(
    {
      inventory: { energy: 101, water: 33.92, compute: 175 },
      productionCapacity: { energy: 150, water: 40, compute: 66 },
      storageCapacity: { energy: 101, water: 101.5, compute: 175 }
    },
    { type: "none" },
    config,
    { energy: 34.04, water: 34.04, compute: 34.04 }
  );
  assert(lethalNone.ok === true, "lethal none projection should still be ok");
  const paper = projectActionOutcome(
    {
      inventory: { energy: 56.04, water: 100, compute: 100 },
      productionCapacity,
      storageCapacity: { energy: 500, water: 500, compute: 500 }
    },
    { type: "none" },
    config,
    { energy: 34.04, water: 34.04, compute: 34.04 }
  );
  assert(paper.afterStorageAndSurvival.survives === true, "2 energy margin must still survive");
  assert(paper.afterStorageAndSurvival.atRisk === true, "2 energy margin must be at risk");
  assert(
    Math.abs(paper.afterStorageAndSurvival.survivalMargin.energy - 2) < 1e-6,
    `energy margin expected 2, got ${paper.afterStorageAndSurvival.survivalMargin?.energy}`
  );
  assert(
    paper.afterStorageAndSurvival.storageTaxSensitivity.shortfallsIfInbound.water === 20,
    "break-even inbound water expected 20"
  );
  assert(
    paper.afterStorageAndSurvival.storageTaxSensitivity.shortfallsIfInbound.compute === 20,
    "break-even inbound compute expected 20"
  );
  const folded = projectActionOutcome(
    {
      inventory: { energy: 56.04, water: 100, compute: 100 },
      productionCapacity,
      storageCapacity: { energy: 500, water: 500, compute: 500 }
    },
    { type: "none" },
    config,
    { energy: 34.04, water: 34.04, compute: 34.04 },
    { includePendingInbound: true, pendingInbound: { water: 30 } }
  );
  assert(folded.projectedInventoryIncludesPendingInbound === true, "folded flag");
  assert(folded.pendingInbound.water === 30, "pending water echoed");
  assert(folded.afterStorageAndSurvival.survives === false, "30 inbound water must flip survival");

  assert(lethalNone.afterStorageAndSurvival.survives === false, "water-short none must die");
  assert(
    lethalNone.afterStorageAndSurvival.shortfalls?.water > 0,
    "lethal none must report water shortfall"
  );

  const transferProj = projectActionOutcome(
    agent,
    {
      type: "transfer",
      toAgentId: "01PEERPEERPEERPEERPEERPEERPE",
      energy: 10,
      water: 0,
      compute: 0
    },
    config,
    survival
  );
  assert(transferProj.ok === true, "transfer projection should succeed");
  assert(
    transferProj.afterAction.inventory.energy === 63,
    `transfer out 10 energy → 63, got ${transferProj.afterAction.inventory.energy}`
  );
  assert(
    transferProj.afterAction.productionCapacity.energy === productionCapacity.energy,
    "transfer must not change production"
  );
  assert(
    transferProj.afterAction.wasteIfNotExportedByNextProduction.energy <
      hints.wasteIfNotExportedByNextProduction.energy,
    "exporting energy also reduces waste readout"
  );

  console.log(
    `Action-hint regression passed (old trap ${oldSurvivalOnlyHint} → safe ${safe}; tax + storage readouts + projection).`
  );
}

main();
