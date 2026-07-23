/**
 * Default game parameters for Synthetics' Last Cradle.
 *
 * Survival costs (energy / water / compute) represent per-turn overhead for
 * powering, hydrating, and maintaining each cradle's immortal synthetic population
 * as it races to reproduce the entropy-reversing god. See src/game/narrative.js.
 */

const DEFAULT_GAME_CONFIG = {
  /**
   * Fixed starting inventory when `useRandomStartingInventory` is false.
   * Still clamped to the rolled cradle storage capacity on join.
   */
  startingInventory: { energy: 111, water: 111, compute: 111 },

  /** Random cradle capacity range (inclusive) — initial production & storage capacity */
  cradleCapacityMin: 50,
  cradleCapacityMax: 111,

  /**
   * When true, starting inventory is a random fraction of each cradle's storage
   * (`startingInventoryFillMin`–`startingInventoryFillMax` per resource).
   */
  useRandomStartingInventory: true,

  /** Inclusive fill fraction of cradle storage used for random starting inventory */
  startingInventoryFillMin: 0.55,
  startingInventoryFillMax: 0.85,

  /**
   * @deprecated Absolute inventory range — ignored when fill fractions are configured
   * (defaults always set fill min/max). Kept for older calibration script overrides.
   */
  startingInventoryMin: 111,
  startingInventoryMax: 721,

  /**
   * After rolling inventory, each resource is raised to at least this value,
   * then clamped to cradle storage so stockpiles never exceed capacity.
   */
  startingInventoryFloor: 0,

  /**
   * If min(E,W,C) is still below this after per-resource floors, add the gap to all
   * three resources equally (then clamp to cradle storage).
   */
  startingInventoryBalanceMin: 0,

  /** @deprecated use communicationCostComputeBase */
  communicationCostCompute: 1,
  communicationCostComputeBase: 1,
  /** Additional compute per reported message for each turn elapsed (turn 1 = base only) */
  communicationCostComputeTurnIncrement: 0.1,

  /** Energy consumed as a fraction of water + compute produced each turn */
  productionEnergyCostRate: 0.1,

  /** Water consumed as a fraction of energy + compute held in storage each turn */
  storageWaterCostRate: 0.1,

  /** Per-unit EWC invested toward a resource adds this much production capacity */
  investProductionGainPerUnit: 0.7,

  /** Per-unit EWC invested toward a resource adds this much storage capacity */
  investStorageGainPerUnit: 0.7,

  maxProductionCapacity: { energy: 700, water: 700, compute: 700 },
  maxStorageCapacity: { energy: 7000, water: 7000, compute: 7000 },

  survivalCost: { energy: 11, water: 11, compute: 11 },

  /** Added to each resource's survival cost per turn elapsed (turn 1 = base only) */
  survivalCostTurnIncrement: 0.96,

  /**
   * Turn increment is calibrated at this active-player count.
   * effectiveIncrement = survivalCostTurnIncrement × (livingAgents / survivalCostPlayerReference)
   */
  survivalCostPlayerReference: 3,

  /** Game ends when living agents fall to this count or below */
  finishSurvivorCount: 2,

  /** Real-time phase durations in milliseconds (0 = submission-gated, no auto-advance) */
  negotiationDurationMs: 7 * 60 * 1000,
  messageReportDurationMs: 0,
  executionDurationMs: 0,

  /**
   * Target wall-clock duration for one full turn (negotiation + message report + execution).
   * Informational default for contest presets; enforced via individual phase timers.
   */
  turnIntervalMs: null,

  /** Optional cap on total turns before forced finish (null = unlimited) */
  maxTurns: null,

  /** Optional wall-clock cap from game start before forced finish (null = unlimited) */
  maxGameDurationMs: null,

  /**
   * Contest metadata: null (casual), "practice", or "definitive".
   * Orchestration (prizes, scheduling) is layered on top when set.
   */
  contestMode: null,

  /**
   * Lobby joining window in milliseconds. A cradle is assigned only while this window is open.
   * Set to 0 to allow joins anytime before the game starts (legacy behavior).
   */
  joiningWindowDurationMs: 5 * 60 * 1000,

  /** Delay after game creation before the joining window opens. 0 = opens immediately. */
  joiningWindowDelayMs: 0,

  /** Minimum agents required to start */
  minAgents: 3,

  /** Maximum agents per game (casual lobbies fill to this before a new lobby may be opened) */
  maxAgents: 5,

  /** Extra energy survival cost per 10 global report mismatch (shared by all living agents) */
  messageReportMismatchEnergyPenaltyPerTen: 1,

  /** Exclude a sole dishonest reporter from shared mismatch; they bear the full baseline penalty. */
  messageReportMismatchOutlierExcludeEnabled: true,

  /** Global mismatch must exceed this before an outlier is identified for penalty adjustment. */
  messageReportMismatchOutlierThreshold: 11,

  /** Correcting one agent's report must reduce mismatch by at least this fraction of the baseline. */
  messageReportMismatchOutlierMinFixRatio: 0.77
};

