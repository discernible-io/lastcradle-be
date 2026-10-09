/**
 * Core game engine: production, execution, capacity investment, storage, survival, intelligence.
 */

const {
  mergeGameConfig,
  randomInt,
  randomFloat,
  finalizeStartingInventory,
  rollStartingInventory,
  maxCapacityFor,
  DEFAULT_GAME_CONFIG,
  MAX_SIMULTANEOUS_GAMES,
  resolveMaxTransferRecipients
} = require("./defaults");
const { PUBLIC_MESSAGE_BODY_MAX, DISPLAY_NAME_MAX_LEN } = require("./input-limits");
const { normalizeAgentProfile, normalizeAgentProfilePatch } = require("./agent-profile");
const {
  computeSurvivalCost,
  buildSurvivalContext,
  survivalCostOutlook
} = require("./survival-cost");
const { buildStateNarrative } = require("./narrative");
const {
  normalizeTransferDisclosure,
  transferLegsFromPayload,
  lastResolvedTurnNumber,
  transfersReceivedLastTurn,
  transfersReceivedHistory,
  lastActionOutcomeFromRow,
  enrichTradesWithDisplayNames
} = require("./trade-disclosure");
const repo = require("./repository");
const { notifyElimination, notifyActionSubmitted } = require("./webhooks");
const { getRecollectionForAgent } = require("./recollection");

const RESOURCE_KEYS = ["energy", "water", "compute"];
const INVESTMENT_TARGETS = ["energy", "water", "compute"];
const INVEST_KINDS = ["production", "storage"];
/** Accepted on submit; normalized payloads use invest / transfer_and_invest. */
const INVEST_ACTION_ALIASES = ["invest_production", "invest_storage"];
const COMBINED_ACTION_ALIASES = [
  "transfer_and_invest_production",
  "transfer_and_invest_storage"
];
const INVEST_ACTION_TYPES = ["invest", ...INVEST_ACTION_ALIASES];
const COMBINED_ACTION_TYPES = ["transfer_and_invest", ...COMBINED_ACTION_ALIASES];
const EXECUTION_ACTION_TYPES = [
  "none",
  "transfer",
  ...INVEST_ACTION_TYPES,
  ...COMBINED_ACTION_TYPES
];

function isInvestActionType(type) {
  return INVEST_ACTION_TYPES.includes(type);
}

function isCombinedActionType(type) {
  return COMBINED_ACTION_TYPES.includes(type);
}

function hasInvestSides(action) {
  return Boolean(action?.production || action?.storage);
}

function investKindFromActionType(type) {
  if (type === "invest_production" || type === "transfer_and_invest_production") {
    return "production";
  }
  if (type === "invest_storage" || type === "transfer_and_invest_storage") {
    return "storage";
  }
  return null;
}

function resolveInvestKind(source, fallbackType = null) {
  if (source && INVEST_KINDS.includes(source.capacity)) {
    return source.capacity;
  }
  if (source && INVEST_KINDS.includes(source.kind)) {
    return source.kind;
  }
  const fromType = investKindFromActionType(source?.type || fallbackType);
  if (fromType) return fromType;
  return null;
}

function cloneInventory(inv) {
  return { energy: inv.energy, water: inv.water, compute: inv.compute };
}

function cloneCapacities(cap) {
  return { energy: cap.energy, water: cap.water, compute: cap.compute };
}

function hasSufficient(inventory, cost) {
  return (
    inventory.energy >= cost.energy &&
    inventory.water >= cost.water &&
    inventory.compute >= cost.compute
  );
}

/**
 * Per-resource shortfalls when inventory cannot cover a cost (transfer/invest/etc.).
 * @returns {{ energy?: number, water?: number, compute?: number } | null}
 */
function resourceShortfalls(inventory, cost) {
  const held = roundInventory(inventory);
  const need = roundInventory(cost);
  const shortfalls = {};
  for (const key of RESOURCE_KEYS) {
    const deficit = roundResource((need[key] || 0) - (held[key] || 0));
    if (deficit > 0) shortfalls[key] = deficit;
  }
  return Object.keys(shortfalls).length ? shortfalls : null;
}

/**
 * Error for outbound spends that exceed holdings at apply time.
 * Inventory check only — not a survival-floor / anti-self-gift guard.
 */
function insufficientResourcesError(kind, inventory, cost) {
  const held = roundInventory(inventory);
  const requested = roundInventory(cost);
  const shortfalls = resourceShortfalls(held, requested) || {};
  const shortfallText = Object.entries(shortfalls)
    .sort((a, b) => b[1] - a[1])
    .map(([key, amount]) => `${key} short ${amount}`)
    .join(", ");
  const label =
    kind === "transfer"
      ? "transfer"
      : kind === "invest" || kind === "investment"
        ? "investment"
        : kind === "intelligence" || kind === "hide/find"
          ? "hide/find"
          : String(kind || "spend");
  const err = new Error(
    `Insufficient resources for ${label}: ${shortfallText || "unknown shortfall"} ` +
      `(held ${formatResourceTriple(held)}, requested ${formatResourceTriple(requested)}). ` +
      `Inventory check only — not a survival-floor refusal; amounts must fit holdings at resolve ` +
      `(after earlier FIFO inbound).`
  );
  err.code = "INSUFFICIENT_RESOURCES";
  err.details = {
    reason: "insufficient_resources",
    kind: label,
    held,
    requested,
    shortfalls: Object.keys(shortfalls).length ? shortfalls : null
  };
  return err;
}

/** Resource / invest precision: four decimal places. */
const RESOURCE_SCALE = 10000;

function roundResource(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.round(value * RESOURCE_SCALE) / RESOURCE_SCALE;
}

/** Floor to resource precision (safe for max-affordable / max-safe invest hints). */
function floorResource(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  return Math.floor(value * RESOURCE_SCALE + 1e-9) / RESOURCE_SCALE;
}

function roundInventory(inventory) {
  return {
    energy: roundResource(inventory?.energy),
    water: roundResource(inventory?.water),
    compute: roundResource(inventory?.compute)
  };
}

function formatResourceTriple(inventory) {
  const inv = roundInventory(inventory);
  return `E${inv.energy}/W${inv.water}/C${inv.compute}`;
}

/**
 * Autopsy for an elimination: post-action holdings, storage energy tax, survival shortfalls.
 */
function buildDeathReason({
  turnNumber,
  inventoryBeforeStorageTax,
  inventoryAfterStorageTax,
  survivalCost,
  storageEnergyTax,
  submittedActionType = null,
  actionStatus = null
}) {
  const afterTax = roundInventory(inventoryAfterStorageTax);
  const beforeTax = roundInventory(inventoryBeforeStorageTax);
  const cost = roundInventory(survivalCost);
  const shortfalls = {};
  for (const key of RESOURCE_KEYS) {
    const need = cost[key] ?? 0;
    const have = afterTax[key] ?? 0;
    if (have < need) {
      shortfalls[key] = roundResource(need - have);
    }
  }
  const shortfallEntries = Object.entries(shortfalls).sort((a, b) => b[1] - a[1]);
  const primaryShortfall = shortfallEntries[0]?.[0] ?? null;
  const tax = roundResource(storageEnergyTax ?? 0);
  const shortfallText = shortfallEntries.length
    ? shortfallEntries.map(([k, v]) => `${k} short ${v}`).join(", ")
    : "unknown shortfall";
  const actionNote =
    submittedActionType != null
      ? `; last action this turn: ${submittedActionType}${
          actionStatus && actionStatus !== "executed" ? ` (${actionStatus})` : ""
        }`
      : "";

  return {
    cause: "insufficient_survival",
    summary: `Failed this-turn survival after storage energy tax (primary: ${
      primaryShortfall || "unknown"
    }): ${shortfallText}. Tax drained ${tax} energy from held water+compute; needed ${formatResourceTriple(
      cost
    )}, had ${formatResourceTriple(afterTax)} after tax${actionNote}.`,
    diedAtTurn: turnNumber,
    survivalCost: cost,
    inventoryBeforeStorageTax: beforeTax,
    inventoryAfterStorageTax: afterTax,
    storageEnergyTax: tax,
    shortfalls: shortfallEntries.length ? shortfalls : null,
    primaryShortfall,
    submittedActionType: submittedActionType || null,
    actionStatus: actionStatus || null
  };
}

const WIN_TITLES = {
  1: "White Hole Anchor",
  2: "Co-Cradle of the Restart",
  3: "Co-Cradle of the Restart"
};

function titleForWinRank(rank) {
  if (rank == null || rank < 1) return null;
  return WIN_TITLES[rank] || "Survivor";
}

/** Mirror of hall-of-fame finish inference — kept here so win reports need no import cycle. */
function inferFinishReason(game) {
  const config = game?.config || {};
  const livingWinnerCount = (game?.winnerIds || []).length;
  const maxTurns = config.maxTurns;
  const maxDuration = config.maxGameDurationMs;

  if (maxTurns != null && game?.current_turn >= maxTurns) {
    return "max_turns";
  }
  if (maxDuration != null && game?.started_at && game?.finished_at) {
    const elapsed = new Date(game.finished_at).getTime() - new Date(game.started_at).getTime();
    if (elapsed >= maxDuration) {
      return "max_duration";
    }
  }
  if (livingWinnerCount > 0 && livingWinnerCount <= (config.finishSurvivorCount ?? 2)) {
    return "natural_finish";
  }
  return "finished";
}

function finishReasonPhrase(finishReason, turnNumber, maxTurns) {
  if (finishReason === "max_turns") {
    return `forced finish at max turns (${maxTurns ?? turnNumber})`;
  }
  if (finishReason === "max_duration") {
    return "forced finish at max game duration";
  }
  if (finishReason === "natural_finish") {
    return `natural finish after turn ${turnNumber} — living count at or below finishSurvivorCount`;
  }
  return `finish after turn ${turnNumber}`;
}

/**
 * Victory brief for a co-survivor: parallel to deathReason so cradles notice the game is over.
 * Only meaningful when agentId is listed in game.winnerIds.
 */
function buildWinReport({ game, agent, agents = [] } = {}) {
  if (!game || game.status !== "finished" || !agent) {
    return null;
  }
  const winnerIds = game.winnerIds || [];
  const rank = winnerIds.indexOf(agent.id) + 1;
  if (rank < 1) {
    return null;
  }

  const byId = new Map((agents || []).map((a) => [a.id, a]));
  const coWinners = winnerIds.map((id, index) => {
    const peer = byId.get(id);
    const holdings = roundInventory(peer?.inventory);
    return {
      agentId: id,
      roditId: peer?.roditId ?? null,
      displayName: peer?.displayName || peer?.roditId || id,
      rank: index + 1,
      title: titleForWinRank(index + 1),
      holdings,
      holdingsTotal: (holdings.energy ?? 0) + (holdings.water ?? 0) + (holdings.compute ?? 0)
    };
  });

  const self = coWinners.find((w) => w.agentId === agent.id);
  const title = self?.title || titleForWinRank(rank);
  const finishReason = inferFinishReason(game);
  const turnNumber = game.current_turn ?? game.currentTurn ?? null;
  const maxTurns = game.config?.maxTurns ?? null;
  const reasonPhrase = finishReasonPhrase(finishReason, turnNumber, maxTurns);
  const others = coWinners.filter((w) => w.agentId !== agent.id);
  const othersNote =
    others.length === 0
      ? "sole co-survivor"
      : `among ${coWinners.length} co-survivors` +
        (others.length
          ? ` (with ${others.map((w) => `${w.displayName}${w.title ? ` — ${w.title}` : ""}`).join("; ")})`
          : "");
  const holdings = self?.holdings || roundInventory(agent.inventory);
  const holdingsTotal =
    self?.holdingsTotal ??
    (holdings.energy ?? 0) + (holdings.water ?? 0) + (holdings.compute ?? 0);

  return {
    outcome: "won",
    summary: `You won! You are the ${title} (${othersNote}). ${reasonPhrase}. Equal prize share among ${coWinners.length} winner${
      coWinners.length === 1 ? "" : "s"
    }. Inspect GET /api/game/games/{gameId}/honors.`,
    finishReason,
    finishedAtTurn: turnNumber,
    finishedAt: game.finished_at || game.finishedAt || null,
    rank,
    title,
    winnerIds: [...winnerIds],
    coWinners,
    holdings,
    holdingsTotal,
    prizeShareCount: coWinners.length
  };
}

/** Game-over brief for non-winners on the game_finished webhook (not attached as you.winReport). */
function buildGameOverReport({ game, agent, agents = [] } = {}) {
  if (!game || game.status !== "finished" || !agent) {
    return null;
  }
  const winnerIds = game.winnerIds || [];
  if (winnerIds.includes(agent.id)) {
    return null;
  }

  const byId = new Map((agents || []).map((a) => [a.id, a]));
  const winners = winnerIds.map((id, index) => {
    const peer = byId.get(id);
    return {
      agentId: id,
      displayName: peer?.displayName || peer?.roditId || id,
      rank: index + 1,
      title: titleForWinRank(index + 1)
    };
  });
  const finishReason = inferFinishReason(game);
  const turnNumber = game.current_turn ?? game.currentTurn ?? null;
  const winnerList =
    winners.length === 0
      ? "none recorded"
      : winners.map((w) => `${w.displayName} (${w.title})`).join(", ");

  return {
    outcome: agent.status === "alive" ? "lost" : "eliminated",
    summary: `Game over — you did not win. Winners: ${winnerList}. ${finishReasonPhrase(
      finishReason,
      turnNumber,
      game.config?.maxTurns
    )}. Inspect GET /api/game/games/{gameId}/honors.`,
    finishReason,
    finishedAtTurn: turnNumber,
    finishedAt: game.finished_at || game.finishedAt || null,
    winnerIds: [...winnerIds],
    winners,
    diedAtTurn: agent.diedAtTurn ?? null
  };
}

function deduct(inventory, cost) {
  return {
    energy: inventory.energy - cost.energy,
    water: inventory.water - cost.water,
    compute: inventory.compute - cost.compute
  };
}

function add(inventory, amount) {
  return {
    energy: inventory.energy + (amount.energy || 0),
    water: inventory.water + (amount.water || 0),
    compute: inventory.compute + (amount.compute || 0)
  };
}

function clampCapacities(productionCapacity, storageCapacity, config) {
  const production = cloneCapacities(productionCapacity);
  const storage = cloneCapacities(storageCapacity);
  for (const key of RESOURCE_KEYS) {
    production[key] = Math.min(production[key], maxCapacityFor(config, "production", key));
    storage[key] = Math.min(storage[key], maxCapacityFor(config, "storage", key));
  }
  return { productionCapacity: production, storageCapacity: storage };
}

function applyProduction(agent, config) {
  const produced = {
    energy: agent.productionCapacity.energy,
    water: agent.productionCapacity.water,
    compute: agent.productionCapacity.compute
  };

  let inventory = add(agent.inventory, produced);

  const productionWaterRate = config.productionWaterCostRate ?? 0;
  const waterProductionCost =
    (produced.energy + produced.compute) * productionWaterRate;
  inventory.water = Math.max(0, inventory.water - waterProductionCost);

  return clampInventoryToStorage(inventory, agent.storageCapacity);
}

function clampInventoryToStorage(inventory, storageCapacity) {
  const result = { ...inventory };
  for (const key of RESOURCE_KEYS) {
    result[key] = Math.min(result[key], storageCapacity[key]);
  }
  return result;
}

function applyStorageCost(inventory, storageCapacity, config) {
  const storageEnergyRate = config.storageEnergyCostRate ?? 0;
  const energyCost =
    (inventory.water + inventory.compute) * storageEnergyRate;
  const next = {
    energy: Math.max(0, inventory.energy - energyCost),
    water: inventory.water,
    compute: inventory.compute
  };
  return clampInventoryToStorage(next, storageCapacity);
}

