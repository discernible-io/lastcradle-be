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
  DEFAULT_GAME_CONFIG
} = require("./defaults");
const { computeSurvivalCost, buildSurvivalContext } = require("./survival-cost");
const { getGameNarrative, buildSurvivalNarrative } = require("./narrative");
const {
  normalizeTransferDisclosure,
  transferLegsFromPayload
} = require("./trade-disclosure");
const repo = require("./repository");
const { notifyElimination } = require("./webhooks");

const RESOURCE_KEYS = ["energy", "water", "compute"];
const INVESTMENT_TARGETS = ["energy", "water", "compute"];

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

  const productionEnergyRate = config.productionEnergyCostRate ?? 0;
  const energyProductionCost =
    (produced.water + produced.compute) * productionEnergyRate;
  inventory.energy = Math.max(0, inventory.energy - energyProductionCost);

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
  const storageWaterRate = config.storageWaterCostRate ?? 0;
  const waterCost =
    (inventory.energy + inventory.compute) * storageWaterRate;
  const next = {
    energy: inventory.energy,
    water: Math.max(0, inventory.water - waterCost),
    compute: inventory.compute
  };
  return clampInventoryToStorage(next, storageCapacity);
}

function normalizeInvestAction(action) {
  const normalized = { ...action };
  if (typeof normalized.amount === "number") {
    normalized.energy = normalized.amount;
    normalized.water = normalized.amount;
    normalized.compute = normalized.amount;
  }
  return normalized;
}

