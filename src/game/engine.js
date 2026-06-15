/**
 * Core game engine: production, execution, capacity investment, storage, survival, intelligence.
 */

const { mergeGameConfig, randomInt, randomFloat, finalizeStartingInventory, maxCapacityFor } = require("./defaults");
const {
  computeSurvivalCost,
  buildSurvivalContext,
  communicationCostComputeForTurn
} = require("./survival-cost");
const repo = require("./repository");

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

function buildTerritoryAssignment(config) {
  const territory = {
    energy: randomInt(config.territoryCapacityMin, config.territoryCapacityMax),
    water: randomInt(config.territoryCapacityMin, config.territoryCapacityMax),
    compute: randomInt(config.territoryCapacityMin, config.territoryCapacityMax)
  };
  let inventory;
  if (config.useRandomStartingInventory) {
    inventory = finalizeStartingInventory(
      {
        energy: randomInt(config.startingInventoryMin, config.startingInventoryMax),
        water: randomInt(config.startingInventoryMin, config.startingInventoryMax),
        compute: randomInt(config.startingInventoryMin, config.startingInventoryMax)
      },
      config
    );
  } else {
    inventory = { ...config.startingInventory };
  }
  return { territory, inventory };
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
      "Territory assignment has not started yet; wait until the joining window opens",
      409,
      details
    );
  }

  if (!isJoiningWindowOpen(game, now)) {
    throw gameError(
      "JOIN_WINDOW_CLOSED",
      "The joining window has closed; territory assignment is no longer available",
      409,
      details
    );
  }
}