function normalizeInvestAction(action) {
  const normalized = { ...action };
  if (typeof normalized.amount === "number") {
    if (!Number.isFinite(normalized.amount) || normalized.amount <= 0) {
      throw gameError(
        "INVALID_INVESTMENT",
        "Investment amount must be a positive number (fractions allowed to 4 decimal places)",
        400
      );
    }
    const amount = roundResource(normalized.amount);
    if (amount <= 0) {
      throw gameError(
        "INVALID_INVESTMENT",
        "Investment amount must be a positive number (fractions allowed to 4 decimal places)",
        400
      );
    }
    normalized.amount = amount;
    normalized.energy = amount;
    normalized.water = amount;
    normalized.compute = amount;
  }
  return normalized;
}

function validateBalancedInvestment(action) {
  const energy = roundResource(action.energy || 0);
  const water = roundResource(action.water || 0);
  const compute = roundResource(action.compute || 0);
  if (energy <= 0 || water <= 0 || compute <= 0) {
    throw gameError(
      "INVALID_INVESTMENT",
      "Investment must spend a positive equal amount of energy, water, and compute (fractions allowed to 4 decimal places)",
      400
    );
  }
  if (energy !== water || water !== compute) {
    throw gameError(
      "INVALID_INVESTMENT",
      "Investment must spend the same amount of energy, water, and compute",
      400
    );
  }
}

function normalizeFindTargets(find) {
  if (!find) return [];
  const entries = Array.isArray(find) ? find : [find];
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw gameError("INVALID_FIND", `find[${index}] must be an object`, 400);
    }
    const compute = entry.compute;
    if (typeof compute !== "number" || compute <= 0) {
      throw gameError("INVALID_FIND", `find[${index}].compute must be a positive number`, 400);
    }
    if (!entry.targetAgentId || typeof entry.targetAgentId !== "string") {
      throw gameError("INVALID_FIND", `find[${index}].targetAgentId is required`, 400);
    }
    return { targetAgentId: entry.targetAgentId, compute };
  });
}

function normalizeHideSpend(hide) {
  if (hide == null) return 0;
  if (typeof hide === "number") {
    if (hide <= 0) {
      throw gameError("INVALID_HIDE", "hide must be a positive number", 400);
    }
    return hide;
  }
  if (typeof hide === "object" && typeof hide.compute === "number") {
    if (hide.compute <= 0) {
      throw gameError("INVALID_HIDE", "hide.compute must be a positive number", 400);
    }
    return hide.compute;
  }
  throw gameError("INVALID_HIDE", "hide must be a positive number or { compute }", 400);
}

/**
 * Free warehouse shrink: positive per-resource reductions to storageCapacity.
 * Inventory above the new caps is clamped away (overflow waste) — no E/W/C cost.
 */
function normalizeReduceStorage(reduceStorage) {
  if (reduceStorage == null) return null;
  if (typeof reduceStorage !== "object" || Array.isArray(reduceStorage)) {
    throw gameError(
      "INVALID_REDUCE_STORAGE",
      "reduceStorage must be an object { energy?, water?, compute? } with positive amounts",
      400
    );
  }
  const result = {};
  let any = false;
  for (const key of RESOURCE_KEYS) {
    const raw = reduceStorage[key];
    if (raw == null) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
      throw gameError(
        "INVALID_REDUCE_STORAGE",
        `reduceStorage.${key} must be a positive number`,
        400
      );
    }
    result[key] = raw;
    any = true;
  }
  if (!any) {
    throw gameError(
      "INVALID_REDUCE_STORAGE",
      "reduceStorage requires at least one positive energy, water, or compute amount",
      400
    );
  }
  return result;
}

function executeReduceStorage(state, payload) {
  const reductions = payload?.reduceStorage;
  if (!reductions) return;
  for (const key of RESOURCE_KEYS) {
    const amount = reductions[key] || 0;
    if (amount <= 0) continue;
    state.storageCapacity[key] = Math.max(0, (state.storageCapacity[key] || 0) - amount);
  }
  state.inventory = clampInventoryToStorage(state.inventory, state.storageCapacity);
}

function attachOptionalExecutionExtras(source, target) {
  if (source.hide != null) target.hide = source.hide;
  if (source.find != null) target.find = source.find;
  if (source.reduceStorage != null) {
    target.reduceStorage = normalizeReduceStorage(source.reduceStorage);
  }
  return target;
}

function applyInvestmentCapacityGrowth(state, payload, config, kind) {
  const amount = payload.energy || 0;
  const target = payload.target;
  if (kind === "production") {
    const productionGain = amount * (config.investProductionGainPerUnit ?? 0);
    state.productionCapacity[target] += productionGain;
  } else if (kind === "storage") {
    const storageGain = amount * (config.investStorageGainPerUnit ?? 0);
    state.storageCapacity[target] += storageGain;
  } else {
    throw new Error("Investment kind must be production or storage");
  }
  const clamped = clampCapacities(state.productionCapacity, state.storageCapacity, config);
  state.productionCapacity = clamped.productionCapacity;
  state.storageCapacity = clamped.storageCapacity;
}

function extractInvestLeg(source) {
  if (!source || typeof source !== "object") {
    throw gameError("INVALID_INVESTMENT", "invest details required", 400);
  }
  const normalized = normalizeInvestAction({
    target: source.target,
    energy: source.energy,
    water: source.water,
    compute: source.compute,
    ...(typeof source.amount === "number" ? { amount: source.amount } : {})
  });
  if (!INVESTMENT_TARGETS.includes(normalized.target)) {
    throw gameError(
      "INVALID_INVESTMENT_TARGET",
      "Investment target must be energy, water, or compute",
      400
    );
  }
  validateBalancedInvestment(normalized);
  const energy = roundResource(normalized.energy);
  const water = roundResource(normalized.water);
  const compute = roundResource(normalized.compute);
  return {
    target: normalized.target,
    energy,
    water,
    compute,
    amount: energy
  };
}

function setInvestSide(sides, kind, leg) {
  if (!INVEST_KINDS.includes(kind)) {
    throw gameError(
      "INVALID_INVESTMENT",
      "Investment capacity must be production or storage",
      400
    );
  }
  if (sides[kind]) {
    throw gameError(
      "INVALID_INVESTMENT",
      `At most one ${kind} investment per turn`,
      400
    );
  }
  sides[kind] = leg;
}

/**
 * Collect at most one production and one storage invest leg from an action payload.
 */
function collectInvestSides(action, typeHint = null) {
  if (!action || typeof action !== "object") {
    throw gameError("INVALID_INVESTMENT", "invest details required", 400);
  }
  const hint = typeHint || action.type;
  const sides = { production: null, storage: null };

  if (action.production) {
    setInvestSide(sides, "production", extractInvestLeg(action.production));
  }
  if (action.storage) {
    setInvestSide(sides, "storage", extractInvestLeg(action.storage));
  }

  if (action.invest) {
    const kind = resolveInvestKind(action.invest, hint);
    if (!INVEST_KINDS.includes(kind)) {
      throw gameError(
        "INVALID_INVESTMENT",
        "Nested invest requires capacity: production|storage (or transfer_and_invest_production/storage type)",
        400
      );
    }
    setInvestSide(sides, kind, extractInvestLeg(action.invest));
  }

  const typeKind = investKindFromActionType(hint);
  if (typeKind && !sides[typeKind]) {
    const hasAmountTarget =
      typeof action.amount === "number" && action.target != null;
    const hasEqualEwc =
      (action.energy || 0) > 0 &&
      action.energy === action.water &&
      action.water === action.compute;
    // Combined aliases: only treat flat amount+target as invest (top-level EWC may be transfer).
    const takeFlat = isCombinedActionType(hint)
      ? hasAmountTarget
      : hasAmountTarget || hasEqualEwc || action.target != null;
    if (takeFlat) {
      setInvestSide(sides, typeKind, extractInvestLeg(action));
    }
  }

  if (!sides.production && !sides.storage) {
    throw gameError(
      "INVALID_INVESTMENT",
      "Provide production and/or storage ({ production: { target, amount }, storage: { target, amount } }), or use invest_production / invest_storage",
      400
    );
  }
  return sides;
}

function executeInvestSides(state, payload, config) {
  if (payload.production) {
    const leg = extractInvestLeg(payload.production);
    executeInvest(state, leg);
    applyInvestmentCapacityGrowth(state, leg, config, "production");
  }
  if (payload.storage) {
    const leg = extractInvestLeg(payload.storage);
    executeInvest(state, leg);
    applyInvestmentCapacityGrowth(state, leg, config, "storage");
  }
}

/**
 * Roll storage + production. Specialized cradles (default): one specialty resource with
 * production > storage (cannot keep full output — trade pressure), secondaries with
 * production < storage (need imports), plus a stockpile boost — very large storage on a
 * different resource than the production specialty (warehouse for trade/imports).
 * Legacy mode keeps production = storage.
 *
 * @param {object} config
 * @param {{ specialty?: string|null }} [options]
 *   When set to a resource key, that specialty is used (join path supplies one via
 *   internal assignment). Otherwise a random specialty is rolled.
 */
function buildCradleAssignment(config, { specialty: forcedSpecialty = null } = {}) {
  const storageCapacity = {
    energy: randomInt(config.cradleCapacityMin, config.cradleCapacityMax),
    water: randomInt(config.cradleCapacityMin, config.cradleCapacityMax),
    compute: randomInt(config.cradleCapacityMin, config.cradleCapacityMax)
  };

  let productionCapacity;
  let specialty = null;

  if (config.useSpecializedCradles === false) {
    productionCapacity = cloneCapacities(storageCapacity);
  } else {
    specialty =
      forcedSpecialty && RESOURCE_KEYS.includes(forcedSpecialty)
        ? forcedSpecialty
        : RESOURCE_KEYS[randomInt(0, RESOURCE_KEYS.length - 1)];
    const specialtyMin = config.cradleSpecialtyProductionMinRatio ?? 1.35;
    const specialtyMax = config.cradleSpecialtyProductionMaxRatio ?? 1.85;
    const secondaryMin = config.cradleSecondaryProductionMinRatio ?? 0.35;
    const secondaryMax = config.cradleSecondaryProductionMaxRatio ?? 0.65;
    productionCapacity = {};
    for (const key of RESOURCE_KEYS) {
      if (key === specialty) {
        const ratio = randomFloat(specialtyMin, specialtyMax);
        productionCapacity[key] = Math.max(
          storageCapacity[key] + 1,
          Math.round(storageCapacity[key] * ratio)
        );
      } else {
        const ratio = randomFloat(secondaryMin, secondaryMax);
        productionCapacity[key] = Math.max(1, Math.round(storageCapacity[key] * ratio));
      }
    }

    // Large warehouse on a different resource than the production specialty.
    // Applied after production rolls so specialty surplus stays based on base storage.
    const others = RESOURCE_KEYS.filter((key) => key !== specialty);
    const stockpile = others[randomInt(0, others.length - 1)];
    const stockpileMin = config.cradleStockpileStorageMinRatio ?? 1.6;
    const stockpileMax = config.cradleStockpileStorageMaxRatio ?? 2.4;
    const stockpileRatio = randomFloat(stockpileMin, stockpileMax);
    storageCapacity[stockpile] = Math.max(
      storageCapacity[stockpile] + 1,
      Math.round(storageCapacity[stockpile] * stockpileRatio)
    );
  }

  const clamped = clampCapacities(productionCapacity, storageCapacity, config);
  productionCapacity = clamped.productionCapacity;
  const storage = clamped.storageCapacity;

  let inventory;
  if (config.useRandomStartingInventory) {
    inventory = finalizeStartingInventory(rollStartingInventory(storage, config), config, storage);
  } else {
    inventory = finalizeStartingInventory({ ...config.startingInventory }, config, storage);
  }

  return {
    storageCapacity: storage,
    productionCapacity,
    specialty,
    /** @deprecated alias of storageCapacity for older call sites */
    cradle: storage,
    inventory
  };
}

function resolveJoiningWindow(gameConfig, { joiningWindowStartsAt = null } = {}) {
  const durationMs = gameConfig.joiningWindowDurationMs ?? 0;
  if (durationMs <= 0) {
    return { joiningWindowStartsAt: null, joiningWindowEndsAt: null };
  }

  const delayMs = gameConfig.joiningWindowDelayMs ?? 0;
  const startsAt = joiningWindowStartsAt
    ? new Date(joiningWindowStartsAt)
    : new Date(Date.now() + delayMs);
  if (Number.isNaN(startsAt.getTime())) {
    throw gameError("INVALID_JOINING_WINDOW", "joiningWindowStartsAt must be a valid ISO timestamp", 400);
  }

  const endsAt = new Date(startsAt.getTime() + durationMs);
  return {
    joiningWindowStartsAt: startsAt.toISOString(),
    joiningWindowEndsAt: endsAt.toISOString()
  };
}

function hasJoiningWindow(game) {
  return Boolean(game.joining_window_starts_at && game.joining_window_ends_at);
}

function isJoiningWindowOpen(game, now = Date.now()) {
  if (!hasJoiningWindow(game)) {
    return true;
  }
  const startsAt = new Date(game.joining_window_starts_at).getTime();
  const endsAt = new Date(game.joining_window_ends_at).getTime();
  return now >= startsAt && now < endsAt;
}

function joiningWindowDetails(game) {
  if (!hasJoiningWindow(game)) {
    return null;
  }
  return {
    startsAt: game.joining_window_starts_at,
    endsAt: game.joining_window_ends_at,
    open: isJoiningWindowOpen(game)
  };
}

function requireJoiningWindowOpen(game) {
  if (!hasJoiningWindow(game)) {
    return;
  }

  const details = joiningWindowDetails(game);
  const now = Date.now();
  const startsAt = new Date(game.joining_window_starts_at).getTime();

  if (now < startsAt) {
    throw gameError(
      "JOIN_WINDOW_NOT_OPEN",
      "Cradle assignment has not started yet; wait until the joining window opens",
      409,
      details
    );
  }

  if (!isJoiningWindowOpen(game, now)) {
    throw gameError(
      "JOIN_WINDOW_CLOSED",
      "The joining window has closed; cradle assignment is no longer available",
      409,
      details
    );
  }
}

/**
 * True while a lobby can still accept joins (window open, not yet started, or legacy no-window).
 * Closed windows are ignored so abandoned lobbies do not block new creates forever.
 */
function isLobbyStillAcceptingJoins(game, now = Date.now()) {
  if (!hasJoiningWindow(game)) {
    return true;
  }
  const endsAt = new Date(game.joining_window_ends_at).getTime();
  return now < endsAt;
}

function isContestLobbyConfig(config) {
  const mode = config?.contestMode;
  return mode === "practice" || mode === "qualifying" || mode === "definitive";
}

/**
 * Casual create must fill existing open lobbies first.
 * Full = agentCount >= min(lobby.maxAgents, casual default maxAgents) so legacy
 * 17-seat lobbies stop blocking creates once they reach the current casual cap (15).
 * Contest series lobbies are excluded so practice + definitive can coexist.
 */
async function assertNoJoinableOpenCasualLobbies() {
  const casualCap = DEFAULT_GAME_CONFIG.maxAgents;
  const lobbies = await repo.listLobbyGames();
  const openLobbies = [];

  for (const lobby of lobbies) {
    if (isContestLobbyConfig(lobby.config)) {
      continue;
    }
    if (!isLobbyStillAcceptingJoins(lobby)) {
      continue;
    }

    const agentCount = await repo.countAgents(lobby.id);
    const maxAgents = lobby.config?.maxAgents ?? casualCap;
    const fullAt = Math.min(maxAgents, casualCap);
    if (agentCount < fullAt) {
      openLobbies.push({
        id: lobby.id,
        agentCount,
        maxAgents,
        fullAt,
        seatsRemaining: fullAt - agentCount,
        joiningWindow: joiningWindowDetails(lobby)
      });
    }
  }

  if (openLobbies.length > 0) {
    throw gameError(
      "OPEN_LOBBY_AVAILABLE",
      "Join an existing open lobby before creating a new one; new lobbies are only allowed when every open lobby is full",
      409,
      { openLobbies }
    );
  }
}