function validateBalancedInvestment(action) {
  const energy = action.energy || 0;
  const water = action.water || 0;
  const compute = action.compute || 0;
  if (energy <= 0 || water <= 0 || compute <= 0) {
    throw gameError(
      "INVALID_INVESTMENT",
      "Investment must spend a positive equal amount of energy, water, and compute",
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

function applyInvestmentCapacityGrowth(state, payload, config) {
  const amount = payload.energy || 0;
  const target = payload.target;
  const productionGain = amount * (config.investProductionGainPerUnit ?? 0);
  const storageGain = amount * (config.investStorageGainPerUnit ?? 0);
  state.productionCapacity[target] += productionGain;
  state.storageCapacity[target] += storageGain;
  const clamped = clampCapacities(state.productionCapacity, state.storageCapacity, config);
  state.productionCapacity = clamped.productionCapacity;
  state.storageCapacity = clamped.storageCapacity;
}

/**
 * Roll storage + production. Specialized cradles (default): one specialty resource with
 * production > storage (cannot keep full output — trade pressure), secondaries with
 * production < storage (need imports). Legacy mode keeps production = storage.
 */
function buildCradleAssignment(config) {
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
    specialty = RESOURCE_KEYS[randomInt(0, RESOURCE_KEYS.length - 1)];
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
  return config?.contestMode === "practice" || config?.contestMode === "definitive";
}

/**
 * Casual create must fill existing open lobbies first.
 * Full = agentCount >= min(lobby.maxAgents, casual default maxAgents) so legacy
 * 17-seat lobbies stop blocking creates once they reach the current casual cap (10).
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

async function createGame({
  config: configOverrides = {},
  joiningWindowStartsAt = null,
  allowParallelLobbies = false
} = {}) {
  const gameConfig = mergeGameConfig(configOverrides);
  const skipFillFirst =
    allowParallelLobbies || isContestLobbyConfig(gameConfig);

  if (!skipFillFirst) {
    await assertNoJoinableOpenCasualLobbies();
  }

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
  for (const agentId of status.pendingAgentIds) {
    await repo.upsertAction({
      gameId,
      turnNumber: game.current_turn,
      agentId,
      actionType: "none",
      payload: { type: "none" }
    });
  }
}

async function joinGame(gameId, { roditId, displayName }) {
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

  requireJoiningWindowOpen(game);

  const config = game.config;
  if ((await repo.countAgents(gameId)) >= config.maxAgents) {
    throw gameError("GAME_FULL", "Game has reached maximum agent capacity", 409);
  }

  const { storageCapacity, productionCapacity, inventory } = buildCradleAssignment(config);
  return repo.addAgent({
    gameId,
    roditId,
    displayName,
    productionCapacity,
    storageCapacity,
    startingInventory: inventory
  });
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
  for (const agent of agents) {
    const newInventory = applyProduction(agent, config);
    await repo.updateAgentInventory(agent.id, newInventory);
  }
}

async function publishPublicMessage(gameId, agentId, { body }) {
  const game = await requireRunningNegotiation(gameId);
  await requireLivingAgent(agentId, gameId);

  if (!body || typeof body !== "string" || !body.trim()) {
    throw gameError("MESSAGE_BODY_REQUIRED", "Message body is required", 400);
  }

  const message = await repo.addMessage({
    gameId,
    turnNumber: game.current_turn,
    fromAgentId: agentId,
    toAgentId: null,
    body: body.trim(),
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
  const maxTransferRecipients =
    game.config?.maxTransferRecipients ?? DEFAULT_GAME_CONFIG.maxTransferRecipients;

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
    const investPart =
      normalized.type === "transfer_and_invest" ? normalized.invest : normalized;
    if (!INVESTMENT_TARGETS.includes(investPart.target)) {
      throw gameError(
        "INVALID_INVESTMENT_TARGET",
        "Investment target must be energy, water, or compute",
        400
      );
    }
    validateBalancedInvestment(investPart);
  }

  const livingAgents = await repo.listAgents(gameId, { status: "alive" });
  const survivalContext = buildSurvivalContext({
    turnNumber: game.current_turn,
    livingAgents,
    game
  });
  const thisTurnSurvivalCost = computeSurvivalCost(game.config, survivalContext);
  const projection = projectActionOutcome(
    agent,
    normalized,
    game.config,
    thisTurnSurvivalCost
  );

  const record = await repo.upsertAction({
    gameId,
    turnNumber: game.current_turn,
    agentId,
    actionType: normalized.type,
    payload: normalized
  });

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
        executeInvest(state, payload);
        applyInvestmentCapacityGrowth(state, payload, config);
      } else if (payload.type === "transfer_and_invest") {
        executeTransfers(state, agentState, payload);
        executeInvest(state, payload.invest);
        applyInvestmentCapacityGrowth(state, payload.invest, config);
      }
      executeIntelligenceSpend(state, payload);
      await repo.markActionExecuted(actionRow.id, "executed");
    } catch (err) {
      await repo.markActionExecuted(actionRow.id, "failed", err.message);
    }
  }

  for (const state of agentState.values()) {
    state.inventory = applyStorageCost(state.inventory, state.storageCapacity, config);
  }

  const survivalContext = buildSurvivalContext({
    turnNumber,
    livingAgents: livingBefore,
    game
  });

  const deaths = [];
  for (const agent of livingBefore) {
    const agentId = agent.id;
    const state = agentState.get(agentId);
    const survivalCost = computeSurvivalCost(config, survivalContext);
    if (!hasSufficient(state.inventory, survivalCost)) {
      deaths.push({ agentId, agent });
      continue;
    }
    state.inventory = deduct(state.inventory, survivalCost);
  }

  for (const { agentId, agent } of deaths) {
    await repo.killAgent(agentId, turnNumber);
    notifyElimination({ gameId, agent, turnNumber }).catch(() => {});
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
    throw new Error("Insufficient resources for transfer");
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
    throw new Error("Insufficient resources for investment");
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
    throw new Error("Insufficient compute for hide/find actions");
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
 * post-execution storage water cost (rate × remaining energy+compute).
 * Transfers / hide / find are not modeled — leave extra cushion if combining them.
 */
function maxEqualInvestPreservingSurvival(inventory, survivalCost, config = {}) {
  const rate = Number(config.storageWaterCostRate) || 0;
  const se = survivalCost?.energy ?? 0;
  const sw = survivalCost?.water ?? 0;
  const sc = survivalCost?.compute ?? 0;
  const maxAffordable = Math.max(
    0,
    Math.floor(Math.min(inventory.energy, inventory.water, inventory.compute))
  );

  for (let n = maxAffordable; n >= 0; n -= 1) {
    const energy = inventory.energy - n;
    const water = inventory.water - n;
    const compute = inventory.compute - n;
    if (energy < se || compute < sc) continue;
    const waterAfterStorage = Math.max(0, water - (energy + compute) * rate);
    if (waterAfterStorage >= sw) return n;
  }
  return 0;
}

/**
 * Max compute spendable on hide/find while still paying survival after storage water cost.
 * Does not model transfer/invest in the same action — leave cushion if combining.
 */
function maxIntelligenceComputeAfterSurvival(inventory, survivalCost, config = {}) {
  const rate = Number(config.storageWaterCostRate) || 0;
  const se = survivalCost?.energy ?? 0;
  const sw = survivalCost?.water ?? 0;
  const sc = survivalCost?.compute ?? 0;
  const maxAffordable = Math.max(0, Math.floor(inventory?.compute ?? 0));

  for (let n = maxAffordable; n >= 0; n -= 1) {
    const energy = inventory.energy;
    const water = inventory.water;
    const compute = inventory.compute - n;
    if (energy < se || compute < sc) continue;
    const waterAfterStorage = Math.max(0, water - (energy + compute) * rate);
    if (waterAfterStorage >= sw) return n;
  }
  return 0;
}

/**
 * Post-execution storage water tax for a holdings snapshot (rate × energy+compute).
 * Does not model inbound transfers — those can raise the tax further at resolve time.
 */
function projectStorageWater(inventory, config = {}) {
  const rate = Number(config.storageWaterCostRate) || 0;
  const energy = Number(inventory?.energy) || 0;
  const water = Number(inventory?.water) || 0;
  const compute = Number(inventory?.compute) || 0;
  const cost = (energy + compute) * rate;
  return {
    storageWaterCostRate: rate,
    storageWaterCost: cost,
    waterAfterStorage: Math.max(0, water - cost)
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
        throw new Error("Insufficient resources for transfer");
      }
      state.inventory = deduct(state.inventory, transfer);
    }
  }
  if (action.type === "invest") {
    executeInvest(state, action);
    applyInvestmentCapacityGrowth(state, action, config);
  } else if (action.type === "transfer_and_invest") {
    executeInvest(state, action.invest);
    applyInvestmentCapacityGrowth(state, action.invest, config);
  }
  executeIntelligenceSpend(state, action);
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
 * Project inventory/capacities/waste after the chosen action (outbound effects only).
 * Inbound peer transfers are not modeled.
 */
function projectActionOutcome(agent, action, config = {}, survivalCost = null) {
  const state = {
    inventory: cloneInventory(agent.inventory),
    productionCapacity: cloneCapacities(agent.productionCapacity),
    storageCapacity: cloneCapacities(agent.storageCapacity)
  };

  try {
    applyOutboundActionToState(state, action, config);
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      note: "Could not project this action against current holdings."
    };
  }

  const afterAction = snapshotProjectedHoldings(state);
  const storageTax = projectStorageWater(state.inventory, config);
  const afterStorageInv = applyStorageCost(state.inventory, state.storageCapacity, config);
  const survives =
    survivalCost != null ? hasSufficient(afterStorageInv, survivalCost) : null;
  const afterSurvivalInv =
    survives === true ? deduct(afterStorageInv, survivalCost) : afterStorageInv;

  return {
    ok: true,
    afterAction,
    afterStorageAndSurvival: {
      inventory: cloneInventory(afterSurvivalInv),
      productionCapacity: cloneCapacities(state.productionCapacity),
      storageCapacity: cloneCapacities(state.storageCapacity),
      survives,
      thisTurnSurvivalCost: survivalCost ? { ...survivalCost } : null,
      storageWaterCost: storageTax.storageWaterCost,
      waterAfterStorage: storageTax.waterAfterStorage,
      ...deriveCradleEconomics(
        state.productionCapacity,
        state.storageCapacity,
        afterSurvivalInv
      )
    },
    note:
      "Outbound-only projection of your submit (transfer out, invest capacity growth, hide/find). Inbound peer transfers are not modeled. Fields: afterAction and afterStorageAndSurvival inventory, capacities, wasteIfNotExportedByNextProduction."
  };
}

function buildActionHints(inventory, survivalCost, config = {}, fog = {}) {
  const maxInvestAmount = Math.max(
    0,
    Math.floor(Math.min(inventory.energy, inventory.water, inventory.compute))
  );
  const maxInvestAmountAfterSurvival = maxEqualInvestPreservingSurvival(
    inventory,
    survivalCost,
    config
  );
  const maxIntelligenceCompute =
    maxIntelligenceComputeAfterSurvival(inventory, survivalCost, config);
  const maxTransferRecipients =
    config.maxTransferRecipients ?? DEFAULT_GAME_CONFIG.maxTransferRecipients;
  const intelligenceMemoryTurns =
    config.intelligenceMemoryTurns ?? DEFAULT_GAME_CONFIG.intelligenceMemoryTurns;
  const hiddenRivalCount = fog.hiddenRivalCount ?? 0;
  const livingRivalCount = fog.livingRivalCount ?? 0;
  const storageReadouts = buildStorageReadouts(
    inventory,
    fog.productionCapacity,
    fog.storageCapacity
  );

  const noSpend = projectStorageWater(inventory, config);
  const afterSafeInvest = projectStorageWater(
    {
      energy: inventory.energy - maxInvestAmountAfterSurvival,
      water: inventory.water - maxInvestAmountAfterSurvival,
      compute: inventory.compute - maxInvestAmountAfterSurvival
    },
    config
  );

  const fogNote =
    hiddenRivalCount > 0 && maxIntelligenceCompute >= 1
      ? ` ${hiddenRivalCount} living rival(s) have intelligenceHidden — attach find[{ targetAgentId, compute }] (compute 1 beats hide 0); successful find stays visible for intelligenceMemoryTurns (${intelligenceMemoryTurns}) completed turns.`
      : hiddenRivalCount > 0
        ? ` ${hiddenRivalCount} living rival(s) have intelligenceHidden but maxIntelligenceComputeAfterSurvival is 0 — do not spend hide/find this turn.`
        : ` No hidden living rivals (or you are not seated).`;

  const capacityNote = storageReadouts
    ? " Also present: wasteIfNotExportedByNextProduction, storageHeadroom, inventoryAtStorageCap."
    : "";

  return {
    allowedActionTypes: ["transfer", "invest", "transfer_and_invest", "none"],
    maxInvestAmount,
    maxInvestAmountAfterSurvival,
    maxIntelligenceComputeAfterSurvival: maxIntelligenceCompute,
    maxTransferRecipients,
    intelligenceMemoryTurns,
    hiddenRivalCount,
    livingRivalCount,
    storageWaterCostRate: noSpend.storageWaterCostRate,
    storageWaterCostIfNoSpend: noSpend.storageWaterCost,
    waterAfterStorageIfNoSpend: noSpend.waterAfterStorage,
    storageWaterCostIfMaxSafeInvest: afterSafeInvest.storageWaterCost,
    waterAfterStorageIfMaxSafeInvest: afterSafeInvest.waterAfterStorage,
    ...(storageReadouts || {}),
    note:
      "Read storageWaterCostIfNoSpend / waterAfterStorageIfNoSpend (and *IfMaxSafeInvest) before investing — tax is storageWaterCostRate × remaining energy+compute after your spend, then thisTurnSurvivalCost. maxInvestAmountAfterSurvival is equal-invest only (no transfers/hide/find/inbound). Cap hide+find at maxIntelligenceComputeAfterSurvival. Up to maxTransferRecipients peers per transfer. Empty tick does not imply none. POST .../action only — GET .../action is not a route." +
      capacityNote +
      fogNote
  };
}

async function getPublicState(gameId, { viewerAgentId = null } = {}) {
  const game = await repo.getGameById(gameId);
  if (!game) {
    throw gameError("GAME_NOT_FOUND", "Game not found", 404);
  }

  const agents = await repo.listAgents(gameId);
  const livingAgents = agents.filter((a) => a.status === "alive");
  const turnInvestments =
    game.status === "running" && game.current_turn > 0
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
  const thisTurnSurvivalCost =
    game.status === "running" && livingAgents.length > 0
      ? computeSurvivalCost(game.config, projectedSurvivalContext)
      : null;
  const projectedSurvival =
    thisTurnSurvivalCost != null
      ? Object.fromEntries(livingAgents.map((agent) => [agent.id, { ...thisTurnSurvivalCost }]))
      : null;

  // First pass without actionHints so we can count fog, then attach hints on the viewer row.
  const agentViews = agents.map((agent) =>
    publicAgentView(agent, viewerAgentId, intelligence, {
      thisTurnSurvivalCost,
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
      storageCapacity: you.storageCapacity
    });
  }

  return {
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
      finishSurvivorCount: game.config.finishSurvivorCount ?? 2
    },
    livingAgentCount: livingAgents.length,
    agents: agentViews,
    you,
    turnInvestments,
    execution,
    projectedSurvival,
    openingInventoryReport: openingInventoryReportForViewer(game, viewerAgentId),
    narrative: {
      ...getGameNarrative(),
      survival: buildSurvivalNarrative({
        livingAgentCount: livingAgents.length,
        turnNumber: game.current_turn,
        playerReference: game.config.survivalCostPlayerReference
      })
    }
  };
}