async function createGame({ config: configOverrides = {}, joiningWindowStartsAt = null } = {}) {
  const gameConfig = mergeGameConfig(configOverrides);
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
  const winners = await repo.listAgents(gameId, { status: "alive" });
  await repo.updateGame(gameId, {
    status: "finished",
    phase: null,
    finished_at: new Date().toISOString(),
    winner_ids_json: JSON.stringify(winners.map((w) => w.id)),
    negotiation_ends_at: null,
    execution_ends_at: null
  });
  return true;
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

  const { territory, inventory } = buildTerritoryAssignment(config);
  return repo.addAgent({
    gameId,
    roditId,
    displayName,
    energyCapacity: territory.energy,
    waterCapacity: territory.water,
    computeCapacity: territory.compute,
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

  const now = new Date();
  const negotiationEndsAt = new Date(now.getTime() + game.config.negotiationDurationMs);
  const survivalRuntime = { startingAgentCount: agentCount };

  await repo.updateGame(gameId, {
    status: "running",
    current_turn: 1,
    phase: "negotiation",
    started_at: now.toISOString(),
    negotiation_ends_at: negotiationEndsAt.toISOString(),
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

async function submitMessageReport(gameId, agentId, { sent, received }) {
  const game = await requireRunningMessageReport(gameId);
  await requireLivingAgent(agentId, gameId);

  const reportedSent = normalizeMessageCount(sent, "sent");
  const reportedReceived = normalizeMessageCount(received, "received");

  const record = await repo.upsertMessageReport({
    gameId,
    turnNumber: game.current_turn,
    agentId,
    reportedSent,
    reportedReceived
  });

  const completion = await tryCompleteMessageReportPhase(gameId);
  return { report: record, agentId, ...completion };
}

function normalizeMessageCount(value, fieldName) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw gameError(
      "INVALID_MESSAGE_REPORT",
      `${fieldName} must be a non-negative integer`,
      400
    );
  }
  return value;
}

async function tryCompleteMessageReportPhase(gameId) {
  const game = await repo.getGameById(gameId);
  if (!game || game.status !== "running" || game.phase !== "message_report") {
    return {
      messageReportPhaseCompleted: false,
      messageReport: game ? await repo.getMessageReportSubmissionStatus(gameId, game.current_turn) : null
    };
  }

  const messageReport = await repo.getMessageReportSubmissionStatus(gameId, game.current_turn);
  if (!messageReport.allSubmitted) {
    return { messageReportPhaseCompleted: false, messageReport };
  }

  const database = await repo.getDb();
  const claim = await database.run(
    `UPDATE games SET phase = 'message_report_resolving' WHERE id = ? AND phase = 'message_report'`,
    [gameId]
  );
  if (claim.changes === 0) {
    const current = await repo.getGameById(gameId);
    return {
      messageReportPhaseCompleted: current?.phase === "execution",
      messageReport: await repo.getMessageReportSubmissionStatus(gameId, game.current_turn)
    };
  }

  if (!(await repo.allMessageReportsSubmitted(gameId, game.current_turn))) {
    await repo.updateGame(gameId, { phase: "message_report" });
    return {
      messageReportPhaseCompleted: false,
      messageReport: await repo.getMessageReportSubmissionStatus(gameId, game.current_turn)
    };
  }

  const messageReportResults = await repo.finalizeMessageReports(gameId, game.current_turn, {
    penaltyPerTen: game.config.messageReportMismatchEnergyPenaltyPerTen,
    communicationCostCompute: communicationCostComputeForTurn(game.config, game.current_turn),
    outlierExcludeEnabled: game.config.messageReportMismatchOutlierExcludeEnabled !== false,
    outlierThreshold: game.config.messageReportMismatchOutlierThreshold,
    outlierMinFixRatio: game.config.messageReportMismatchOutlierMinFixRatio
  });

  await repo.updateGame(gameId, { phase: "execution" });

  return {
    messageReportPhaseCompleted: true,
    messageReportResults,
    messageReport: null
  };
}

async function submitAction(gameId, agentId, action) {
  const game = await requireRunningExecution(gameId);
  const agent = await requireLivingAgent(agentId, gameId);

  const normalized = normalizeAction(action);
  validateActionPayload(normalized, gameId);
  await validateIntelligenceAction(gameId, agentId, normalized);

  if (normalized.type === "transfer") {
    const recipient = await repo.getAgentById(normalized.toAgentId);
    if (
      !recipient ||
      recipient.gameId !== gameId ||
      recipient.status !== "alive" ||
      recipient.id === agentId
    ) {
      normalized.type = "none";
      delete normalized.toAgentId;
      delete normalized.energy;
      delete normalized.water;
      delete normalized.compute;
    }
  }

  if (normalized.type === "invest") {
    Object.assign(normalized, normalizeInvestAction(normalized));
    if (!INVESTMENT_TARGETS.includes(normalized.target)) {
      throw gameError(
        "INVALID_INVESTMENT_TARGET",
        "Investment target must be energy, water, or compute",
        400
      );
    }
    validateBalancedInvestment(normalized);
  }

  const record = await repo.upsertAction({
    gameId,
    turnNumber: game.current_turn,
    agentId,
    actionType: normalized.type,
    payload: normalized
  });

  const completion = await tryCompleteTurn(gameId);
  return { action: record, agentId, ...completion };
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
    return {
      turnCompleted: false,
      execution: game ? await repo.getExecutionSubmissionStatus(gameId, game.current_turn) : null
    };
  }

  const execution = await repo.getExecutionSubmissionStatus(gameId, game.current_turn);
  if (!execution.allSubmitted) {
    return { turnCompleted: false, execution };
  }

  const updated = await executeTurn(gameId);
  const turnCompleted =
    updated.status === "finished" ||
    updated.phase === "negotiation" ||
    updated.phase === null;

  return {
    turnCompleted,
    execution: turnCompleted
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

function canViewerSeeCapacities(viewerAgentId, targetAgentId, intelligence) {
  if (!viewerAgentId || viewerAgentId === targetAgentId) {
    return true;
  }
  const hideSpend = intelligence.hideSpendByAgent.get(targetAgentId) || 0;
  const findSpend = intelligence.findSpendByPair.get(`${targetAgentId}:${viewerAgentId}`) || 0;
  return findSpend > hideSpend;
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
        executeTransfer(state, agentState, payload);
      } else if (payload.type === "invest") {
        executeInvest(state, payload);
        applyInvestmentCapacityGrowth(state, payload, config);
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
    const energyPenalty = await repo.getAgentEnergySurvivalPenalty(gameId, turnNumber, agentId);
    const survivalCost = computeSurvivalCost(config, {
      ...survivalContext,
      energyPenalty
    });
    if (!hasSufficient(state.inventory, survivalCost)) {
      deaths.push(agentId);
      continue;
    }
    state.inventory = deduct(state.inventory, survivalCost);
  }

  for (const [agentId, state] of agentState.entries()) {
    if (deaths.includes(agentId)) {
      await repo.killAgent(agentId, turnNumber);
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

  const nextTurn = turnNumber + 1;
  const now = new Date();
  const negotiationEndsAt = new Date(now.getTime() + config.negotiationDurationMs);

  await repo.updateGame(gameId, {
    current_turn: nextTurn,
    phase: "negotiation",
    negotiation_ends_at: negotiationEndsAt.toISOString(),
    execution_ends_at: null
  });

  await applyTurnProduction(gameId, nextTurn);
  return repo.getGameById(gameId);
}

function executeTransfer(state, allStates, payload) {
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

async function beginMessageReportPhase(gameId) {
  const game = await repo.getGameById(gameId);
  if (!game || game.status !== "running" || game.phase !== "negotiation") {
    return game;
  }

  await repo.updateGame(gameId, {
    phase: "message_report",
    negotiation_ends_at: null,
    execution_ends_at: null
  });

  return repo.getGameById(gameId);
}

async function beginExecutionPhase(gameId) {
  const game = await repo.getGameById(gameId);
  if (!game || game.status !== "running") {
    return game;
  }

  await repo.updateGame(gameId, {
    phase: "execution",
    negotiation_ends_at: null,
    execution_ends_at: null
  });

  return repo.getGameById(gameId);
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
  const messageReport =
    game.status === "running" && game.phase === "message_report"
      ? await repo.getMessageReportSubmissionStatus(gameId, game.current_turn)
      : null;

  const turnMessageReportResults =
    game.status === "running" && game.current_turn > 0
      ? await repo.getTurnMessageReportResults(gameId, game.current_turn)
      : [];
  const messageReportPenalties = turnMessageReportResults.some((row) => row.globalReportMismatch != null)
    ? turnMessageReportResults
    : null;

  const intelligenceTurn = Math.max(0, game.current_turn - 1);
  const turnActions =
    game.status === "running" && intelligenceTurn > 0
      ? await repo.listTurnActions(gameId, intelligenceTurn)
      : [];
  const intelligence = collectIntelligenceFromActions(turnActions);

  const projectedSurvivalContext = buildSurvivalContext({
    turnNumber: game.current_turn,
    livingAgents,
    game
  });
  const projectedSurvival =
    game.status === "running" && livingAgents.length > 0
      ? Object.fromEntries(
          livingAgents.map((agent) => [
            agent.id,
            computeSurvivalCost(game.config, projectedSurvivalContext)
          ])
        )
      : null;

  return {
    game: {
      id: game.id,
      status: game.status,
      currentTurn: game.current_turn,
      phase: game.phase,
      negotiationEndsAt: game.negotiation_ends_at,
      joiningWindow: joiningWindowDetails(game),
      startedAt: game.started_at,
      finishedAt: game.finished_at,
      winnerIds: game.winnerIds || [],
      communicationCostCompute: communicationCostComputeForTurn(game.config, game.current_turn),
      maxProductionCapacity: game.config.maxProductionCapacity,
      maxStorageCapacity: game.config.maxStorageCapacity
    },
    livingAgentCount: livingAgents.length,
    agents: agents.map((agent) => publicAgentView(agent, viewerAgentId, intelligence)),
    turnInvestments,
    execution,
    messageReport,
    messageReportPenalties,
    projectedSurvival
  };
}

async function getTurnInvestmentSummary(gameId, turnNumber) {
  const actions = await repo.listTurnActions(gameId, turnNumber);
  return actions
    .filter((a) => a.action_type === "invest")
    .map((a) => ({
      agentId: a.agent_id,
      ...repo.parseJson(a.payload_json, {})
    }));
}

function publicAgentView(agent, viewerAgentId, intelligence) {
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
  } else {
    base.inventory = null;
    base.productionCapacity = null;
    base.storageCapacity = null;
    base.intelligenceHidden = true;
  }

  return base;
}

function normalizeAction(action) {
  if (!action || typeof action !== "object") {
    throw gameError("INVALID_ACTION", "Action payload required", 400);
  }
  const type = action.type || "none";
  const normalized = { ...action, type };
  if (type === "invest") {
    return normalizeInvestAction(normalized);
  }
  return normalized;
}

function validateActionPayload(action) {
  const allowed = ["none", "transfer", "invest"];
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

async function requireRunningMessageReport(gameId) {
  const game = await repo.getGameById(gameId);
  if (!game) {
    throw gameError("GAME_NOT_FOUND", "Game not found", 404);
  }
  if (game.status !== "running") {
    throw gameError("GAME_NOT_RUNNING", "Game is not in progress", 409);
  }
  if (game.phase !== "message_report") {
    throw gameError(
      "NOT_MESSAGE_REPORT_PHASE",
      "Message reports are only accepted at the end of negotiation",
      409
    );
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
  submitMessageReport,
  tryCompleteMessageReportPhase,
  submitAction,
  tryCompleteTurn,
  executeTurn,
  beginMessageReportPhase,
  beginExecutionPhase,
  getPublicState,
  applyTurnProduction,
  applyProduction,
  applyStorageCost,
  gameError,
  isJoiningWindowOpen,
  joiningWindowDetails,
  computeSurvivalCost,
  normalizeInvestAction,
  validateBalancedInvestment,
  normalizeFindTargets,
  normalizeHideSpend,
  canViewerSeeCapacities,
  collectIntelligenceFromActions
};