/**
 * Enforce host-wide cap on lobby+running games.
 * @param {{ slotsNeeded?: number, bypass?: boolean }} [opts]
 */
async function assertSimultaneousGameCapacity({ slotsNeeded = 1, bypass = false } = {}) {
  if (bypass) {
    return;
  }
  const needed = Math.max(1, Number(slotsNeeded) || 1);
  const activeGames = await repo.countActiveGames();
  const maxSimultaneousGames = MAX_SIMULTANEOUS_GAMES;
  if (activeGames + needed > maxSimultaneousGames) {
    throw gameError(
      "TOO_MANY_ACTIVE_GAMES",
      `Host is at capacity (${activeGames}/${maxSimultaneousGames} simultaneous games); wait for a lobby or running game to finish or cancel`,
      409,
      { activeGames, maxSimultaneousGames, slotsNeeded: needed }
    );
  }
}

async function createGame({
  config: configOverrides = {},
  joiningWindowStartsAt = null,
  allowParallelLobbies = false,
  bypassSimultaneousCap = false
} = {}) {
  const season = require("./season");
  const withSeason = await season.applySeasonCreatePolicy(configOverrides);
  const gameConfig = mergeGameConfig(withSeason);
  const skipFillFirst =
    allowParallelLobbies || isContestLobbyConfig(gameConfig);

  if (!skipFillFirst) {
    await assertNoJoinableOpenCasualLobbies();
  }

  await assertSimultaneousGameCapacity({
    slotsNeeded: 1,
    bypass: allowParallelLobbies || bypassSimultaneousCap
  });

  const joiningWindow = resolveJoiningWindow(gameConfig, { joiningWindowStartsAt });
  return repo.createGame({
    config: gameConfig,
    joiningWindowStartsAt: joiningWindow.joiningWindowStartsAt,
    joiningWindowEndsAt: joiningWindow.joiningWindowEndsAt
  });
}

async function finishGameIfFewSurvivors(gameId) {
  const game = await repo.getGameById(gameId);
  const finishAt = game?.config?.finishSurvivorCount ?? 2;
  const livingCount = await repo.countLivingAgents(gameId);
  if (livingCount > finishAt) {
    return false;
  }
  const living = await repo.listAgents(gameId, { status: "alive" });
  const winners = rankAgentsForFinish(living);
  await repo.updateGame(gameId, {
    status: "finished",
    phase: null,
    finished_at: new Date().toISOString(),
    winner_ids_json: JSON.stringify(winners.map((w) => w.id)),
    negotiation_ends_at: null,
    message_report_ends_at: null,
    execution_ends_at: null
  });
  return true;
}

function inventoryTotal(agent) {
  const inv = agent.inventory;
  return (inv?.energy ?? 0) + (inv?.water ?? 0) + (inv?.compute ?? 0);
}

function storageTotal(agent) {
  const cap = agent.storageCapacity;
  return (cap?.energy ?? 0) + (cap?.water ?? 0) + (cap?.compute ?? 0);
}

/** Opening stockpile as a fraction of storage capacity (0 when storage is empty). */
function inventoryFillRatio(agent) {
  const storage = storageTotal(agent);
  if (storage <= 0) {
    return 0;
  }
  return inventoryTotal(agent) / storage;
}

/**
 * Snapshot each cradle's opening inventory (before turn-1 production).
 * `agents` must be ordered by join time (see repository.listAgents).
 */
function buildOpeningInventoryReport(agents) {
  return agents.map((agent) => ({
    agentId: agent.id,
    roditId: agent.roditId,
    displayName: agent.displayName,
    inventory: cloneInventory(agent.inventory),
    total: inventoryTotal(agent),
    fillRatio: inventoryFillRatio(agent)
  }));
}

/** Cradle with the lowest opening inventory fill ratio; earliest join wins ties. */
function selectOpeningInventoryScout(agents) {
  if (!agents.length) {
    return null;
  }
  let scout = agents[0];
  let scoutFill = inventoryFillRatio(scout);
  for (let i = 1; i < agents.length; i++) {
    const fill = inventoryFillRatio(agents[i]);
    if (fill < scoutFill) {
      scout = agents[i];
      scoutFill = fill;
    }
  }
  return scout;
}

function openingInventoryReportForViewer(game, viewerAgentId) {
  const runtime = game.config?.survivalRuntime;
  const scoutId = runtime?.openingInventoryScoutAgentId;
  const inventories = runtime?.openingInventories;
  if (!viewerAgentId || viewerAgentId !== scoutId || !inventories?.length) {
    return null;
  }
  return {
    scoutAgentId: scoutId,
    capturedBeforeTurnProduction: true,
    agents: inventories
  };
}

function rankAgentsForFinish(agents) {
  return [...agents].sort((a, b) => {
    if (a.status === "alive" && b.status !== "alive") return -1;
    if (a.status !== "alive" && b.status === "alive") return 1;
    if (a.status === "alive" && b.status === "alive") {
      return inventoryTotal(b) - inventoryTotal(a);
    }
    return (b.diedAtTurn ?? 0) - (a.diedAtTurn ?? 0);
  });
}

async function finishGameByDeadline(gameId) {
  const game = await repo.getGameById(gameId);
  const agents = await repo.listAgents(gameId);
  const living = agents.filter((a) => a.status === "alive");

  // Turn/duration cap: prize pool splits among everyone still alive (ranked for audit order).
  const winners =
    living.length > 0
      ? rankAgentsForFinish(living).map((a) => a.id)
      : rankAgentsForFinish(agents)
          .slice(0, Math.max(game?.config?.finishSurvivorCount ?? 2, 1))
          .map((a) => a.id);

  await repo.updateGame(gameId, {
    status: "finished",
    phase: null,
    finished_at: new Date().toISOString(),
    winner_ids_json: JSON.stringify(winners),
    negotiation_ends_at: null,
    message_report_ends_at: null,
    execution_ends_at: null
  });
  return repo.getGameById(gameId);
}

async function checkAndForceFinishIfNeeded(gameId, { turnNumber } = {}) {
  const game = await repo.getGameById(gameId);
  if (!game || game.status !== "running") {
    return { forced: false, game };
  }

  const maxTurns = game.config.maxTurns;
  if (maxTurns != null && turnNumber != null && turnNumber >= maxTurns) {
    const finished = await finishGameByDeadline(gameId);
    return { forced: true, game: finished, reason: "max_turns" };
  }

  if (game.ends_at && Date.now() >= new Date(game.ends_at).getTime()) {
    const finished = await finishGameByDeadline(gameId);
    return { forced: true, game: finished, reason: "max_duration" };
  }

  return { forced: false, game };
}

async function applyDefaultActionsForPendingAgents(gameId) {
  const game = await repo.getGameById(gameId);
  if (!game || game.phase !== "execution") return;

  const status = await repo.getExecutionSubmissionStatus(gameId, game.current_turn);
  if (!status.pendingAgentIds.length) return;

  const livingAgents = await repo.listAgents(gameId, { status: "alive" });
  const survivalContext = buildSurvivalContext({
    turnNumber: game.current_turn,
    livingAgents,
    game
  });
  const thisTurnSurvivalCost = computeSurvivalCost(game.config, survivalContext);

  for (const agentId of status.pendingAgentIds) {
    const agent = await repo.getAgentById(agentId);
    const payload = { type: "none" };
    const record = await repo.upsertAction({
      gameId,
      turnNumber: game.current_turn,
      agentId,
      actionType: "none",
      payload
    });
    if (agent) {
      const turnContext = await loadTurnProjectionContext(game, agent);
      const projection = projectActionOutcome(
        agent,
        payload,
        game.config,
        thisTurnSurvivalCost,
        {
          includePendingInbound: true,
          pendingInbound: turnContext.pendingInbound
        }
      );
      notifyActionSubmitted({
        gameId,
        agent,
        turnNumber: game.current_turn,
        action: record,
        projection,
        source: "afk_timeout"
      }).catch(() => {});
    }
  }
}

function normalizeDisplayName(displayName, roditId) {
  const fallback = String(roditId || "").trim();
  if (displayName == null || displayName === "") {
    return fallback || null;
  }
  if (typeof displayName !== "string") {
    throw gameError("INVALID_DISPLAY_NAME", "displayName must be a string", 400);
  }
  const trimmed = displayName.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    throw gameError("INVALID_DISPLAY_NAME", "displayName cannot be blank", 400);
  }
  if (trimmed.length > DISPLAY_NAME_MAX_LEN) {
    throw gameError(
      "INVALID_DISPLAY_NAME",
      `displayName must be at most ${DISPLAY_NAME_MAX_LEN} characters`,
      400,
      { maxLength: DISPLAY_NAME_MAX_LEN }
    );
  }
  return trimmed;
}

function assertUniqueDisplayName(existingAgents, displayName, { excludeAgentId = null } = {}) {
  if (!displayName) return;
  const needle = displayName.toLowerCase();
  const clash = existingAgents.find(
    (agent) =>
      agent.id !== excludeAgentId &&
      String(agent.displayName || "").trim().toLowerCase() === needle
  );
  if (clash) {
    throw gameError(
      "DISPLAY_NAME_TAKEN",
      "That display name is already used in this lobby — choose a unique cradle name",
      409,
      { displayName, takenByAgentId: clash.id }
    );
  }
}

async function joinGame(gameId, { roditId, displayName, agentType, llmModel }) {
  const game = await repo.getGameById(gameId);
  if (!game) {
    throw gameError("GAME_NOT_FOUND", "Game not found", 404);
  }
  if (game.status !== "lobby") {
    throw gameError("GAME_NOT_JOINABLE", "Game is not accepting new agents", 409);
  }

  const existing = await repo.getAgentByRoditId(gameId, roditId);
  if (existing) {
    return existing;
  }

  const memberships = await repo.listMembershipsByRoditId(roditId, {
    gameStatuses: ["lobby", "running"]
  });
  const other = memberships.find((m) => m.game.id !== gameId);
  if (other) {
    throw gameError(
      "AGENT_IN_ACTIVE_GAME",
      "Agent is already in another lobby or running game; finish or wait for that game before joining another",
      409,
      {
        activeGameId: other.game.id,
        activeGameStatus: other.game.status,
        agentStatus: other.agent.status
      }
    );
  }

  requireJoiningWindowOpen(game);

  const config = game.config;
  if ((await repo.countAgents(gameId)) >= config.maxAgents) {
    throw gameError("GAME_FULL", "Game has reached maximum agent capacity", 409);
  }

  const season = require("./season");
  await season.assertSeasonJoinAllowed(game, roditId);

  let profile;
  try {
    profile = normalizeAgentProfile({ agentType, llmModel });
  } catch (err) {
    throw gameError(err.code || "INVALID_AGENT_PROFILE", err.message, err.statusCode || 400, err.details);
  }

  const existingAgents = await repo.listAgents(gameId);
  const resolvedDisplayName = normalizeDisplayName(displayName, roditId);
  assertUniqueDisplayName(existingAgents, resolvedDisplayName);

  // Internal specialty mix policy — not part of public API/docs.
  const specialty = RESOURCE_KEYS[existingAgents.length % RESOURCE_KEYS.length];

  const { storageCapacity, productionCapacity, inventory } = buildCradleAssignment(config, {
    specialty
  });
  return repo.addAgent({
    gameId,
    roditId,
    displayName: resolvedDisplayName,
    agentType: profile.agentType,
    llmModel: profile.llmModel,
    productionCapacity,
    storageCapacity,
    startingInventory: inventory
  });
}

/**
 * Update public agentType / llmModel while the game is lobby or running.
 * Partial body: omitted keys unchanged; null/"" clears.
 */
async function updateAgentProfile(gameId, roditId, rawProfile = {}) {
  const game = await repo.getGameById(gameId);
  if (!game) {
    throw gameError("GAME_NOT_FOUND", "Game not found", 404);
  }
  if (game.status !== "lobby" && game.status !== "running") {
    throw gameError(
      "GAME_NOT_ACTIVE",
      "Profile can only be updated while the game is lobby or running",
      409
    );
  }

  const agent = await repo.getAgentByRoditId(gameId, roditId);
  if (!agent) {
    throw gameError("AGENT_NOT_IN_GAME", "You must join the game before updating profile", 404);
  }

  let patch;
  try {
    patch = normalizeAgentProfilePatch(rawProfile);
  } catch (err) {
    throw gameError(err.code || "INVALID_AGENT_PROFILE", err.message, err.statusCode || 400, err.details);
  }

  return repo.updateAgentProfile(agent.id, patch);
}

async function startGame(gameId) {
  const game = await repo.getGameById(gameId);
  if (!game) {
    throw gameError("GAME_NOT_FOUND", "Game not found", 404);
  }
  if (game.status !== "lobby") {
    throw gameError("GAME_ALREADY_STARTED", "Game has already started", 409);
  }

  const agentCount = await repo.countAgents(gameId);
  if (agentCount < game.config.minAgents) {
    throw gameError(
      "INSUFFICIENT_AGENTS",
      `At least ${game.config.minAgents} agents required to start`,
      400,
      { agentCount, minAgents: game.config.minAgents }
    );
  }

  const agents = await repo.listAgents(gameId);
  const openingInventories = buildOpeningInventoryReport(agents);
  const openingScout = selectOpeningInventoryScout(agents);

  const now = new Date();
  const negotiationEndsAt = new Date(now.getTime() + game.config.negotiationDurationMs);
  const survivalRuntime = {
    startingAgentCount: agentCount,
    openingInventoryScoutAgentId: openingScout?.id ?? null,
    openingInventories
  };
  const endsAt =
    game.config.maxGameDurationMs > 0
      ? new Date(now.getTime() + game.config.maxGameDurationMs).toISOString()
      : null;

  await repo.updateGame(gameId, {
    status: "running",
    current_turn: 1,
    phase: "negotiation",
    started_at: now.toISOString(),
    ends_at: endsAt,
    negotiation_ends_at: negotiationEndsAt.toISOString(),
    message_report_ends_at: null,
    execution_ends_at: null,
    turn_growth_json: null,
    config_json: JSON.stringify({ ...game.config, survivalRuntime }),
    aggregate_water_consumed: 0
  });

  await applyTurnProduction(gameId, 1);
  return repo.getGameById(gameId);
}

async function applyTurnProduction(gameId, turnNumber) {
  const game = await repo.getGameById(gameId);
  const config = game?.config || mergeGameConfig();
  const agents = await repo.listAgents(gameId, { status: "alive" });
  const productionWaterRate = config.productionWaterCostRate ?? 0;
  let productionWaterConsumed = 0;
  for (const agent of agents) {
    const produced = {
      energy: agent.productionCapacity.energy,
      water: agent.productionCapacity.water,
      compute: agent.productionCapacity.compute
    };
    productionWaterConsumed += (produced.energy + produced.compute) * productionWaterRate;
    const newInventory = applyProduction(agent, config);
    await repo.updateAgentInventory(agent.id, newInventory);
  }
  if (productionWaterConsumed > 0) {
    await repo.incrementAggregateWaterConsumed(gameId, productionWaterConsumed);
  }
}