async function getTurnInvestmentSummary(gameId, turnNumber) {
  const actions = await repo.listTurnActions(gameId, turnNumber);
  return actions
    .filter((a) => a.action_type === "invest" || a.action_type === "transfer_and_invest")
    .map((a) => {
      const payload = repo.parseJson(a.payload_json, {});
      const invest =
        payload.type === "transfer_and_invest" ? payload.invest || {} : payload;
      return {
        agentId: a.agent_id,
        ...invest,
        ...(payload.type === "transfer_and_invest" ? { combinedWithTransfer: true } : {})
      };
    });
}

function publicAgentView(agent, viewerAgentId, intelligence, options = {}) {
  const {
    thisTurnSurvivalCost = null,
    includeActionHints = false,
    config = null
  } = options;
  const base = {
    id: agent.id,
    roditId: agent.roditId,
    displayName: agent.displayName,
    status: agent.status,
    diedAtTurn: agent.diedAtTurn
  };

  if (agent.status !== "alive") {
    base.inventory = null;
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
    if (includeActionHints && agent.inventory) {
      base.actionHints = buildActionHints(
        agent.inventory,
        thisTurnSurvivalCost,
        config || DEFAULT_GAME_CONFIG,
        {
          productionCapacity: agent.productionCapacity,
          storageCapacity: agent.storageCapacity
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
 * Reject invalid transfer recipients. Do not silently downgrade transfer_and_invest → invest
 * or transfer → none — agents treat 201 as success and miss that the transfer never ran.
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
  if (action.type === "transfer_and_invest") {
    return action.invest || null;
  }
  if (action.type === "invest") {
    return action;
  }
  return null;
}

function isCombinedActionRequest(action) {
  if (!action || typeof action !== "object") return false;
  if (action.type === "transfer_and_invest") return true;
  if (action.type === "transfer" && action.invest) return true;
  if (action.type === "invest" && (action.transfer || action.transfers)) return true;
  if (action.transfers && action.invest) return true;
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

  const cap =
    maxTransferRecipients ??
    DEFAULT_GAME_CONFIG.maxTransferRecipients ??
    5;

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

function extractInvestFields(source) {
  if (!source || typeof source !== "object") {
    throw gameError("INVALID_INVESTMENT", "invest details required", 400);
  }
  return normalizeInvestAction({
    type: "invest",
    target: source.target,
    energy: source.energy,
    water: source.water,
    compute: source.compute,
    ...(typeof source.amount === "number" ? { amount: source.amount } : {})
  });
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
  let investSource;
  if (action.type === "transfer_and_invest") {
    if (action.transfer && action.invest) {
      transferSource = resolveTransferSourceForCombined(action);
      investSource = action.invest;
    } else if (Array.isArray(action.transfers) && action.invest) {
      transferSource = action;
      investSource = action.invest;
    } else if (action.invest) {
      transferSource = resolveTransferSourceForCombined(action);
      investSource = action.invest;
    } else if (action.transfer) {
      transferSource = action.transfer;
      investSource = action;
    } else if (typeof action.amount === "number") {
      // Flat: top-level EWC = transfer, amount+target = invest
      transferSource = action;
      investSource = action;
    } else {
      throw gameError(
        "INVALID_ACTION",
        "transfer_and_invest requires nested { transfer, invest }, transfers[] + invest, or top-level amount for invest",
        400
      );
    }
  } else if (action.type === "transfer") {
    transferSource = resolveTransferSourceForCombined(action);
    investSource = action.invest;
  } else {
    transferSource = resolveTransferSourceForCombined(action);
    investSource = action;
  }

  const legs = extractTransferLegs(transferSource, options);
  const invest = extractInvestFields(investSource);
  const combined = {
    type: "transfer_and_invest",
    transfers: legs,
    invest: {
      target: invest.target,
      energy: invest.energy,
      water: invest.water,
      compute: invest.compute
    }
  };
  // Single-leg mirror for older consumers that read payload.transfer.toAgentId
  if (legs.length === 1) {
    combined.transfer = { ...legs[0] };
  }
  if (action.hide != null) combined.hide = action.hide;
  if (action.find != null) combined.find = action.find;
  return combined;
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
  if (action.hide != null) normalized.hide = action.hide;
  if (action.find != null) normalized.find = action.find;
  return normalized;
}

function normalizeAction(action, options = {}) {
  if (!action || typeof action !== "object") {
    throw gameError("INVALID_ACTION", "Action payload required", 400);
  }
  if (isCombinedActionRequest(action)) {
    return normalizeCombinedAction(action, options);
  }
  const type = action.type || "none";
  if (type === "invest") {
    return normalizeInvestAction({ ...action, type });
  }
  if (type === "transfer") {
    return normalizeTransferAction(action, options);
  }
  return { ...action, type };
}

function validateActionPayload(action) {
  const allowed = ["none", "transfer", "invest", "transfer_and_invest"];
  if (!allowed.includes(action.type)) {
    throw gameError("INVALID_ACTION_TYPE", `Action type must be one of: ${allowed.join(", ")}`, 400);
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
  joinGame,
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
  applyTurnProduction,
  applyProduction,
  applyStorageCost,
  deriveCradleEconomics,
  maxEqualInvestPreservingSurvival,
  projectStorageWater,
  buildStorageReadouts,
  buildActionHints,
  projectActionOutcome,
  gameError,
  isJoiningWindowOpen,
  joiningWindowDetails,
  computeSurvivalCost,
  normalizeInvestAction,
  validateBalancedInvestment,
  normalizeFindTargets,
  normalizeHideSpend,
  canViewerSeeCapacities,
  collectIntelligenceFromActions,
  loadIntelligenceMemory,
  maxIntelligenceComputeAfterSurvival,
  buildOpeningInventoryReport,
  selectOpeningInventoryScout,
  openingInventoryReportForViewer,
  inventoryTotal,
  storageTotal,
  inventoryFillRatio
};
