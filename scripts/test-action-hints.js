#!/usr/bin/env node
/**
 * Regression: maxInvestAmountAfterSurvival must reserve post-execution storage water.
 * Replays the Turn-1 trap (invest at the old survival-only hint → water death).
 */

const {
  buildActionHints,
  maxEqualInvestPreservingSurvival,
  applyStorageCost
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

  const hints = buildActionHints(inventory, survival, config);
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

  const noStorage = buildActionHints(inventory, survival, { storageWaterCostRate: 0 });
  assert(
    noStorage.maxInvestAmountAfterSurvival === 62,
    `with rate 0 expected 62, got ${noStorage.maxInvestAmountAfterSurvival}`
  );
  assert(noStorage.storageWaterCostIfNoSpend === 0, "rate 0 must yield zero storage water cost");

  console.log(`Action-hint regression passed (old trap ${oldSurvivalOnlyHint} → safe ${safe}; tax visible).`);
}

main();