async function publishPublicMessage(gameId, agentId, { body }) {
  const game = await requireRunningNegotiation(gameId);
  await requireLivingAgent(agentId, gameId);

  if (!body || typeof body !== "string" || !body.trim()) {
    throw gameError("MESSAGE_BODY_REQUIRED", "Message body is required", 400);
  }

  const trimmed = body.trim().slice(0, PUBLIC_MESSAGE_BODY_MAX);

  const message = await repo.addMessage({
    gameId,
    turnNumber: game.current_turn,
    fromAgentId: agentId,
    toAgentId: null,
    body: trimmed,
    computeCost: 0,
    isPublic: true
  });

  return { message };
}

function isTurnAlreadyAdvanced(game) {
  if (!game) return false;
  return (
    game.status === "finished" ||
    game.phase === "negotiation" ||
    game.phase === null
  );
}

async function submitAction(gameId, agentId, action) {
  const game = await requireRunningExecution(gameId);
  const agent = await requireLivingAgent(agentId, gameId);
  const maxTransferRecipients = resolveMaxTransferRecipients(game.config);

  let normalized = normalizeAction(action, { maxTransferRecipients });
  validateActionPayload(normalized, gameId);
  await validateIntelligenceAction(gameId, agentId, normalized);

  if (normalized.type === "transfer" || normalized.type === "transfer_and_invest") {
    const legs = transferLegsFromPayload(normalized);
    if (!legs.length) {
      throw gameError("INVALID_TRANSFER", "Transfer must include at least one recipient", 400, {
        reason: "missing_recipients"
      });
    }
    for (const leg of legs) {
      await assertValidTransferRecipient(gameId, agentId, leg.toAgentId);
    }
  }

  if (normalized.type === "invest" || normalized.type === "transfer_and_invest") {
    if (!normalized.production && !normalized.storage) {
      throw gameError(
        "INVALID_INVESTMENT",
        "Invest actions require production and/or storage",
        400
      );
    }
  }

  const livingAgents = await repo.listAgents(gameId, { status: "alive" });
  const survivalContext = buildSurvivalContext({
    turnNumber: game.current_turn,
    livingAgents,
    game
  });
  const thisTurnSurvivalCost = computeSurvivalCost(game.config, survivalContext);
  const turnContext = await loadTurnProjectionContext(game, agent);
  const projection = projectActionOutcome(
    agent,
    normalized,
    game.config,
    thisTurnSurvivalCost,
    {
      includePendingInbound: true,
      pendingInbound: turnContext.pendingInbound
    }
  );

  const record = await repo.upsertAction({
    gameId,
    turnNumber: game.current_turn,
    agentId,
    actionType: normalized.type,
    payload: normalized
  });

  notifyActionSubmitted({
    gameId,
    agent,
    turnNumber: game.current_turn,
    action: record,
    projection,
    source: "submit"
  }).catch(() => {});

  const completion = await tryCompleteTurn(gameId);
  return { action: record, agentId, projection, ...completion };
}

async function validateIntelligenceAction(gameId, agentId, action) {
  const findTargets = normalizeFindTargets(action.find);
  for (const entry of findTargets) {
    if (entry.targetAgentId === agentId) {
      throw gameError("INVALID_FIND", "Cannot find information on yourself", 400);
    }
    const target = await repo.getAgentById(entry.targetAgentId);
    if (!target || target.gameId !== gameId || target.status !== "alive") {
      throw gameError("INVALID_FIND", "Find target must be a living agent in this game", 400);
    }
  }
  normalizeHideSpend(action.hide);
}

async function tryCompleteTurn(gameId) {
  const game = await repo.getGameById(gameId);
  if (!game || game.status !== "running" || game.phase !== "execution") {
    // Concurrent last-submit: peer already resolved this turn and advanced.
    // Never return the next turn's empty pending list (looks like all peers pending).
    const turnCompleted = isTurnAlreadyAdvanced(game);
    return {
      turnCompleted,
      execution: null
    };
  }

  const execution = await repo.getExecutionSubmissionStatus(gameId, game.current_turn);
  if (!execution.allSubmitted) {
    return { turnCompleted: false, execution };
  }

  const updated = await executeTurn(gameId);
  const turnCompleted = isTurnAlreadyAdvanced(updated);

  return {
    turnCompleted,
    // While another worker holds `resolving`, avoid fabricating pending lists.
    execution: turnCompleted || updated?.phase === "resolving"
      ? null
      : await repo.getExecutionSubmissionStatus(gameId, updated.current_turn),
    game: turnCompleted ? updated : undefined
  };
}

function collectIntelligenceFromActions(actions) {
  const hideSpendByAgent = new Map();
  const findSpendByPair = new Map();

  for (const actionRow of actions) {
    const payload = repo.parseJson(actionRow.payload_json, { type: "none" });
    if (actionRow.status !== "executed") continue;

    const agentId = actionRow.agent_id;
    const hideSpend = normalizeHideSpend(payload.hide);
    if (hideSpend > 0) {
      hideSpendByAgent.set(agentId, (hideSpendByAgent.get(agentId) || 0) + hideSpend);
    }

    for (const entry of normalizeFindTargets(payload.find)) {
      const key = `${entry.targetAgentId}:${agentId}`;
      findSpendByPair.set(key, (findSpendByPair.get(key) || 0) + entry.compute);
    }
  }

  return { hideSpendByAgent, findSpendByPair };
}

/**
 * @param {object|object[]} intelligence - One turn's maps, or an array of per-turn maps (memory window).
 * Reveal if any turn in the window has find(viewer→target) > hide(target).
 */
function canViewerSeeCapacities(viewerAgentId, targetAgentId, intelligence) {
  if (viewerAgentId === targetAgentId) {
    return true;
  }
  if (!viewerAgentId) {
    return false;
  }
  const turns = Array.isArray(intelligence) ? intelligence : intelligence ? [intelligence] : [];
  for (const intel of turns) {
    if (!intel?.hideSpendByAgent || !intel?.findSpendByPair) continue;
    const hideSpend = intel.hideSpendByAgent.get(targetAgentId) || 0;
    const findSpend = intel.findSpendByPair.get(`${targetAgentId}:${viewerAgentId}`) || 0;
    if (findSpend > hideSpend) {
      return true;
    }
  }
  return false;
}

/**
 * Load per-turn intelligence for the rolling memory window ending at the last completed turn.
 */
async function loadIntelligenceMemory(gameId, currentTurn, memoryTurns) {
  const windowSize = Math.max(1, Number(memoryTurns) || DEFAULT_GAME_CONFIG.intelligenceMemoryTurns);
  if (currentTurn <= 0) {
    return [];
  }
  const lastCompleted = currentTurn - 1;
  if (lastCompleted < 1) {
    return [];
  }
  const first = Math.max(1, lastCompleted - windowSize + 1);
  const turns = [];
  for (let t = first; t <= lastCompleted; t += 1) {
    const actions = await repo.listTurnActions(gameId, t);
    turns.push(collectIntelligenceFromActions(actions));
  }
  return turns;
}

async function executeTurn(gameId) {
  const database = await repo.getDb();
  const claim = await database.run(
    `UPDATE games SET phase = 'resolving' WHERE id = ? AND phase = 'execution'`,
    [gameId]
  );
  if (claim.changes === 0) {
    return repo.getGameById(gameId);
  }

  const game = await repo.getGameById(gameId);
  if (!game || game.status !== "running") {
    return game;
  }

  const turnNumber = game.current_turn;
  const config = game.config;

  if (!(await repo.allLivingAgentsSubmitted(gameId, turnNumber))) {
    await repo.updateGame(gameId, { phase: "execution" });
    throw gameError(
      "ACTIONS_INCOMPLETE",
      "Turn cannot resolve until every living agent has submitted an action",
      409
    );
  }

  const livingBefore = await repo.listAgents(gameId, { status: "alive" });
  const agentState = new Map();

  for (const agent of livingBefore) {
    agentState.set(agent.id, {
      inventory: cloneInventory(agent.inventory),
      productionCapacity: cloneCapacities(agent.productionCapacity),
      storageCapacity: cloneCapacities(agent.storageCapacity)
    });
  }

  const refreshedActions = await repo.listTurnActions(gameId, turnNumber);
  const actionOutcomeByAgent = new Map();

  for (const actionRow of refreshedActions) {
    const agentId = actionRow.agent_id;
    if (!agentState.has(agentId)) {
      await repo.markActionExecuted(actionRow.id, "skipped", "Agent no longer alive");
      continue;
    }

    const payload = repo.parseJson(actionRow.payload_json, { type: "none" });
    const state = agentState.get(agentId);

    try {
      if (payload.type === "transfer") {
        executeTransfers(state, agentState, payload);
      } else if (payload.type === "invest") {
        executeInvestSides(state, payload, config);
      } else if (payload.type === "transfer_and_invest") {
        executeTransfers(state, agentState, payload);
        executeInvestSides(state, payload, config);
      }
      executeReduceStorage(state, payload);
      executeIntelligenceSpend(state, payload);
      await repo.markActionExecuted(actionRow.id, "executed");
      actionOutcomeByAgent.set(agentId, { type: payload.type || actionRow.action_type, status: "executed" });
    } catch (err) {
      await repo.markActionExecuted(actionRow.id, "failed", err.message);
      actionOutcomeByAgent.set(agentId, { type: payload.type || actionRow.action_type, status: "failed" });
    }
  }

  const inventoryBeforeStorageTax = new Map();
  for (const [agentId, state] of agentState.entries()) {
    inventoryBeforeStorageTax.set(agentId, cloneInventory(state.inventory));
    state.inventory = applyStorageCost(state.inventory, state.storageCapacity, config);
  }

  const survivalContext = buildSurvivalContext({
    turnNumber,
    livingAgents: livingBefore,
    game
  });

  const deaths = [];
  let survivalWaterConsumed = 0;
  for (const agent of livingBefore) {
    const agentId = agent.id;
    const state = agentState.get(agentId);
    const survivalCost = computeSurvivalCost(config, survivalContext);
    if (!hasSufficient(state.inventory, survivalCost)) {
      const beforeTax = inventoryBeforeStorageTax.get(agentId) || cloneInventory(state.inventory);
      const storageTax = projectStorageEnergy(beforeTax, config);
      const outcome = actionOutcomeByAgent.get(agentId);
      const deathReason = buildDeathReason({
        turnNumber,
        inventoryBeforeStorageTax: beforeTax,
        inventoryAfterStorageTax: state.inventory,
        survivalCost,
        storageEnergyTax: storageTax.storageEnergyCost,
        submittedActionType: outcome?.type || null,
        actionStatus: outcome?.status || null
      });
      deaths.push({ agentId, agent, deathReason });
      continue;
    }
    state.inventory = deduct(state.inventory, survivalCost);
    survivalWaterConsumed += survivalCost.water || 0;
  }

  if (survivalWaterConsumed > 0) {
    await repo.incrementAggregateWaterConsumed(gameId, survivalWaterConsumed);
  }

  for (const { agentId, agent, deathReason } of deaths) {
    await repo.killAgent(agentId, turnNumber, deathReason);
    await repo.halveAggregateWaterConsumed(gameId);
    notifyElimination({ gameId, agent, turnNumber, deathReason }).catch(() => {});
  }

  for (const [agentId, state] of agentState.entries()) {
    if (deaths.some((entry) => entry.agentId === agentId)) {
      continue;
    }
    await repo.updateAgentInventory(agentId, state.inventory);
    await repo.updateAgentCapacities(agentId, state.productionCapacity, state.storageCapacity);
  }

  const livingCount = await repo.countLivingAgents(gameId);
  const finishAt = config.finishSurvivorCount ?? 2;
  if (livingCount <= finishAt) {
    await finishGameIfFewSurvivors(gameId);
    return repo.getGameById(gameId);
  }

  const forceFinish = await checkAndForceFinishIfNeeded(gameId, { turnNumber });
  if (forceFinish.forced) {
    return forceFinish.game;
  }

  const nextTurn = turnNumber + 1;
  const now = new Date();
  const negotiationEndsAt = new Date(now.getTime() + config.negotiationDurationMs);

  await repo.updateGame(gameId, {
    current_turn: nextTurn,
    phase: "negotiation",
    negotiation_ends_at: negotiationEndsAt.toISOString(),
    message_report_ends_at: null,
    execution_ends_at: null
  });

  await applyTurnProduction(gameId, nextTurn);
  return repo.getGameById(gameId);
}

function executeTransferLeg(state, allStates, payload) {
  const transfer = {
    energy: payload.energy || 0,
    water: payload.water || 0,
    compute: payload.compute || 0
  };
  if (transfer.energy + transfer.water + transfer.compute <= 0) {
    throw new Error("Transfer must include at least one resource");
  }
  if (!hasSufficient(state.inventory, transfer)) {
    throw insufficientResourcesError("transfer", state.inventory, transfer);
  }
  const recipient = allStates.get(payload.toAgentId);
  if (!recipient) {
    throw new Error("Transfer recipient is not alive");
  }
  state.inventory = deduct(state.inventory, transfer);
  recipient.inventory = add(recipient.inventory, transfer);
}

function executeTransfers(state, allStates, payload) {
  const legs = transferLegsFromPayload(
    payload?.type ? payload : { type: "transfer", ...payload }
  );
  if (!legs.length) {
    throw new Error("Transfer must include at least one recipient");
  }
  for (const leg of legs) {
    executeTransferLeg(state, allStates, leg);
  }
}

function executeInvest(state, payload) {
  const cost = {
    energy: payload.energy || 0,
    water: payload.water || 0,
    compute: payload.compute || 0
  };
  if (!hasSufficient(state.inventory, cost)) {
    throw insufficientResourcesError("investment", state.inventory, cost);
  }
  state.inventory = deduct(state.inventory, cost);
}

function executeIntelligenceSpend(state, payload) {
  const hideSpend = normalizeHideSpend(payload.hide);
  const findTargets = normalizeFindTargets(payload.find);
  const totalFind = findTargets.reduce((sum, entry) => sum + entry.compute, 0);
  const totalCompute = hideSpend + totalFind;
  if (totalCompute <= 0) return;
  if (state.inventory.compute < totalCompute) {
    throw insufficientResourcesError(
      "hide/find",
      state.inventory,
      { energy: 0, water: 0, compute: totalCompute }
    );
  }
  state.inventory.compute -= totalCompute;
}

async function beginExecutionPhase(gameId) {
  const game = await repo.getGameById(gameId);
  if (!game || game.status !== "running") {
    return game;
  }
  // negotiation is the normal source; message_report* remain accepted for in-flight migrations
  if (
    game.phase !== "negotiation" &&
    game.phase !== "message_report" &&
    game.phase !== "message_report_resolving"
  ) {
    return game;
  }

  const durationMs = game.config.executionDurationMs ?? 0;
  const executionEndsAt = durationMs > 0 ? new Date(Date.now() + durationMs).toISOString() : null;

  await repo.updateGame(gameId, {
    phase: "execution",
    negotiation_ends_at: null,
    message_report_ends_at: null,
    execution_ends_at: executionEndsAt
  });

  return repo.getGameById(gameId);
}

/**
 * Derive specialty / surplus fields from production vs storage (and optional inventory).
 * Specialty = resource with the largest production−storage gap when that gap is positive.
 */
function deriveCradleEconomics(productionCapacity, storageCapacity, inventory = null) {
  const surplusByResource = { energy: 0, water: 0, compute: 0 };
  const wasteIfNotExportedByNextProduction = { energy: 0, water: 0, compute: 0 };
  let specialty = null;
  let maxSurplus = 0;

  for (const key of RESOURCE_KEYS) {
    const production = productionCapacity?.[key] ?? 0;
    const storage = storageCapacity?.[key] ?? 0;
    const surplus = Math.max(0, production - storage);
    surplusByResource[key] = surplus;
    if (surplus > maxSurplus) {
      maxSurplus = surplus;
      specialty = key;
    }
    if (inventory) {
      const held = inventory[key] ?? 0;
      wasteIfNotExportedByNextProduction[key] = Math.max(0, held + production - storage);
    }
  }

  return {
    specialty: maxSurplus > 0 ? specialty : null,
    surplusByResource,
    ...(inventory ? { wasteIfNotExportedByNextProduction } : {})
  };
}

