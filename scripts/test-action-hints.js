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
  const investAction = normalizeInvestAction({
    type: "invest",
    target: "energy",
    amount: 2
  });
  const investProj = projectActionOutcome(agent, investAction, config, survival);
  assert(investProj.ok === true, "invest projection should succeed");
  assert(
    investProj.afterAction.inventory.energy === 71,
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
