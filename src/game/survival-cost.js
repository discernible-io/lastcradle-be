/**
 * Survival cost calculations: fixed base costs scaled by turn and living players.
 */

function investmentTotal(payload) {
  return (payload.energy || 0) + (payload.water || 0) + (payload.compute || 0);
}

function survivalCostTurnIncrement(config, resourceKey) {
  const inc = config.survivalCostTurnIncrement;
  if (inc == null) return 0;
  if (typeof inc === "number") return inc;
  return inc[resourceKey] ?? 0;
}

/** Linear scale: active (living) players / reference (calibrated at reference count). */
function survivalCostPlayerMultiplier(config, context = {}) {
  const reference = config.survivalCostPlayerReference ?? 3;
  if (reference <= 0) return 1;
  const activePlayers = Math.max(context.livingCount ?? reference, 1);
  return activePlayers / reference;
}

function effectiveSurvivalTurnIncrement(config, context, resourceKey) {
  return survivalCostTurnIncrement(config, resourceKey) * survivalCostPlayerMultiplier(config, context);
}

function computeSurvivalCost(config, context = {}) {
  const turn = Math.max(1, context.turnNumber ?? 1);
  const turnOffset = turn - 1;
  const base = config.survivalCost ?? { energy: 11, water: 11, compute: 11 };

  return {
    energy:
      (base.energy ?? 11) + turnOffset * effectiveSurvivalTurnIncrement(config, context, "energy"),
    water:
      (base.water ?? 11) + turnOffset * effectiveSurvivalTurnIncrement(config, context, "water"),
    compute:
      (base.compute ?? 11) + turnOffset * effectiveSurvivalTurnIncrement(config, context, "compute")
  };
}

function buildSurvivalContext({ turnNumber, livingAgents, game } = {}) {
  const config = game?.config ?? {};
  const livingCount = livingAgents?.length ?? 0;

  return {
    turnNumber,
    livingCount,
    playerMultiplier: survivalCostPlayerMultiplier(config, { livingCount })
  };
}

module.exports = {
  investmentTotal,
  survivalCostPlayerMultiplier,
  effectiveSurvivalTurnIncrement,
  computeSurvivalCost,
  buildSurvivalContext
};