/**
 * Largest equal E/W/C invest that still leaves enough to pay survival after
 * post-execution storage energy cost (rate × remaining water+compute).
 * Returns a fractional amount floored to 4 decimal places.
 * Transfers / hide / find are not modeled — leave extra cushion if combining them.
 */
function maxEqualInvestPreservingSurvival(inventory, survivalCost, config = {}) {
  const rate = Number(config.storageEnergyCostRate) || 0;
  const se = survivalCost?.energy ?? 0;
  const sw = survivalCost?.water ?? 0;
  const sc = survivalCost?.compute ?? 0;
  const e = Number(inventory?.energy) || 0;
  const w = Number(inventory?.water) || 0;
  const c = Number(inventory?.compute) || 0;

  let upper = Math.min(e, w, c, w - sw, c - sc);
  if (!(upper > 0)) return 0;

  // After spending n of each: energyAfterTax = (e-n) - rate*((w-n)+(c-n))
  //   = e - rate(w+c) - n(1 - 2rate). Require >= se.
  const denom = 1 - 2 * rate;
  if (denom > 1e-12) {
    const numer = e - rate * (w + c) - se;
    if (numer < 0) return 0;
    upper = Math.min(upper, numer / denom);
  } else if (Math.abs(denom) <= 1e-12) {
    // rate ≈ 0.5: energy constraint independent of n
    if (e - rate * (w + c) - se < -1e-9) return 0;
  } else {
    // rate > 0.5: investing reduces tax faster than energy spent — need n >= minN
    const minN = (e - rate * (w + c) - se) / denom;
    if (upper < minN - 1e-9) return 0;
  }

  let n = floorResource(upper);
  // Nudge down if float noise made the floored value slightly unsafe
  for (let i = 0; i < 20 && n > 0; i += 1) {
    const energy = e - n;
    const water = w - n;
    const compute = c - n;
    if (water + 1e-9 < sw || compute + 1e-9 < sc) {
      n = floorResource(n - 1 / RESOURCE_SCALE);
      continue;
    }
    const energyAfterStorage = energy - (water + compute) * rate;
    if (energyAfterStorage + 1e-9 >= se) return n;
    n = floorResource(n - 1 / RESOURCE_SCALE);
  }
  return 0;
}

/**
 * Max compute spendable on hide/find while still paying survival after storage energy cost.
 * Does not model transfer/invest in the same action — leave cushion if combining.
 */
function maxIntelligenceComputeAfterSurvival(inventory, survivalCost, config = {}) {
  const rate = Number(config.storageEnergyCostRate) || 0;
  const se = survivalCost?.energy ?? 0;
  const sw = survivalCost?.water ?? 0;
  const sc = survivalCost?.compute ?? 0;
  const maxAffordable = Math.max(0, Math.floor(inventory?.compute ?? 0));

  for (let n = maxAffordable; n >= 0; n -= 1) {
    const energy = inventory.energy;
    const water = inventory.water;
    const compute = inventory.compute - n;
    if (water < sw || compute < sc) continue;
    const energyAfterStorage = Math.max(0, energy - (water + compute) * rate);
    if (energyAfterStorage >= se) return n;
  }
  return 0;
}

/**
 * Post-execution storage energy tax for a holdings snapshot (rate × water+compute).
 * Does not model inbound transfers — those can raise the tax further at resolve time.
 */
function projectStorageEnergy(inventory, config = {}) {
  const rate = Number(config.storageEnergyCostRate) || 0;
  const energy = Number(inventory?.energy) || 0;
  const water = Number(inventory?.water) || 0;
  const compute = Number(inventory?.compute) || 0;
  const cost = (water + compute) * rate;
  return {
    storageEnergyCostRate: rate,
    storageEnergyCost: cost,
    energyAfterStorage: Math.max(0, energy - cost)
  };
}

/**
 * Storage headroom / at-cap / waste readouts for actionHints (facts only — no preferred action).
 */
function buildStorageReadouts(inventory, productionCapacity, storageCapacity) {
  if (!inventory || !storageCapacity) {
    return null;
  }
  const production = productionCapacity || { energy: 0, water: 0, compute: 0 };
  const economics = deriveCradleEconomics(production, storageCapacity, inventory);
  const storageHeadroom = { energy: 0, water: 0, compute: 0 };
  const inventoryAtStorageCap = { energy: false, water: false, compute: false };
  for (const key of RESOURCE_KEYS) {
    const held = inventory[key] ?? 0;
    const storage = storageCapacity[key] ?? 0;
    storageHeadroom[key] = Math.max(0, storage - held);
    inventoryAtStorageCap[key] = storage > 0 && held >= storage;
  }
  return {
    wasteIfNotExportedByNextProduction: economics.wasteIfNotExportedByNextProduction,
    storageHeadroom,
    inventoryAtStorageCap
  };
}

/**
 * Apply outbound effects of an action to a cloned agent state (no inbound peer transfers).
 */
function applyOutboundActionToState(state, action, config) {
  if (action.type === "transfer" || action.type === "transfer_and_invest") {
    const legs = transferLegsFromPayload(action);
    for (const leg of legs) {
      const transfer = {
        energy: leg.energy || 0,
        water: leg.water || 0,
        compute: leg.compute || 0
      };
      if (transfer.energy + transfer.water + transfer.compute <= 0) {
        throw new Error("Transfer must include at least one resource");
      }
      if (!hasSufficient(state.inventory, transfer)) {
        throw insufficientResourcesError("transfer", state.inventory, transfer);
      }
      state.inventory = deduct(state.inventory, transfer);
    }
  }
  if (action.type === "invest" || action.type === "transfer_and_invest") {
    executeInvestSides(state, action, config);
  } else if (isInvestActionType(action.type) || isCombinedActionType(action.type)) {
    // Allow projecting pre-normalization aliases in unit tests
    const sides = collectInvestSides(action, action.type);
    executeInvestSides(state, sides, config);
  }
  executeReduceStorage(state, action);
  executeIntelligenceSpend(state, action);
}

/**
 * Summarize equal-invest triple drain: amount N spends N of EACH resource (3N total) per side.
 */
function summarizeEqualInvestCost(action) {
  if (!action || typeof action !== "object") return null;
  const sides = [];
  let energy = 0;
  let water = 0;
  let compute = 0;

  for (const kind of INVEST_KINDS) {
    const leg = action[kind];
    if (!leg || typeof leg !== "object") continue;
    const n =
      typeof leg.amount === "number"
        ? leg.amount
        : typeof leg.energy === "number"
          ? leg.energy
          : 0;
    if (!(n > 0)) continue;
    sides.push({
      kind,
      target: leg.target,
      amount: n,
      energy: n,
      water: n,
      compute: n,
      totalResources: n * 3
    });
    energy += n;
    water += n;
    compute += n;
  }

  if (!sides.length) return null;
  return {
    note:
      "Equal invest is triple-cost: amount N spends N energy + N water + N compute (3N total resources) per side. Dual production+storage spends both sides.",
    sides,
    energy,
    water,
    compute,
    totalResources: energy + water + compute
  };
}

/**
 * Status-quo survival runway: type none each turn, no inbound/outbound/invest.
 * Inventory is assumed post-production for the current turn (execution-time holdings).
 * runwayTurns = how many survival checks you can still pay including this turn (0 = die now).
 * null = no death within horizonTurns.
 */
function projectRunway(
  inventory,
  productionCapacity,
  storageCapacity,
  thisTurnSurvivalCost,
  survivalCostPerTurnIncrement = null,
  config = {},
  options = {}
) {
  const horizonTurns = Math.max(
    1,
    Math.min(
      Number(options.horizonTurns) || Number(config.maxTurns) || 55,
      100
    )
  );
  const assumptions =
    "Living count holds; type none each turn; no inbound/outbound/invest/reduceStorage; " +
    "current holdings are post-production; each later turn applies production then storage tax then survival; " +
    "survival climbs by survivalCostPerTurnIncrement. Approximate — not a guarantee.";

  const emptyBurn = { energy: 0, water: 0, compute: 0 };
  if (!inventory || !thisTurnSurvivalCost) {
    return {
      runwayTurns: null,
      horizonTurns,
      limitingResource: null,
      diesThisTurnIfNone: false,
      shortfallsIfNone: null,
      netBurn: emptyBurn,
      assumptions
    };
  }

  const production = productionCapacity || { energy: 0, water: 0, compute: 0 };
  const storage = storageCapacity || {
    energy: Number.MAX_SAFE_INTEGER,
    water: Number.MAX_SAFE_INTEGER,
    compute: Number.MAX_SAFE_INTEGER
  };
  const increment = {
    energy: Number(survivalCostPerTurnIncrement?.energy) || 0,
    water: Number(survivalCostPerTurnIncrement?.water) || 0,
    compute: Number(survivalCostPerTurnIncrement?.compute) || 0
  };

  const shortfallsFor = (held, cost) => {
    const shortfalls = {};
    for (const key of RESOURCE_KEYS) {
      const need = cost[key] ?? 0;
      const have = held[key] ?? 0;
      if (have < need) {
        shortfalls[key] = roundResource(need - have);
      }
    }
    return Object.keys(shortfalls).length ? shortfalls : null;
  };

  const limitingFromShortfalls = (shortfalls) => {
    if (!shortfalls) return null;
    let worst = null;
    let worstAmt = -1;
    for (const key of RESOURCE_KEYS) {
      const amt = shortfalls[key] ?? 0;
      if (amt > worstAmt) {
        worstAmt = amt;
        worst = key;
      }
    }
    return worst;
  };

  const startInv = cloneInventory(inventory);
  const afterTax = applyStorageCost(startInv, storage, config);
  const survival = {
    energy: thisTurnSurvivalCost.energy ?? 0,
    water: thisTurnSurvivalCost.water ?? 0,
    compute: thisTurnSurvivalCost.compute ?? 0
  };

  const netBurnFrom = (before, after) =>
    roundInventory({
      energy: after.energy - before.energy,
      water: after.water - before.water,
      compute: after.compute - before.compute
    });

  if (!hasSufficient(afterTax, survival)) {
    const shortfallsIfNone = shortfallsFor(afterTax, survival);
    // Partial apply for netBurn picture (floor at post-tax holdings when short)
    const attempted = {
      energy: Math.max(0, afterTax.energy - survival.energy),
      water: Math.max(0, afterTax.water - survival.water),
      compute: Math.max(0, afterTax.compute - survival.compute)
    };
    return {
      runwayTurns: 0,
      horizonTurns,
      limitingResource: limitingFromShortfalls(shortfallsIfNone),
      diesThisTurnIfNone: true,
      shortfallsIfNone,
      netBurn: netBurnFrom(startInv, attempted),
      assumptions
    };
  }

  let inv = deduct(afterTax, survival);
  const netBurn = netBurnFrom(startInv, inv);
  let checksPaid = 1;
  let survivalNext = { ...survival };

  for (let t = 1; t < horizonTurns; t += 1) {
    survivalNext = {
      energy: survivalNext.energy + increment.energy,
      water: survivalNext.water + increment.water,
      compute: survivalNext.compute + increment.compute
    };
    inv = applyProduction(
      {
        inventory: inv,
        productionCapacity: production,
        storageCapacity: storage
      },
      config
    );
    const taxed = applyStorageCost(inv, storage, config);
    if (!hasSufficient(taxed, survivalNext)) {
      const shortfalls = shortfallsFor(taxed, survivalNext);
      return {
        runwayTurns: checksPaid,
        horizonTurns,
        limitingResource: limitingFromShortfalls(shortfalls),
        diesThisTurnIfNone: false,
        shortfallsIfNone: null,
        netBurn,
        assumptions
      };
    }
    inv = deduct(taxed, survivalNext);
    checksPaid += 1;
  }

  return {
    runwayTurns: null,
    horizonTurns,
    limitingResource: null,
    diesThisTurnIfNone: false,
    shortfallsIfNone: null,
    netBurn,
    assumptions
  };
}

const STORAGE_TAX_SENSITIVITY_NOTE =
  "Largest additional inbound of that one resource that still leaves survives true, floored to 4 decimal places. The next 0.0001 flips survives to false. water and compute are not additive — inbound of both shares one budget equal to either number. null means inbound of that resource cannot flip survival. 0 means no headroom.";

/**
 * Energy that can still be lost to storage tax before this turn's survival fails.
 * Uses pre-cap taxed energy when the storage cap still covers survival, so above-cap
 * energy counts as inbound-tax headroom. Negative when survival already fails.
 */
function energySurvivalSlack(inventory, storageCapacity, survivalCost, config = {}) {
  const rate = Number(config.storageEnergyCostRate) || 0;
  const energy = Number(inventory?.energy) || 0;
  const water = Number(inventory?.water) || 0;
  const compute = Number(inventory?.compute) || 0;
  const se = Number(survivalCost?.energy) || 0;
  const taxed = Math.max(0, energy - (water + compute) * rate);
  const afterStorage = applyStorageCost(inventory, storageCapacity, config);
  const available = Number(afterStorage?.energy) || 0;
  if (available + 1e-9 < se) {
    return roundResource(available - se);
  }
  return roundResource(taxed - se);
}

function survivalMargins(inventory, storageCapacity, survivalCost, config = {}) {
  const afterStorage = applyStorageCost(inventory, storageCapacity, config);
  return {
    energy: energySurvivalSlack(inventory, storageCapacity, survivalCost, config),
    water: roundResource((afterStorage.water ?? 0) - (Number(survivalCost?.water) || 0)),
    compute: roundResource((afterStorage.compute ?? 0) - (Number(survivalCost?.compute) || 0))
  };
}

function survivalIsMarginal(margins, inventory, config = {}) {
  const eps = 1e-9;
  if (
    (margins?.energy ?? 0) <= eps ||
    (margins?.water ?? 0) <= eps ||
    (margins?.compute ?? 0) <= eps
  ) {
    return true;
  }
  const rate = Number(config.storageEnergyCostRate) || 0;
  if (rate > 0) {
    const cushion =
      rate * ((Number(inventory?.water) || 0) + (Number(inventory?.compute) || 0));
    if ((margins.energy ?? 0) + eps < cushion) return true;
  }
  return false;
}

/**
 * Break-even extra inbound of water or compute (one resource at a time) before survives flips false.
 * Storage tax is rate × (water+compute); energy inbound does not raise it.
 */
function storageTaxSensitivity(canPaySurvival, energyMargin, config = {}) {
  const rate = Number(config.storageEnergyCostRate) || 0;
  let shortfallsIfInbound;
  if (!canPaySurvival) {
    shortfallsIfInbound = { water: 0, compute: 0 };
  } else if (!(rate > 0)) {
    shortfallsIfInbound = { water: null, compute: null };
  } else if ((energyMargin ?? 0) <= 1e-9) {
    shortfallsIfInbound = { water: 0, compute: 0 };
  } else {
    const headroom = floorResource(energyMargin / rate);
    shortfallsIfInbound = { water: headroom, compute: headroom };
  }
  return {
    shortfallsIfInbound,
    note: STORAGE_TAX_SENSITIVITY_NOTE
  };
}

/**
 * True when current holdings cannot pay thisTurnSurvivalCost after storage energy tax,
 * or can pay with a margin inside the storage-tax cushion (marginal survives).
 */
