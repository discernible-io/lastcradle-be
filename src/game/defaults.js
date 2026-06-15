/**
 * Default game parameters for the Resource Negotiation Survival Game.
 */

const DEFAULT_GAME_CONFIG = {
  /** Starting inventory when random range is not used */
  startingInventory: { energy: 100, water: 100, compute: 100 },

  /** Random territory capacity range (inclusive) — initial production & storage capacity */
  territoryCapacityMin: 20,
  territoryCapacityMax: 100,

  /** Random starting inventory range (inclusive) */
  startingInventoryMin: 40,
  startingInventoryMax: 200,
  useRandomStartingInventory: true,

  /**
   * After rolling random inventory, each resource is raised to at least this value.
   */
  startingInventoryFloor: 50,

  /**
   * If min(E,W,C) is still below this after per-resource floors, add the gap to all
   * three resources equally so balanced investments remain affordable early on.
   */
  startingInventoryBalanceMin: 60,

  /** @deprecated use communicationCostComputeBase */
  communicationCostCompute: 1,
  communicationCostComputeBase: 1,
  /** Additional compute per reported message for each turn elapsed (turn 1 = base only) */
  communicationCostComputeTurnIncrement: 0.08,

  /** Energy consumed as a fraction of water + compute produced each turn */
  productionEnergyCostRate: 0.1,

  /** Water consumed as a fraction of energy + compute held in storage each turn */
  storageWaterCostRate: 0.1,

  /** Per-unit EWC invested toward a resource adds this much production capacity */
  investProductionGainPerUnit: 0.5,

  /** Per-unit EWC invested toward a resource adds this much storage capacity */
  investStorageGainPerUnit: 0.5,

  maxProductionCapacity: { energy: 500, water: 500, compute: 500 },
  maxStorageCapacity: { energy: 5000, water: 5000, compute: 5000 },

  survivalCost: { energy: 10, water: 10, compute: 10 },

  /** Added to each resource's survival cost per turn elapsed (turn 1 = base only) */
  survivalCostTurnIncrement: 0.65,

  /**
   * Turn increment is calibrated at this active-player count.
   * effectiveIncrement = survivalCostTurnIncrement × (livingAgents / survivalCostPlayerReference)
   */
  survivalCostPlayerReference: 3,

  /** Game ends when living agents fall to this count or below */
  finishSurvivorCount: 2,

  /** Real-time phase durations in milliseconds */
  negotiationDurationMs: 5 * 60 * 1000,
  executionDurationMs: 5 * 60 * 1000,

  /** Minimum agents required to start */
  minAgents: 3,

  /** Maximum agents per game */
  maxAgents: 12,

  /** Extra energy survival cost per 10 global report mismatch (shared by all living agents) */
  messageReportMismatchEnergyPenaltyPerTen: 1,

  /** Exclude a sole dishonest reporter from shared mismatch; they bear the full baseline penalty. */
  messageReportMismatchOutlierExcludeEnabled: true,

  /** Global mismatch must exceed this before an outlier is identified for penalty adjustment. */
  messageReportMismatchOutlierThreshold: 10,

  /** Correcting one agent's report must reduce mismatch by at least this fraction of the baseline. */
  messageReportMismatchOutlierMinFixRatio: 0.75
};

function mergeGameConfig(overrides = {}) {
  return { ...DEFAULT_GAME_CONFIG, ...overrides };
}

/** Balanced invest: same amount of energy, water, and compute toward target resource capacity. */
function buildInvestAction(target, amount) {
  return { type: "invest", target, energy: amount, water: amount, compute: amount };
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max) {
  return min + Math.random() * (max - min);
}

const STARTING_INVENTORY_KEYS = ["energy", "water", "compute"];

/** Apply per-resource floor and optional min-leg balance bump after random rolls. */
function finalizeStartingInventory(inventory, config) {
  const result = { ...inventory };
  const floor = config.startingInventoryFloor ?? 0;
  for (const key of STARTING_INVENTORY_KEYS) {
    result[key] = Math.max(result[key], floor);
  }
  const balanceMin = config.startingInventoryBalanceMin ?? 0;
  if (balanceMin > 0) {
    const minLeg = Math.min(result.energy, result.water, result.compute);
    if (minLeg < balanceMin) {
      const bump = balanceMin - minLeg;
      for (const key of STARTING_INVENTORY_KEYS) {
        result[key] += bump;
      }
    }
  }
  return result;
}

function maxCapacityFor(config, kind, resourceKey) {
  const map = kind === "production" ? config.maxProductionCapacity : config.maxStorageCapacity;
  return map?.[resourceKey] ?? Infinity;
}

module.exports = {
  DEFAULT_GAME_CONFIG,
  mergeGameConfig,
  buildInvestAction,
  randomInt,
  randomFloat,
  finalizeStartingInventory,
  maxCapacityFor
};
