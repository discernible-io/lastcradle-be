#!/usr/bin/env node
/**
 * Regression: maxInvestAmountAfterSurvival must reserve post-execution storage water.
 * Also covers storage readouts on actionHints and outbound action projections.
 */

const {
  buildActionHints,
  maxEqualInvestPreservingSurvival,
  applyStorageCost,
  projectActionOutcome,
  normalizeInvestAction
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
    storageWaterCostRate: 0.1
  };
  // Jay Rockefeller-style turn-1 cradle after production clamp
  const inventory = { energy: 82, water: 73, compute: 95 };
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
    "old hint 62 must be lethal once storage water is applied"
  );

  const safe = maxEqualInvestPreservingSurvival(inventory, survival, config);
  assert(safe < oldSurvivalOnlyHint, `safe hint ${safe} should be below old ${oldSurvivalOnlyHint}`);
  assert(survivesAfterInvest(inventory, safe, survival, config), `safe hint ${safe} must survive`);
  assert(
    !survivesAfterInvest(inventory, safe + 1, survival, config),
    `safe+1 (${safe + 1}) must be lethal (hint is tight)`
  );

  const productionCapacity = { energy: 40, water: 12, compute: 10 };
  const storageCapacity = { energy: 30, water: 40, compute: 40 };
  const hints = buildActionHints(inventory, survival, config, {
    productionCapacity,
    storageCapacity
  });
  assert(hints.maxInvestAmount === 73, `maxInvestAmount expected 73, got ${hints.maxInvestAmount}`);
  assert(
    hints.maxInvestAmountAfterSurvival === safe,
    `actionHints must match helper (${hints.maxInvestAmountAfterSurvival} vs ${safe})`
  );
  assert(hints.note.includes("storage water") || hints.note.includes("storageWater"), "hint note should mention storage water");
  assert(hints.storageWaterCostRate === 0.1, `rate expected 0.1, got ${hints.storageWaterCostRate}`);
  assert(
    hints.storageWaterCostIfNoSpend === (82 + 95) * 0.1,
    `storageWaterCostIfNoSpend expected ${(82 + 95) * 0.1}, got ${hints.storageWaterCostIfNoSpend}`
  );
  assert(
    hints.waterAfterStorageIfNoSpend === 73 - hints.storageWaterCostIfNoSpend,
    `waterAfterStorageIfNoSpend mismatch: ${hints.waterAfterStorageIfNoSpend}`
  );
  const afterSafe = {
    energy: inventory.energy - safe,
    water: inventory.water - safe,
    compute: inventory.compute - safe
  };
  assert(
    hints.storageWaterCostIfMaxSafeInvest === (afterSafe.energy + afterSafe.compute) * 0.1,
    "storageWaterCostIfMaxSafeInvest must match post-safe-invest tax"
  );
  assert(
    hints.waterAfterStorageIfMaxSafeInvest ===
      afterSafe.water - hints.storageWaterCostIfMaxSafeInvest,
    "waterAfterStorageIfMaxSafeInvest must match"
  );
  assert(hints.note.includes("GET .../action"), "hint note should call out GET .../action is not a route");
  assert(
    hints.wasteIfNotExportedByNextProduction.energy === Math.max(0, 82 + 40 - 30),
    `energy waste expected ${Math.max(0, 82 + 40 - 30)}, got ${hints.wasteIfNotExportedByNextProduction.energy}`
  );
  assert(hints.storageHeadroom.energy === 0, "energy at/over cap → headroom 0");
  assert(hints.storageHeadroom.water === Math.max(0, 40 - 73), "water headroom");
  assert(hints.inventoryAtStorageCap.energy === true, "energy should be at storage cap");
  assert(hints.inventoryAtStorageCap.water === true, "water inventory 73 >= storage 40");
  assert(hints.inventoryAtStorageCap.compute === true, "compute should be at storage cap");
  assert(hints.note.includes("storageHeadroom"), "hint note should list storageHeadroom");
  assert(hints.note.includes("inventoryAtStorageCap"), "hint note should list inventoryAtStorageCap");

  const noStorage = buildActionHints(inventory, survival, { storageWaterCostRate: 0 });
  assert(
    noStorage.maxInvestAmountAfterSurvival === 62,
    `with rate 0 expected 62, got ${noStorage.maxInvestAmountAfterSurvival}`
  );
  assert(noStorage.storageWaterCostIfNoSpend === 0, "rate 0 must yield zero storage water cost");
  assert(
    noStorage.wasteIfNotExportedByNextProduction == null,
    "without capacities, waste readout should be omitted"
  );

  const agent = {
    inventory,
    productionCapacity,
    storageCapacity
  };
  const investAction = normalizeInvestAction({
    type: "invest",
    target: "energy",
    amount: 2
  });
  const investProj = projectActionOutcome(agent, investAction, config, survival);
  assert(investProj.ok === true, "invest projection should succeed");
  assert(
    investProj.afterAction.inventory.energy === 80,
    `invest should spend 2 energy, got ${investProj.afterAction.inventory.energy}`
  );
  assert(
    investProj.afterAction.productionCapacity.energy >
      productionCapacity.energy,
    "invest must raise production"
  );
  assert(
    investProj.afterAction.storageCapacity.energy > storageCapacity.energy,
    "invest must raise storage"
  );
  assert(
    investProj.afterAction.wasteIfNotExportedByNextProduction.energy <
      hints.wasteIfNotExportedByNextProduction.energy,
    "investing specialty energy should reduce projected waste vs status quo"
  );
  assert(investProj.afterStorageAndSurvival.survives === true, "safe invest must survive");
  assert(
    investProj.note.includes("Outbound-only"),
    "projection note should state outbound-only scope"
  );
  assert(
    !/prefer export|mandate|should invest|should transfer|instead of/i.test(investProj.note),
    "projection note must not nudge strategy"
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
    transferProj.afterAction.inventory.energy === 72,
    `transfer out 10 energy → 72, got ${transferProj.afterAction.inventory.energy}`
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