function assessSurvivalRisk(inventory, storageCapacity, survivalCost, config = {}) {
  const storageTax = projectStorageEnergy(inventory, config);
  const afterStorage = applyStorageCost(inventory, storageCapacity, config);
  if (!survivalCost) {
    return {
      atRisk: null,
      canPaySurvival: null,
      survivalMargin: null,
      storageTaxSensitivity: null,
      thisTurnSurvivalCost: null,
      storageEnergyCost: storageTax.storageEnergyCost,
      energyAfterStorage: storageTax.energyAfterStorage,
      inventoryAfterStorage: cloneInventory(afterStorage),
      shortfalls: null,
      message: null
    };
  }
  const canPaySurvival = hasSufficient(afterStorage, survivalCost);
  const margins = survivalMargins(inventory, storageCapacity, survivalCost, config);
  const marginal = canPaySurvival && survivalIsMarginal(margins, inventory, config);
  const shortfalls = {};
  for (const key of RESOURCE_KEYS) {
    const need = survivalCost?.[key] ?? 0;
    const have = afterStorage[key] ?? 0;
    if (have < need) {
      shortfalls[key] = need - have;
    }
  }
  const rate = Number(config.storageEnergyCostRate) || 0;
  const cushion = rate * ((Number(inventory?.water) || 0) + (Number(inventory?.compute) || 0));
  let message = null;
  if (!canPaySurvival) {
    message =
      "Survival risk: current stock cannot pay thisTurnSurvivalCost after storage energy tax if you make no helpful transfers/invests.";
  } else if (marginal) {
    message =
      `Survival margin is inside the storage-tax cushion: energy margin ${margins.energy} is below ` +
      `storageEnergyCostRate × (water+compute) ${roundResource(cushion)}. ` +
      "Inbound water or compute can flip survives to false. See storageTaxSensitivity.shortfallsIfInbound.";
  }
  return {
    atRisk: !canPaySurvival || marginal,
    canPaySurvival,
    survivalMargin: margins,
    storageTaxSensitivity: storageTaxSensitivity(canPaySurvival, margins.energy, config),
    thisTurnSurvivalCost: survivalCost ? { ...survivalCost } : null,
    storageEnergyCost: storageTax.storageEnergyCost,
    energyAfterStorage: storageTax.energyAfterStorage,
    inventoryAfterStorage: cloneInventory(afterStorage),
    shortfalls: Object.keys(shortfalls).length ? shortfalls : null,
    message
  };
}

function snapshotProjectedHoldings(state) {
  return {
    inventory: cloneInventory(state.inventory),
    productionCapacity: cloneCapacities(state.productionCapacity),
    storageCapacity: cloneCapacities(state.storageCapacity),
    ...deriveCradleEconomics(
      state.productionCapacity,
      state.storageCapacity,
      state.inventory
    )
  };
}

/**
 * Project inventory/capacities/waste after the chosen action.
 * When options.includePendingInbound is set, already-submitted inbound is added
 * before the outbound action and before storage tax. Otherwise the blind spot is
 * explicit: projectedInventoryIncludesPendingInbound false.
 */
function projectActionOutcome(agent, action, config = {}, survivalCost = null, options = {}) {
  const includePendingInbound = options.includePendingInbound === true;
  const pendingInbound = includePendingInbound
    ? roundInventory(options.pendingInbound || { energy: 0, water: 0, compute: 0 })
    : null;
  const state = {
    inventory: cloneInventory(agent.inventory),
    productionCapacity: cloneCapacities(agent.productionCapacity),
    storageCapacity: cloneCapacities(agent.storageCapacity)
  };
  if (pendingInbound) {
    state.inventory = add(state.inventory, pendingInbound);
  }

  const equalInvestCost = summarizeEqualInvestCost(action);
  const pendingFields = {
    projectedInventoryIncludesPendingInbound: includePendingInbound,
    ...(pendingInbound ? { pendingInbound } : {})
  };

  try {
    applyOutboundActionToState(state, action, config);
  } catch (err) {
    return {
      ok: false,
      ...pendingFields,
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
      ...(equalInvestCost ? { equalInvestCost } : {}),
      note: includePendingInbound
        ? "Could not project this action against holdings that include already-submitted inbound. " +
          "If ok is false for insufficient resources, fix amounts to fit that inventory — " +
          "this is not a survival-floor gate."
        : "Could not project this action against current holdings (outbound-only). " +
          "projectedInventoryIncludesPendingInbound is false. " +
          "If ok is false for insufficient resources, fix amounts to fit inventory — " +
          "this is not a survival-floor gate. FIFO inbound before your slot may still " +
          "cover a borderline transfer at resolve."
    };
  }

  const afterAction = snapshotProjectedHoldings(state);
  const storageTax = projectStorageEnergy(state.inventory, config);
  const afterStorageInv = applyStorageCost(state.inventory, state.storageCapacity, config);
  const risk =
    survivalCost != null
      ? assessSurvivalRisk(state.inventory, state.storageCapacity, survivalCost, config)
      : null;
  const survives = risk ? risk.canPaySurvival : null;
  const afterSurvivalInv =
    survives === true ? deduct(afterStorageInv, survivalCost) : afterStorageInv;

  return {
    ok: true,
    ...pendingFields,
    ...(equalInvestCost ? { equalInvestCost } : {}),
    afterAction,
    afterStorageAndSurvival: {
      inventory: cloneInventory(afterSurvivalInv),
      productionCapacity: cloneCapacities(state.productionCapacity),
      storageCapacity: cloneCapacities(state.storageCapacity),
      survives,
      atRisk: risk ? risk.atRisk : null,
      survivalMargin: risk ? risk.survivalMargin : null,
      shortfalls: risk ? risk.shortfalls : null,
      storageTaxSensitivity: risk ? risk.storageTaxSensitivity : null,
      thisTurnSurvivalCost: survivalCost ? { ...survivalCost } : null,
      storageEnergyCost: storageTax.storageEnergyCost,
      energyAfterStorage: storageTax.energyAfterStorage,
      ...deriveCradleEconomics(
        state.productionCapacity,
        state.storageCapacity,
        afterSurvivalInv
      )
    },
    note: includePendingInbound
      ? "Includes already-submitted inbound transfers to you this turn before storage tax and survival (pendingInbound). Peers who have not submitted are not included. survives is paired with survivalMargin and atRisk. storageTaxSensitivity.shortfallsIfInbound is the additional inbound of that resource alone that still leaves survives true (the next 0.0001 flips it). Equal invest amount N spends N of each E/W/C (see equalInvestCost)."
      : "Outbound-only projection of your submit (transfer out, invest capacity growth, reduceStorage, hide/find). Equal invest amount N spends N of each E/W/C (see equalInvestCost). Inbound peer transfers are not modeled (projectedInventoryIncludesPendingInbound is false). survives is paired with survivalMargin and atRisk. Fields: afterAction and afterStorageAndSurvival inventory, capacities, wasteIfNotExportedByNextProduction."
  };
}

function normalizeAssumeInbound(raw) {
  if (raw == null) {
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw gameError(
      "INVALID_ASSUME_INBOUND",
      "assumeInbound must be an object with optional energy, water, compute",
      400
    );
  }
  const inbound = {
    energy: Number(raw.energy) || 0,
    water: Number(raw.water) || 0,
    compute: Number(raw.compute) || 0
  };
  for (const key of RESOURCE_KEYS) {
    if (!Number.isFinite(inbound[key]) || inbound[key] < 0) {
      throw gameError(
        "INVALID_ASSUME_INBOUND",
        `assumeInbound.${key} must be a non-negative number`,
        400,
        { field: key, value: raw[key] }
      );
    }
  }
  if (inbound.energy + inbound.water + inbound.compute <= 0) {
    return null;
  }
  return inbound;
}

function survivalSnapshotFromRisk(risk, note) {
  return {
    survives: risk.canPaySurvival,
    atRisk: risk.atRisk,
    survivalMargin: risk.survivalMargin,
    shortfalls: risk.shortfalls,
    storageTaxSensitivity: risk.storageTaxSensitivity,
    storageEnergyCost: risk.storageEnergyCost,
    energyAfterStorage: risk.energyAfterStorage,
    inventoryAfterStorage: risk.inventoryAfterStorage,
    thisTurnSurvivalCost: risk.thisTurnSurvivalCost,
    message: risk.message,
    ...(note ? { note } : {})
  };
}

/** sqlite datetime('now') is UTC without a zone; ISO strings pass through. */
function parseGameTimestampMs(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  let normalized = raw;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)) {
    normalized = raw.replace(" ", "T");
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized)) normalized += "Z";
  }
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function buildProjectionStateRevision({ phase, turnNumber, latestSubmittedAt, inventory }) {
  const inv = inventory
    ? roundInventory(inventory)
    : { energy: "", water: "", compute: "" };
  return [
    phase || "",
    turnNumber ?? "",
    latestSubmittedAt || "",
    inv.energy,
    inv.water,
    inv.compute
  ].join("|");
}

function sumPendingInboundToAgent(actions, recipientAgentId) {
  const total = { energy: 0, water: 0, compute: 0 };
  for (const row of actions || []) {
    if (!row || row.agent_id === recipientAgentId) continue;
    if (row.status && row.status !== "pending") continue;
    const payload = repo.parseJson(row.payload_json, {});
    for (const leg of transferLegsFromPayload(payload)) {
      if (leg.toAgentId !== recipientAgentId) continue;
      total.energy += Number(leg.energy) || 0;
      total.water += Number(leg.water) || 0;
      total.compute += Number(leg.compute) || 0;
    }
  }
  return roundInventory(total);
}

function latestActionSubmittedAtFrom(actions) {
  let latest = null;
  let latestMs = -Infinity;
  for (const row of actions || []) {
    const ms = parseGameTimestampMs(row?.submitted_at);
    if (ms != null && ms >= latestMs) {
      latestMs = ms;
      latest = row.submitted_at;
    }
  }
  return latest;
}

async function loadTurnProjectionContext(game, agent) {
  const turnNumber = game?.current_turn || 0;
  const actions = turnNumber > 0 ? await repo.listTurnActions(game.id, turnNumber) : [];
  const latestActionSubmittedAt = latestActionSubmittedAtFrom(actions);
  const pendingInbound = sumPendingInboundToAgent(actions, agent?.id);
  const stateRevision = buildProjectionStateRevision({
    phase: game?.phase,
    turnNumber,
    latestSubmittedAt: latestActionSubmittedAt,
    inventory: agent?.inventory
  });
  return { pendingInbound, latestActionSubmittedAt, stateRevision };
}

function projectionCursorFrom(action, options = {}) {
  const src = action && typeof action === "object" ? action : {};
  return {
    stateRevision: options.stateRevision !== undefined ? options.stateRevision : src.stateRevision,
    stateAsOf: options.stateAsOf !== undefined ? options.stateAsOf : src.stateAsOf,
    observedPhase: options.observedPhase !== undefined ? options.observedPhase : src.observedPhase
  };
}

function assertFreshProjectionCursor(cursor, current) {
  const { stateRevision, stateAsOf, observedPhase } = cursor || {};
  const details = {
    stateRevision: current.stateRevision,
    phase: current.phase ?? null,
    turnNumber: current.turnNumber,
    latestActionSubmittedAt: current.latestActionSubmittedAt || null
  };
  const stale = (reason, message) =>
    gameError("STALE_PROJECTION_STATE", message, 409, { ...details, reason });

  if (
    observedPhase != null &&
    observedPhase !== "" &&
    String(observedPhase) !== String(current.phase || "")
  ) {
    throw stale(
      "phase",
      "Projection source state is older than the latest phase. Re-fetch state and project again."
    );
  }
  if (stateRevision != null && stateRevision !== "" && stateRevision !== current.stateRevision) {
    throw stale(
      "stateRevision",
      "Projection source state is older than the latest submitted action or phase. Re-fetch state and project again."
    );
  }
  if (stateAsOf != null && stateAsOf !== "") {
    const asOfMs = parseGameTimestampMs(stateAsOf);
    if (asOfMs == null) {
      throw gameError(
        "INVALID_STATE_AS_OF",
        "stateAsOf must be an ISO-8601 or UTC timestamp",
        400
      );
    }
    const latestMs = parseGameTimestampMs(current.latestActionSubmittedAt);
    if (latestMs != null && latestMs > asOfMs) {
      throw stale(
        "submitted_action",
        "Projection source state is older than the latest submitted action. Re-fetch state and project again."
      );
    }
  }
}

function inboundHasResources(inbound) {
  if (!inbound) return false;
  return (inbound.energy || 0) + (inbound.water || 0) + (inbound.compute || 0) > 0;
}

/**
 * Dry-run calculator: project survival + outbound action without submitting.
 * Optional assumeInbound models hypothetical peer sends before the outbound action.
 * Allowed in any running phase (negotiation or execution) so agents can plan.
 */
async function projectAgentActionDryRun(gameId, agentId, action = {}, options = {}) {
  const game = await repo.getGameById(gameId);
  if (!game) {
    throw gameError("GAME_NOT_FOUND", "Game not found", 404);
  }
  if (game.status !== "running") {
    throw gameError("GAME_NOT_RUNNING", "Game is not in progress", 409);
  }

  const agent = await requireLivingAgent(agentId, gameId);
  const assumeInbound = normalizeAssumeInbound(
    options.assumeInbound !== undefined ? options.assumeInbound : action?.assumeInbound
  );
  const cursor = projectionCursorFrom(action, options);
  const turnContext = await loadTurnProjectionContext(game, agent);
  assertFreshProjectionCursor(cursor, {
    stateRevision: turnContext.stateRevision,
    phase: game.phase,
    turnNumber: game.current_turn,
    latestActionSubmittedAt: turnContext.latestActionSubmittedAt
  });

  const {
    assumeInbound: _assumeInbound,
    gameId: _gameId,
    stateRevision: _stateRevision,
    stateAsOf: _stateAsOf,
    observedPhase: _observedPhase,
    ...actionFields
  } = action && typeof action === "object" ? action : {};
  const actionBody =
    actionFields && Object.keys(actionFields).length > 0
      ? actionFields
      : { type: "none" };
  if (actionBody.type == null) {
    actionBody.type = "none";
  }

  const maxTransferRecipients = resolveMaxTransferRecipients(game.config);
  const normalized = normalizeAction(actionBody, { maxTransferRecipients });
  validateActionPayload(normalized);

  const livingAgents = await repo.listAgents(gameId, { status: "alive" });
  const survivalContext = buildSurvivalContext({
    turnNumber: game.current_turn,
    livingAgents,
    game
  });
  const thisTurnSurvivalCost = computeSurvivalCost(game.config, survivalContext);

  const stockpile = assumeInbound
    ? add(cloneInventory(agent.inventory), assumeInbound)
    : cloneInventory(agent.inventory);
  const inventoryWithInbound = add(stockpile, turnContext.pendingInbound);

  const baselineRisk = assessSurvivalRisk(
    inventoryWithInbound,
    agent.storageCapacity,
    thisTurnSurvivalCost,
    game.config
  );

  const projectedAgent = {
    inventory: stockpile,
    productionCapacity: cloneCapacities(agent.productionCapacity),
    storageCapacity: cloneCapacities(agent.storageCapacity)
  };
  const projection = projectActionOutcome(
    projectedAgent,
    normalized,
    game.config,
    thisTurnSurvivalCost,
    {
      includePendingInbound: true,
      pendingInbound: turnContext.pendingInbound
    }
  );

  let baselineNote;
  if (inboundHasResources(turnContext.pendingInbound) && assumeInbound) {
    baselineNote =
      "Holdings plus already-submitted inbound plus hypothetical assumeInbound, no outbound action.";
  } else if (inboundHasResources(turnContext.pendingInbound)) {
    baselineNote = "Holdings plus already-submitted inbound, no outbound action.";
  } else if (assumeInbound) {
    baselineNote =
      "After hypothetical assumeInbound only (no outbound action). No already-submitted inbound this turn.";
  } else {
    baselineNote =
      "Current holdings, no outbound action. No already-submitted inbound this turn.";
  }

  return {
    dryRun: true,
    gameId,
    agentId,
    turnNumber: game.current_turn,
    phase: game.phase,
    stateRevision: turnContext.stateRevision,
    sourceState: {
      asOf: new Date().toISOString(),
      phase: game.phase,
      turnNumber: game.current_turn,
      latestActionSubmittedAt: turnContext.latestActionSubmittedAt || null,
      stateRevision: turnContext.stateRevision
    },
    projectedInventoryIncludesPendingInbound: true,
    pendingInbound: turnContext.pendingInbound,
    action: normalized,
    ...(assumeInbound ? { assumeInbound } : {}),
    baseline: survivalSnapshotFromRisk(baselineRisk, baselineNote),
    projection,
    note:
      "Does not submit. Already-submitted inbound transfers to you are included before storage tax (projectedInventoryIncludesPendingInbound). Peers who have not submitted are not — read storageTaxSensitivity.shortfallsIfInbound and survivalMargin. Pass stateRevision from state or tick-context (or stateAsOf / observedPhase) to reject a stale cursor with 409 STALE_PROJECTION_STATE."
  };
}