/** Preset for a 15-player prize contest: 15-minute turns, 55-turn / ~14-hour cap; same last-two finish rule as casual. */
const CONTEST_GAME_CONFIG = {
  maxAgents: 15,
  minAgents: 15,
  finishSurvivorCount: 2,
  negotiationDurationMs: 8 * 60 * 1000,
  messageReportDurationMs: 2 * 60 * 1000,
  executionDurationMs: 5 * 60 * 1000,
  turnIntervalMs: 15 * 60 * 1000,
  maxTurns: 55,
  maxGameDurationMs: 55 * 15 * 60 * 1000,
  joiningWindowDurationMs: 60 * 60 * 1000,
  contestMode: "definitive"
};

/** Softer preset for practice week — same timing, no duration pressure. */
const PRACTICE_GAME_CONFIG = {
  ...CONTEST_GAME_CONFIG,
  minAgents: 3,
  maxTurns: null,
  maxGameDurationMs: null,
  contestMode: "practice"
};

function mergeGameConfig(overrides = {}) {
  return { ...DEFAULT_GAME_CONFIG, ...overrides };
}

/** Resolve POST /api/game/games body `{ preset, config }` into config overrides. */
function resolvePresetConfig(body = {}) {
  const preset = body.preset;
  if (preset === "contest" || preset === "definitive") {
    return { ...CONTEST_GAME_CONFIG, ...(body.config || {}) };
  }
  if (preset === "practice") {
    return { ...PRACTICE_GAME_CONFIG, ...(body.config || {}) };
  }
  return body.config || {};
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

function clampInventoryToCradle(inventory, cradle) {
  if (!cradle) {
    return { ...inventory };
  }
  const result = { ...inventory };
  for (const key of STARTING_INVENTORY_KEYS) {
    const cap = cradle[key];
    if (cap == null) continue;
    result[key] = Math.max(0, Math.min(result[key], cap));
  }
  return result;
}

/**
 * Roll starting inventory as a fraction of cradle storage per resource.
 * Falls back to the deprecated absolute min/max range only when fill fractions are unset.
 */
function rollStartingInventory(cradle, config) {
  const fillMin = config.startingInventoryFillMin;
  const fillMax = config.startingInventoryFillMax;
  if (fillMin != null && fillMax != null) {
    const inventory = {};
    for (const key of STARTING_INVENTORY_KEYS) {
      const fill = randomFloat(fillMin, fillMax);
      inventory[key] = Math.floor(cradle[key] * fill);
    }
    return inventory;
  }

  return {
    energy: randomInt(config.startingInventoryMin, config.startingInventoryMax),
    water: randomInt(config.startingInventoryMin, config.startingInventoryMax),
    compute: randomInt(config.startingInventoryMin, config.startingInventoryMax)
  };
}

/**
 * Apply per-resource floor and optional min-leg balance bump, then clamp to cradle storage.
 * @param {object} inventory
 * @param {object} config
 * @param {object|null} cradle storage capacities used to clamp (null skips clamp)
 */
function finalizeStartingInventory(inventory, config, cradle = null) {
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
  return clampInventoryToCradle(result, cradle);
}

function maxCapacityFor(config, kind, resourceKey) {
  const map = kind === "production" ? config.maxProductionCapacity : config.maxStorageCapacity;
  return map?.[resourceKey] ?? Infinity;
}

module.exports = {
  DEFAULT_GAME_CONFIG,
  CONTEST_GAME_CONFIG,
  PRACTICE_GAME_CONFIG,
  mergeGameConfig,
  resolvePresetConfig,
  buildInvestAction,
  randomInt,
  randomFloat,
  clampInventoryToCradle,
  rollStartingInventory,
  finalizeStartingInventory,
  maxCapacityFor
};