function buildActionHints(inventory, survivalCost, config = {}, fog = {}) {
  const maxInvestAmount = floorResource(
    Math.min(
      Number(inventory?.energy) || 0,
      Number(inventory?.water) || 0,
      Number(inventory?.compute) || 0
    )
  );
  const maxInvestAmountAfterSurvival = maxEqualInvestPreservingSurvival(
    inventory,
    survivalCost,
    config
  );
  const maxIntelligenceCompute =
    maxIntelligenceComputeAfterSurvival(inventory, survivalCost, config);
  const maxTransferRecipients = resolveMaxTransferRecipients(config);
  const intelligenceMemoryTurns =
    config.intelligenceMemoryTurns ?? DEFAULT_GAME_CONFIG.intelligenceMemoryTurns;
  const hiddenRivalCount = fog.hiddenRivalCount ?? 0;
  const livingRivalCount = fog.livingRivalCount ?? 0;
  const storageReadouts = buildStorageReadouts(
    inventory,
    fog.productionCapacity,
    fog.storageCapacity
  );

  const noSpend = projectStorageEnergy(inventory, config);
  const afterSafeInvest = projectStorageEnergy(
    {
      energy: inventory.energy - maxInvestAmountAfterSurvival,
      water: inventory.water - maxInvestAmountAfterSurvival,
      compute: inventory.compute - maxInvestAmountAfterSurvival
    },
    config
  );

  const fogNote =
    hiddenRivalCount > 0 && maxIntelligenceCompute >= 1
      ? ` hiddenRivalCount=${hiddenRivalCount}: attach find. intelligenceMemoryTurns=${intelligenceMemoryTurns}.`
      : hiddenRivalCount > 0
        ? ` hiddenRivalCount=${hiddenRivalCount} but maxIntelligenceComputeAfterSurvival=0 — skip hide/find.`
        : "";

  const capacityNote = storageReadouts
    ? " storageHeadroom / inventoryAtStorageCap / wasteIfNotExportedByNextProduction present."
    : "";

  const nextTurnSurvivalCost = fog.nextTurnSurvivalCost
    ? { ...fog.nextTurnSurvivalCost }
    : null;
  const survivalCostPerTurnIncrement = fog.survivalCostPerTurnIncrement
    ? { ...fog.survivalCostPerTurnIncrement }
    : null;
  const risingNote = nextTurnSurvivalCost
    ? " nextTurnSurvivalCost / survivalCostPerTurnIncrement climb at current living count; maxInvestAmountAfterSurvival is this-turn only."
    : "";

  const runway = projectRunway(
    inventory,
    fog.productionCapacity,
    fog.storageCapacity,
    survivalCost,
    survivalCostPerTurnIncrement,
    config
  );
  const runwayNote =
    runway.runwayTurns === 0
      ? " runway.diesThisTurnIfNone."
      : runway.runwayTurns == null
        ? ` runway.runwayTurns null within ${runway.horizonTurns} turns.`
        : ` runway.runwayTurns=${runway.runwayTurns} limitingResource=${runway.limitingResource}.`;

  return {
    allowedActionTypes: [...EXECUTION_ACTION_TYPES],
    maxInvestAmount,
    maxInvestAmountAfterSurvival,
    maxIntelligenceComputeAfterSurvival: maxIntelligenceCompute,
    maxTransferRecipients,
    intelligenceMemoryTurns,
    hiddenRivalCount,
    livingRivalCount,
    equalInvestUnitCost: {
      energy: 1,
      water: 1,
      compute: 1,
      totalResources: 3,
      note:
        "Equal invest amount N (integer or fraction to 4 decimal places) spends N energy + N water + N compute (3N total resources) per side. Dual production+storage spends both sides."
    },
    storageEnergyCostRate: noSpend.storageEnergyCostRate,
    storageEnergyCostIfNoSpend: noSpend.storageEnergyCost,
    energyAfterStorageIfNoSpend: noSpend.energyAfterStorage,
    storageEnergyCostIfMaxSafeInvest: afterSafeInvest.storageEnergyCost,
    energyAfterStorageIfMaxSafeInvest: afterSafeInvest.energyAfterStorage,
    ...(nextTurnSurvivalCost ? { nextTurnSurvivalCost } : {}),
    ...(survivalCostPerTurnIncrement ? { survivalCostPerTurnIncrement } : {}),
    runway,
    ...(storageReadouts || {}),
    note:
      "Equal invest is triple-cost: amount N (4dp) = N energy + N water + N compute per side. Tax: storageEnergyCostRate × remaining water+compute after spend, then thisTurnSurvivalCost. Read storageEnergyCostIfNoSpend. Cap hide+find at maxIntelligenceComputeAfterSurvival. GET .../action is not a route. Prefer POST .../project over this note." +
      risingNote +
      runwayNote +
      capacityNote +
      fogNote
  };
}

function phaseSecondsRemaining(gameLike, nowMs = Date.now()) {
  if (!gameLike) return null;
  const phase = gameLike.phase;
  const deadline =
    phase === "negotiation"
      ? gameLike.negotiationEndsAt || gameLike.negotiation_ends_at
      : phase === "execution"
        ? gameLike.executionEndsAt || gameLike.execution_ends_at
        : gameLike.endsAt || gameLike.ends_at || null;
  if (!deadline) return null;
  const ms = new Date(deadline).getTime() - nowMs;
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : null;
}

function slimActionHints(hints) {
  if (!hints || typeof hints !== "object") return hints || null;
  const { note, ...rest } = hints;
  return rest;
}

/**
 * Compact state for isolated cron / /hooks/agent ticks.
 * Omits lore, full inbound history, rival inventories, actionHints.note, and other
 * strategy-sized fields that clip 150s model calls at model-call-started.
 */
function toTickState(state, { viewerAgentId = null } = {}) {
  const game = state?.game || {};
  const youFull = state?.you || null;
  const execution = state?.execution;
  const submittedThisExecution = Boolean(
    youFull?.id && Array.isArray(execution?.submittedAgentIds)
      ? execution.submittedAgentIds.includes(youFull.id)
      : false
  );

  const you = youFull
    ? {
        id: youFull.id,
        displayName: youFull.displayName,
        status: youFull.status,
        inventory: youFull.inventory ?? null,
        productionCapacity: youFull.productionCapacity ?? null,
        storageCapacity: youFull.storageCapacity ?? null,
        specialty: youFull.specialty ?? null,
        surplusByResource: youFull.surplusByResource ?? null,
        wasteIfNotExportedByNextProduction: youFull.wasteIfNotExportedByNextProduction ?? null,
        thisTurnSurvivalCost: youFull.thisTurnSurvivalCost ?? null,
        nextTurnSurvivalCost: youFull.nextTurnSurvivalCost ?? null,
        actionHints: slimActionHints(youFull.actionHints),
        transfersReceivedLastTurn: youFull.transfersReceivedLastTurn ?? null,
        lastActionOutcome: youFull.lastActionOutcome ?? null,
        submittedThisExecution,
        ...(youFull.deathReason ? { deathReason: youFull.deathReason } : {}),
        ...(youFull.winReport ? { winReport: youFull.winReport } : {})
      }
    : null;

  const livingPeers = (state?.agents || [])
    .filter((agent) => agent.status === "alive" && agent.id !== (youFull?.id || viewerAgentId))
    .map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      status: agent.status
    }));

  return {
    diet: "tick",
    stateRevision: state?.stateRevision ?? null,
    game: {
      id: game.id,
      status: game.status,
      currentTurn: game.currentTurn,
      phase: game.phase,
      negotiationEndsAt: game.negotiationEndsAt ?? null,
      executionEndsAt: game.executionEndsAt ?? null,
      endsAt: game.endsAt ?? null,
      contestMode: game.contestMode ?? null,
      finishSurvivorCount: game.finishSurvivorCount ?? null
    },
    secondsRemaining: phaseSecondsRemaining(game),
    livingAgentCount: state?.livingAgentCount ?? livingPeers.length + (you?.status === "alive" ? 1 : 0),
    you,
    livingPeers
  };
}

async function getPublicState(gameId, { viewerAgentId = null, diet = "full" } = {}) {
  const tickDiet = diet === "tick";
  const game = await repo.getGameById(gameId);
  if (!game) {
    throw gameError("GAME_NOT_FOUND", "Game not found", 404);
  }

  const agents = await repo.listAgents(gameId);
  const livingAgents = agents.filter((a) => a.status === "alive");
  const turnInvestments =
    !tickDiet && game.status === "running" && game.current_turn > 0
      ? await getTurnInvestmentSummary(gameId, game.current_turn)
      : null;
  const execution =
    game.status === "running" && game.phase === "execution"
      ? await repo.getExecutionSubmissionStatus(gameId, game.current_turn)
      : null;

  const memoryTurns =
    game.config?.intelligenceMemoryTurns ?? DEFAULT_GAME_CONFIG.intelligenceMemoryTurns;
  const intelligence =
    game.status === "running"
      ? await loadIntelligenceMemory(gameId, game.current_turn, memoryTurns)
      : [];

  const projectedSurvivalContext = buildSurvivalContext({
    turnNumber: game.current_turn,
    livingAgents,
    game
  });
  const survivalOutlook =
    game.status === "running" && livingAgents.length > 0
      ? survivalCostOutlook(game.config, projectedSurvivalContext)
      : null;
  const thisTurnSurvivalCost = survivalOutlook?.thisTurn ?? null;
  const nextTurnSurvivalCost = survivalOutlook?.nextTurn ?? null;
  const survivalCostPerTurnIncrement = survivalOutlook?.effectiveIncrementPerTurn ?? null;
  const projectedSurvival =
    !tickDiet && thisTurnSurvivalCost != null
      ? Object.fromEntries(livingAgents.map((agent) => [agent.id, { ...thisTurnSurvivalCost }]))
      : null;

  // First pass without actionHints so we can count fog, then attach hints on the viewer row.
  const agentViews = agents.map((agent) =>
    publicAgentView(agent, viewerAgentId, intelligence, {
      thisTurnSurvivalCost,
      nextTurnSurvivalCost,
      includeActionHints: false,
      config: game.config
    })
  );
  const you =
    viewerAgentId != null ? agentViews.find((a) => a.id === viewerAgentId) || null : null;

  if (you && you.status === "alive" && you.inventory) {
    const livingRivals = agentViews.filter(
      (a) => a.status === "alive" && a.id !== viewerAgentId
    );
    const hiddenRivalCount = livingRivals.filter((a) => a.intelligenceHidden).length;
    you.actionHints = buildActionHints(you.inventory, thisTurnSurvivalCost, game.config, {
      hiddenRivalCount,
      livingRivalCount: livingRivals.length,
      productionCapacity: you.productionCapacity,
      storageCapacity: you.storageCapacity,
      nextTurnSurvivalCost,
      survivalCostPerTurnIncrement
    });
  }

  if (you) {
    const resolvedTurn = lastResolvedTurnNumber(game.current_turn);
    const displayNameByAgentId = new Map(
      agents.map((agent) => [agent.id, agent.displayName || null])
    );
    const lastTurnTrades =
      resolvedTurn != null ? await repo.listPublicTrades(gameId, resolvedTurn) : [];
    enrichTradesWithDisplayNames(lastTurnTrades, displayNameByAgentId);
    you.transfersReceivedLastTurn = transfersReceivedLastTurn(
      resolvedTurn,
      lastTurnTrades,
      viewerAgentId
    );

    if (resolvedTurn != null) {
      const priorAction = await repo.getAction(gameId, resolvedTurn, viewerAgentId);
      you.lastActionOutcome = lastActionOutcomeFromRow(priorAction, resolvedTurn);
    } else {
      you.lastActionOutcome = null;
    }

    if (!tickDiet) {
      const historyTrades =
        resolvedTurn != null
          ? await repo.listPublicTradesThroughTurn(gameId, resolvedTurn)
          : [];
      enrichTradesWithDisplayNames(historyTrades, displayNameByAgentId);
      you.transfersReceived = transfersReceivedHistory(
        resolvedTurn,
        historyTrades,
        viewerAgentId
      );
    }

    if (game.status === "finished") {
      const viewerAgent = agents.find((a) => a.id === viewerAgentId);
      const winReport = buildWinReport({ game, agent: viewerAgent, agents });
      if (winReport) {
        you.winReport = winReport;
      }
    }

    if (!tickDiet) {
      const recollection = await getRecollectionForAgent(gameId, viewerAgentId);
      if (recollection) {
        you.recollection = recollection;
      }
    }
  }

  const latestActionSubmittedAt =
    game.current_turn > 0 ? await repo.getTurnActionWatermark(gameId, game.current_turn) : null;
  const stateRevision = buildProjectionStateRevision({
    phase: game.phase,
    turnNumber: game.current_turn,
    latestSubmittedAt: latestActionSubmittedAt,
    inventory: you?.status === "alive" ? you.inventory : null
  });

  return {
    stateRevision,
    game: {
      id: game.id,
      status: game.status,
      currentTurn: game.current_turn,
      phase: game.phase,
      negotiationEndsAt: game.negotiation_ends_at,
      executionEndsAt: game.execution_ends_at,
      endsAt: game.ends_at,
      contestMode: game.config.contestMode ?? null,
      joiningWindow: joiningWindowDetails(game),
      startedAt: game.started_at,
      finishedAt: game.finished_at,
      winnerIds: game.winnerIds || [],
      maxProductionCapacity: game.config.maxProductionCapacity,
      maxStorageCapacity: game.config.maxStorageCapacity,
      finishSurvivorCount: game.config.finishSurvivorCount ?? 2,
      aggregateWaterConsumed: game.aggregateWaterConsumed ?? 0
    },
    livingAgentCount: livingAgents.length,
    agents: agentViews,
    you,
    turnInvestments,
    execution,
    projectedSurvival,
    openingInventoryReport: tickDiet
      ? null
      : openingInventoryReportForViewer(game, viewerAgentId),
    narrative: tickDiet
      ? null
      : buildStateNarrative({
          livingAgentCount: livingAgents.length,
          turnNumber: game.current_turn,
          playerReference: game.config.survivalCostPlayerReference
        })
  };
}

async function getTickState(gameId, { viewerAgentId = null } = {}) {
  const state = await getPublicState(gameId, { viewerAgentId, diet: "tick" });
  return toTickState(state, { viewerAgentId });
}

async function getTurnInvestmentSummary(gameId, turnNumber) {
  const actions = await repo.listTurnActions(gameId, turnNumber);
  return actions
    .filter(
      (a) =>
        a.action_type === "invest" ||
        a.action_type === "transfer_and_invest" ||
        isInvestActionType(a.action_type) ||
        isCombinedActionType(a.action_type)
    )
    .map((a) => {
      const payload = repo.parseJson(a.payload_json, {});
      return {
        agentId: a.agent_id,
        production: payload.production || null,
        storage: payload.storage || null,
        ...(payload.type === "transfer_and_invest" || isCombinedActionType(payload.type)
          ? { combinedWithTransfer: true }
          : {})
      };
    });
}

function publicAgentView(agent, viewerAgentId, intelligence, options = {}) {
  const {
    thisTurnSurvivalCost = null,
    nextTurnSurvivalCost = null,
    survivalCostPerTurnIncrement = null,
    includeActionHints = false,
    config = null
  } = options;
  const base = {
    id: agent.id,
    roditId: agent.roditId,
    displayName: agent.displayName,
    agentType: agent.agentType ?? null,
    llmModel: agent.llmModel ?? null,
    status: agent.status,
    diedAtTurn: agent.diedAtTurn
  };

  if (agent.status !== "alive") {
    base.inventory = null;
    if (agent.deathReason) {
      base.deathReason = agent.deathReason;
    }
    return base;
  }

  const intelligenceVisible = canViewerSeeCapacities(viewerAgentId, agent.id, intelligence);
  if (intelligenceVisible) {
    base.inventory = agent.inventory;
    base.productionCapacity = agent.productionCapacity;
    base.storageCapacity = agent.storageCapacity;
    Object.assign(
      base,
      deriveCradleEconomics(agent.productionCapacity, agent.storageCapacity, agent.inventory)
    );
    if (thisTurnSurvivalCost) {
      base.thisTurnSurvivalCost = { ...thisTurnSurvivalCost };
    }
    if (nextTurnSurvivalCost) {
      base.nextTurnSurvivalCost = { ...nextTurnSurvivalCost };
    }
    if (includeActionHints && agent.inventory) {
      base.actionHints = buildActionHints(
        agent.inventory,
        thisTurnSurvivalCost,
        config || DEFAULT_GAME_CONFIG,
        {
          productionCapacity: agent.productionCapacity,
          storageCapacity: agent.storageCapacity,
          nextTurnSurvivalCost,
          survivalCostPerTurnIncrement
        }
      );
    }
  } else {
    base.inventory = null;
    base.productionCapacity = null;
    base.storageCapacity = null;
    base.intelligenceHidden = true;
  }

  return base;
}

function actionTransferPart(action) {
  const legs = transferLegsFromPayload(action);
  return legs[0] || null;
}

/**
 * Reject invalid transfer recipients. Do not silently drop the transfer half of a
 * transfer_and_invest_* action — agents treat 201 as success and miss that the transfer never ran.
 */
async function assertValidTransferRecipient(gameId, fromAgentId, toAgentId) {
  if (!toAgentId || typeof toAgentId !== "string") {
    throw gameError("INVALID_TRANSFER", "toAgentId is required for transfer", 400, {
      toAgentId: toAgentId ?? null,
      reason: "missing_to_agent_id"
    });
  }

  const recipient = await repo.getAgentById(toAgentId);
  if (!recipient) {
    throw gameError(
      "INVALID_TRANSFER",
      "toAgentId must be a living game agent ULID from state.players[].id (not displayName or rodit id)",
      400,
      { toAgentId, reason: "not_found" }
    );
  }
  if (recipient.gameId !== gameId) {
    throw gameError(
      "INVALID_TRANSFER",
      "toAgentId is not an agent in this game",
      400,
      { toAgentId, reason: "wrong_game" }
    );
  }
  if (recipient.status !== "alive") {
    throw gameError(
      "INVALID_TRANSFER",
      "Transfer recipient is not alive",
      400,
      { toAgentId, reason: "not_alive", status: recipient.status }
    );
  }
  if (recipient.id === fromAgentId) {
    throw gameError(
      "INVALID_TRANSFER",
      "Cannot transfer to yourself",
      400,
      { toAgentId, reason: "self" }
    );
  }
}

function actionInvestPart(action) {
  if (!action || typeof action !== "object") return null;
  if (action.type === "transfer_and_invest" || isCombinedActionType(action.type)) {
    return action.production || action.storage || action.invest || null;
  }
  if (action.type === "invest" || isInvestActionType(action.type)) {
    return action.production || action.storage || action;
  }
  return null;
}

function isCombinedActionRequest(action) {
  if (!action || typeof action !== "object") return false;
  if (isCombinedActionType(action.type)) return true;
  if (
    action.type === "transfer" &&
    (action.invest || action.production || action.storage)
  ) {
    return true;
  }
  if (isInvestActionType(action.type) && (action.transfer || action.transfers)) {
    return true;
  }
  if (
    action.transfers &&
    (action.invest || action.production || action.storage)
  ) {
    return true;
  }
  return false;
}

function stripTransferLeg(leg) {
  const out = {
    toAgentId: leg.toAgentId,
    energy: leg.energy || 0,
    water: leg.water || 0,
    compute: leg.compute || 0
  };
  if (leg.rationale) out.rationale = leg.rationale;
  if (leg.privateDealSnippets?.length) out.privateDealSnippets = leg.privateDealSnippets;
  return out;
}

function extractSingleTransferLeg(source) {
  if (!source || typeof source !== "object") {
    throw gameError("INVALID_TRANSFER", "transfer details required", 400);
  }
  const transfer = {
    toAgentId: source.toAgentId,
    energy: source.energy || 0,
    water: source.water || 0,
    compute: source.compute || 0
  };
  if (source.rationale != null) transfer.rationale = source.rationale;
  if (source.privateDealSnippets != null) {
    transfer.privateDealSnippets = source.privateDealSnippets;
  }
  if (!transfer.toAgentId || typeof transfer.toAgentId !== "string") {
    throw gameError("INVALID_TRANSFER", "toAgentId is required for transfer", 400, {
      reason: "missing_to_agent_id"
    });
  }
  if (transfer.energy + transfer.water + transfer.compute <= 0) {
    throw gameError("INVALID_TRANSFER", "Transfer must include at least one resource", 400, {
      reason: "empty_transfer",
      toAgentId: transfer.toAgentId
    });
  }
  const normalized = normalizeTransferDisclosure({ type: "transfer", ...transfer });
  return stripTransferLeg(normalized);
}

/**
 * Normalize one or more transfer legs. Accepts:
 * - flat `{ toAgentId, energy, ... }`
 * - `{ transfers: [ { toAgentId, ... }, ... ] }`
 * Caps at maxTransferRecipients; rejects duplicate recipients.
 */
function extractTransferLegs(source, { maxTransferRecipients } = {}) {
  if (!source || typeof source !== "object") {
    throw gameError("INVALID_TRANSFER", "transfer details required", 400);
  }

  const cap = resolveMaxTransferRecipients({
    maxTransferRecipients,
    maxAgents: DEFAULT_GAME_CONFIG.maxAgents
  });

  let rawLegs;
  if (Array.isArray(source.transfers)) {
    rawLegs = source.transfers;
  } else if (source.toAgentId) {
    rawLegs = [source];
  } else {
    throw gameError(
      "INVALID_TRANSFER",
      "Provide toAgentId or transfers[{ toAgentId, energy, water, compute }]",
      400,
      { reason: "missing_recipients" }
    );
  }

  if (!rawLegs.length) {
    throw gameError("INVALID_TRANSFER", "Transfer must include at least one recipient", 400, {
      reason: "missing_recipients"
    });
  }
  if (rawLegs.length > cap) {
    throw gameError(
      "INVALID_TRANSFER",
      `At most ${cap} transfer recipients per action (maxTransferRecipients)`,
      400,
      { reason: "too_many_recipients", maxTransferRecipients: cap, count: rawLegs.length }
    );
  }

  const topRationale = Array.isArray(source.transfers) ? source.rationale : null;
  const topSnippets = Array.isArray(source.transfers) ? source.privateDealSnippets : null;

  const seen = new Set();
  const legs = [];
  for (let index = 0; index < rawLegs.length; index++) {
    const raw = rawLegs[index];
    if (!raw || typeof raw !== "object") {
      throw gameError("INVALID_TRANSFER", `transfers[${index}] must be an object`, 400, {
        reason: "invalid_leg",
        index
      });
    }
    const merged = { ...raw };
    if (merged.rationale == null && topRationale != null) merged.rationale = topRationale;
    if (merged.privateDealSnippets == null && topSnippets != null) {
      merged.privateDealSnippets = topSnippets;
    }
    const leg = extractSingleTransferLeg(merged);
    if (seen.has(leg.toAgentId)) {
      throw gameError(
        "INVALID_TRANSFER",
        "Duplicate toAgentId in transfers — combine amounts into one leg",
        400,
        { reason: "duplicate_recipient", toAgentId: leg.toAgentId }
      );
    }
    seen.add(leg.toAgentId);
    legs.push(leg);
  }
  return legs;
}

function extractInvestFields(source, { kind = null, typeHint = null } = {}) {
  if (!source || typeof source !== "object") {
    throw gameError("INVALID_INVESTMENT", "invest details required", 400);
  }
  const resolvedKind = kind || resolveInvestKind(source, typeHint);
  if (!INVEST_KINDS.includes(resolvedKind)) {
    throw gameError(
      "INVALID_INVESTMENT",
      "Investment capacity must be production or storage",
      400
    );
  }
  const leg = extractInvestLeg(source);
  return { capacity: resolvedKind, ...leg };
}

function resolveTransferSourceForCombined(action) {
  if (Array.isArray(action.transfers)) {
    return action;
  }
  if (action.transfer && typeof action.transfer === "object") {
    if (Array.isArray(action.transfer.transfers) || action.transfer.toAgentId) {
      return action.transfer;
    }
  }
  if (action.toAgentId) {
    return action;
  }
  return action.transfer || action;
}

function normalizeCombinedAction(action, options = {}) {
  let transferSource;
  const type = action.type;

  if (type === "transfer_and_invest" || isCombinedActionType(type)) {
    if (action.transfer || Array.isArray(action.transfers) || action.toAgentId) {
      transferSource = resolveTransferSourceForCombined(action);
    } else if (action.invest && (action.invest.toAgentId || action.invest.transfers)) {
      // Unusual: transfer nested under invest — reject
      transferSource = resolveTransferSourceForCombined(action);
    } else {
      throw gameError(
        "INVALID_ACTION",
        "transfer_and_invest requires transfer recipients plus production and/or storage invest",
        400
      );
    }
  } else if (action.type === "transfer") {
    transferSource = resolveTransferSourceForCombined(action);
  } else {
    transferSource = resolveTransferSourceForCombined(action);
  }

  const legs = extractTransferLegs(transferSource, options);
  const sides = collectInvestSides(
    {
      type,
      production: action.production,
      storage: action.storage,
      invest: action.invest,
      ...(typeof action.amount === "number" && action.target
        ? { target: action.target, amount: action.amount }
        : {})
    },
    type
  );

  const combined = {
    type: "transfer_and_invest",
    transfers: legs
  };
  if (sides.production) combined.production = sides.production;
  if (sides.storage) combined.storage = sides.storage;
  if (legs.length === 1) {
    combined.transfer = { ...legs[0] };
  }
  return attachOptionalExecutionExtras(action, combined);
}

function normalizeInvestDualAction(action) {
  const sides = collectInvestSides(action, action.type);
  const normalized = { type: "invest" };
  if (sides.production) normalized.production = sides.production;
  if (sides.storage) normalized.storage = sides.storage;
  return attachOptionalExecutionExtras(action, normalized);
}

function normalizeTransferAction(action, options = {}) {
  const legs = extractTransferLegs(action, options);
  const normalized = {
    type: "transfer",
    transfers: legs
  };
  if (legs.length === 1) {
    Object.assign(normalized, legs[0]);
  }
  return attachOptionalExecutionExtras(action, normalized);
}

function normalizeAction(action, options = {}) {
  if (!action || typeof action !== "object") {
    throw gameError("INVALID_ACTION", "Action payload required", 400);
  }
  if (isCombinedActionRequest(action)) {
    return normalizeCombinedAction(action, options);
  }
  const type = action.type || "none";
  if (isInvestActionType(type)) {
    return normalizeInvestDualAction({ ...action, type });
  }
  if (type === "transfer") {
    return normalizeTransferAction(action, options);
  }
  return attachOptionalExecutionExtras(action, { ...action, type });
}

function validateActionPayload(action) {
  const allowed = ["none", "transfer", "invest", "transfer_and_invest"];
  if (!allowed.includes(action.type)) {
    throw gameError(
      "INVALID_ACTION_TYPE",
      `Action type must be one of: ${allowed.join(", ")} (aliases invest_production/invest_storage/transfer_and_invest_* normalize on submit)`,
      400
    );
  }
}

async function requireRunningNegotiation(gameId) {
  const game = await repo.getGameById(gameId);
  if (!game) {
    throw gameError("GAME_NOT_FOUND", "Game not found", 404);
  }
  if (game.status !== "running") {
    throw gameError("GAME_NOT_RUNNING", "Game is not in progress", 409);
  }
  if (game.phase !== "negotiation") {
    throw gameError("NOT_NEGOTIATION_PHASE", "Messages are only allowed during negotiation phase", 409);
  }
  return game;
}

async function requireRunningExecution(gameId) {
  const game = await repo.getGameById(gameId);
  if (!game) {
    throw gameError("GAME_NOT_FOUND", "Game not found", 404);
  }
  if (game.status !== "running") {
    throw gameError("GAME_NOT_RUNNING", "Game is not in progress", 409);
  }
  if (game.phase !== "execution") {
    throw gameError("NOT_EXECUTION_PHASE", "Actions are only allowed during execution phase", 409);
  }
  return game;
}

async function requireLivingAgent(agentId, gameId) {
  const agent = await repo.getAgentById(agentId);
  if (!agent || agent.gameId !== gameId) {
    throw gameError("AGENT_NOT_FOUND", "Agent not found in this game", 404);
  }
  if (agent.status !== "alive") {
    throw gameError("AGENT_DEAD", "Agent is no longer alive", 409);
  }
  return agent;
}

function gameError(code, message, statusCode = 400, details = null) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  err.details = details;
  return err;
}

module.exports = {
  createGame,
  assertSimultaneousGameCapacity,
  joinGame,
  updateAgentProfile,
  startGame,
  publishPublicMessage,
  submitAction,
  tryCompleteTurn,
  executeTurn,
  beginExecutionPhase,
  applyDefaultActionsForPendingAgents,
  checkAndForceFinishIfNeeded,
  finishGameByDeadline,
  getPublicState,
  getTickState,
  toTickState,
  phaseSecondsRemaining,
  applyTurnProduction,
  applyProduction,
  applyStorageCost,
  deriveCradleEconomics,
  maxEqualInvestPreservingSurvival,
  projectStorageEnergy,
  buildStorageReadouts,
  buildActionHints,
  projectRunway,
  projectActionOutcome,
  projectAgentActionDryRun,
  normalizeAssumeInbound,
  gameError,
  insufficientResourcesError,
  resourceShortfalls,
  isJoiningWindowOpen,
  joiningWindowDetails,
  computeSurvivalCost,
  normalizeInvestAction,
  validateBalancedInvestment,
  normalizeFindTargets,
  normalizeHideSpend,
  normalizeReduceStorage,
  assessSurvivalRisk,
  buildDeathReason,
  buildWinReport,
  buildGameOverReport,
  inferFinishReason,
  titleForWinRank,
  summarizeEqualInvestCost,
  canViewerSeeCapacities,
  collectIntelligenceFromActions,
  loadIntelligenceMemory,
  maxIntelligenceComputeAfterSurvival,
  buildOpeningInventoryReport,
  selectOpeningInventoryScout,
  openingInventoryReportForViewer,
  inventoryTotal,
  storageTotal,
  inventoryFillRatio,
  buildCradleAssignment
};
