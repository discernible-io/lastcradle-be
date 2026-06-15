/**
 * Database access layer for the survival game.
 */

const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
const { ulid } = require("ulid");
const { config } = require("@rodit/rodit-auth-be");
const { GAME_TABLES_SQL } = require("./schema");

const DB_PATH = config.get("API_DEFAULT_OPTIONS.DB_PATH");

let db;
let initPromise;

async function getDb() {
  if (db) {
    return db;
  }
  if (!initPromise) {
    initPromise = initializeDatabase();
  }
  return initPromise;
}

async function migrateSchema(database) {
  const gameCols = await database.all(`PRAGMA table_info(games)`);
  if (!gameCols.some((c) => c.name === "joining_window_starts_at")) {
    await database.run(`ALTER TABLE games ADD COLUMN joining_window_starts_at TEXT`);
  }
  if (!gameCols.some((c) => c.name === "joining_window_ends_at")) {
    await database.run(`ALTER TABLE games ADD COLUMN joining_window_ends_at TEXT`);
  }
  if (!gameCols.some((c) => c.name === "aggregate_water_consumed")) {
    await database.run(
      `ALTER TABLE games ADD COLUMN aggregate_water_consumed REAL NOT NULL DEFAULT 0`
    );
  }

  const agentCols = await database.all(`PRAGMA table_info(game_agents)`);
  if (!agentCols.some((c) => c.name === "water_production_investment")) {
    await database.run(
      `ALTER TABLE game_agents ADD COLUMN water_production_investment REAL NOT NULL DEFAULT 0`
    );
  }

  const capacityColumns = [
    "energy_production_capacity",
    "water_production_capacity",
    "compute_production_capacity",
    "energy_storage_capacity",
    "water_storage_capacity",
    "compute_storage_capacity"
  ];
  let refreshedAgentCols = await database.all(`PRAGMA table_info(game_agents)`);
  for (const col of capacityColumns) {
    if (!refreshedAgentCols.some((c) => c.name === col)) {
      await database.run(`ALTER TABLE game_agents ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`);
    }
  }

  refreshedAgentCols = await database.all(`PRAGMA table_info(game_agents)`);
  if (refreshedAgentCols.some((c) => c.name === "energy_production_capacity")) {
    await database.run(
      `UPDATE game_agents SET
        energy_production_capacity = energy_capacity * energy_development,
        water_production_capacity = water_capacity * water_development,
        compute_production_capacity = compute_capacity * compute_development,
        energy_storage_capacity = CASE WHEN energy_storage_capacity = 0 THEN energy_capacity ELSE energy_storage_capacity END,
        water_storage_capacity = CASE WHEN water_storage_capacity = 0 THEN water_capacity ELSE water_storage_capacity END,
        compute_storage_capacity = CASE WHEN compute_storage_capacity = 0 THEN compute_capacity ELSE compute_storage_capacity END
       WHERE status = 'alive'
         AND energy_production_capacity = 0
         AND (energy_capacity > 0 OR water_capacity > 0 OR compute_capacity > 0)`
    );
  }
}

async function initializeDatabase() {
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });
  await db.exec(GAME_TABLES_SQL);
  await migrateSchema(db);
  return db;
}

async function closeDatabase() {
  if (db && typeof db.close === "function") {
    await db.close();
    db = null;
    initPromise = null;
  }
}

/** Remove all game rows — for reusing the same sqlite file between simulation runs. */
async function resetGameData() {
  const database = await getDb();
  await database.exec(`
    DELETE FROM game_message_reports;
    DELETE FROM game_actions;
    DELETE FROM game_messages;
    DELETE FROM game_agents;
    DELETE FROM games;
  `);
}

function parseJson(value, fallback = null) {
  if (value == null || value === "") {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToGame(row) {
  if (!row) return null;
  return {
    ...row,
    config: parseJson(row.config_json, {}),
    turnGrowth: parseJson(row.turn_growth_json, null),
    winnerIds: parseJson(row.winner_ids_json, []),
    aggregateWaterConsumed: row.aggregate_water_consumed ?? 0
  };
}

function rowToAgent(row) {
  if (!row) return null;
  return {
    id: row.id,
    gameId: row.game_id,
    roditId: row.rodit_id,
    displayName: row.display_name,
    status: row.status,
    inventory: {
      energy: row.energy_inventory,
      water: row.water_inventory,
      compute: row.compute_inventory
    },
    productionCapacity: {
      energy: row.energy_production_capacity ?? row.energy_capacity * (row.energy_development ?? 1),
      water: row.water_production_capacity ?? row.water_capacity * (row.water_development ?? 1),
      compute: row.compute_production_capacity ?? row.compute_capacity * (row.compute_development ?? 1)
    },
    storageCapacity: {
      energy: row.energy_storage_capacity ?? row.energy_capacity ?? 0,
      water: row.water_storage_capacity ?? row.water_capacity ?? 0,
      compute: row.compute_storage_capacity ?? row.compute_capacity ?? 0
    },
    waterProductionInvestment: row.water_production_investment ?? 0,
    diedAtTurn: row.died_at_turn,
    joinedAt: row.joined_at
  };
}

async function createGame({ config: gameConfig, joiningWindowStartsAt = null, joiningWindowEndsAt = null }) {
  const database = await getDb();
  const id = ulid();
  await database.run(
    `INSERT INTO games (id, status, config_json, joining_window_starts_at, joining_window_ends_at)
     VALUES (?, 'lobby', ?, ?, ?)`,
    [id, JSON.stringify(gameConfig), joiningWindowStartsAt, joiningWindowEndsAt]
  );
  return getGameById(id);
}

async function getGameById(gameId) {
  const database = await getDb();
  const row = await database.get(`SELECT * FROM games WHERE id = ?`, [gameId]);
  return rowToGame(row);
}

async function updateGame(gameId, fields) {
  const database = await getDb();
  const allowed = [
    "status",
    "current_turn",
    "phase",
    "config_json",
    "aggregate_water_consumed",
    "negotiation_ends_at",
    "execution_ends_at",
    "joining_window_starts_at",
    "joining_window_ends_at",
    "turn_growth_json",
    "winner_ids_json",
    "started_at",
    "finished_at"
  ];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) {
    return getGameById(gameId);
  }
  values.push(gameId);
  await database.run(`UPDATE games SET ${sets.join(", ")} WHERE id = ?`, values);
  return getGameById(gameId);
}

async function listRunningGames() {
  const database = await getDb();
  const rows = await database.all(
    `SELECT * FROM games WHERE status = 'running' ORDER BY started_at ASC`
  );
  return rows.map(rowToGame);
}

async function addAgent({
  gameId,
  roditId,
  displayName,
  energyCapacity,
  waterCapacity,
  computeCapacity,
  startingInventory
}) {
  const database = await getDb();
  const id = ulid();
  await database.run(
    `INSERT INTO game_agents (
      id, game_id, rodit_id, display_name,
      energy_inventory, water_inventory, compute_inventory,
      energy_production_capacity, water_production_capacity, compute_production_capacity,
      energy_storage_capacity, water_storage_capacity, compute_storage_capacity,
      energy_development, water_development, compute_development,
      energy_capacity, water_capacity, compute_capacity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, 1.0, 1.0, ?, ?, ?)`,
    [
      id,
      gameId,
      roditId,
      displayName || roditId,
      startingInventory.energy,
      startingInventory.water,
      startingInventory.compute,
      energyCapacity,
      waterCapacity,
      computeCapacity,
      energyCapacity,
      waterCapacity,
      computeCapacity,
      energyCapacity,
      waterCapacity,
      computeCapacity
    ]
  );
  return getAgentById(id);
}

async function getAgentById(agentId) {
  const database = await getDb();
  const row = await database.get(`SELECT * FROM game_agents WHERE id = ?`, [agentId]);
  return rowToAgent(row);
}

async function getAgentByRoditId(gameId, roditId) {
  const database = await getDb();
  const row = await database.get(
    `SELECT * FROM game_agents WHERE game_id = ? AND rodit_id = ?`,
    [gameId, roditId]
  );
  return rowToAgent(row);
}

async function listAgents(gameId, { status } = {}) {
  const database = await getDb();
  let sql = `SELECT * FROM game_agents WHERE game_id = ?`;
  const params = [gameId];
  if (status) {
    sql += ` AND status = ?`;
    params.push(status);
  }
  sql += ` ORDER BY joined_at ASC`;
  const rows = await database.all(sql, params);
  return rows.map(rowToAgent);
}

async function countAgents(gameId) {
  const database = await getDb();
  const row = await database.get(
    `SELECT COUNT(*) AS count FROM game_agents WHERE game_id = ?`,
    [gameId]
  );
  return row.count;
}

async function countLivingAgents(gameId) {
  const database = await getDb();
  const row = await database.get(
    `SELECT COUNT(*) AS count FROM game_agents WHERE game_id = ? AND status = 'alive'`,
    [gameId]
  );
  return row.count;
}

async function updateAgentInventory(agentId, inventory) {
  const database = await getDb();
  await database.run(
    `UPDATE game_agents SET
      energy_inventory = ?,
      water_inventory = ?,
      compute_inventory = ?
    WHERE id = ?`,
    [inventory.energy, inventory.water, inventory.compute, agentId]
  );
}

async function updateAgentCapacities(agentId, productionCapacity, storageCapacity) {
  const database = await getDb();
  await database.run(
    `UPDATE game_agents SET
      energy_production_capacity = ?,
      water_production_capacity = ?,
      compute_production_capacity = ?,
      energy_storage_capacity = ?,
      water_storage_capacity = ?,
      compute_storage_capacity = ?
    WHERE id = ?`,
    [
      productionCapacity.energy,
      productionCapacity.water,
      productionCapacity.compute,
      storageCapacity.energy,
      storageCapacity.water,
      storageCapacity.compute,
      agentId
    ]
  );
}

async function killAgent(agentId, turnNumber) {
  const database = await getDb();
  await database.run(
    `UPDATE game_agents SET
      status = 'dead',
      energy_inventory = 0,
      water_inventory = 0,
      compute_inventory = 0,
      energy_production_capacity = 0,
      water_production_capacity = 0,
      compute_production_capacity = 0,
      energy_storage_capacity = 0,
      water_storage_capacity = 0,
      compute_storage_capacity = 0,
      energy_capacity = 0,
      water_capacity = 0,
      compute_capacity = 0,
      died_at_turn = ?
    WHERE id = ?`,
    [turnNumber, agentId]
  );
}

async function addMessage({
  gameId,
  turnNumber,
  fromAgentId,
  toAgentId,
  body,
  computeCost,
  isPublic
}) {
  const database = await getDb();
  const id = ulid();
  await database.run(
    `INSERT INTO game_messages (
      id, game_id, turn_number, from_agent_id, to_agent_id, body, compute_cost, is_public
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, gameId, turnNumber, fromAgentId, toAgentId || null, body, computeCost, isPublic ? 1 : 0]
  );
  return database.get(`SELECT * FROM game_messages WHERE id = ?`, [id]);
}

async function listPublicMessages(gameId, turnNumber) {
  const database = await getDb();
  return database.all(
    `SELECT * FROM game_messages
     WHERE game_id = ? AND turn_number = ? AND is_public = 1
     ORDER BY created_at ASC`,
    [gameId, turnNumber]
  );
}

async function listMessages(gameId, turnNumber, { agentId, includePrivate = false }) {
  const database = await getDb();
  const rows = await database.all(
    `SELECT * FROM game_messages WHERE game_id = ? AND turn_number = ? ORDER BY created_at ASC`,
    [gameId, turnNumber]
  );
  return rows.filter((msg) => {
    if (msg.is_public) return true;
    if (includePrivate) return true;
    if (!agentId) return false;
    return msg.from_agent_id === agentId || msg.to_agent_id === agentId || msg.to_agent_id == null;
  });
}

async function upsertAction({
  gameId,
  turnNumber,
  agentId,
  actionType,
  payload,
  status = "pending"
}) {
  const database = await getDb();
  const existing = await database.get(
    `SELECT id FROM game_actions WHERE game_id = ? AND turn_number = ? AND agent_id = ?`,
    [gameId, turnNumber, agentId]
  );
  const payloadJson = JSON.stringify(payload);
  if (existing) {
    await database.run(
      `UPDATE game_actions SET action_type = ?, payload_json = ?, status = ?, submitted_at = datetime('now'), error_message = NULL
       WHERE id = ?`,
      [actionType, payloadJson, status, existing.id]
    );
    return database.get(`SELECT * FROM game_actions WHERE id = ?`, [existing.id]);
  }
  const id = ulid();
  await database.run(
    `INSERT INTO game_actions (id, game_id, turn_number, agent_id, action_type, payload_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, gameId, turnNumber, agentId, actionType, payloadJson, status]
  );
  return database.get(`SELECT * FROM game_actions WHERE id = ?`, [id]);
}

async function getAction(gameId, turnNumber, agentId) {
  const database = await getDb();
  return database.get(
    `SELECT * FROM game_actions WHERE game_id = ? AND turn_number = ? AND agent_id = ?`,
    [gameId, turnNumber, agentId]
  );
}

async function listTurnActions(gameId, turnNumber) {
  const database = await getDb();
  return database.all(
    `SELECT * FROM game_actions WHERE game_id = ? AND turn_number = ? ORDER BY submitted_at ASC`,
    [gameId, turnNumber]
  );
}

async function markActionExecuted(actionId, status, errorMessage = null) {
  const database = await getDb();
  await database.run(
    `UPDATE game_actions SET status = ?, error_message = ?, executed_at = datetime('now') WHERE id = ?`,
    [status, errorMessage, actionId]
  );
}

async function listTurnInvestments(gameId, turnNumber) {
  const database = await getDb();
  const actions = await listTurnActions(gameId, turnNumber);
  return actions
    .filter((a) => a.action_type === "invest" && a.status !== "failed")
    .map((a) => ({
      agentId: a.agent_id,
      payload: parseJson(a.payload_json, {})
    }));
}

async function getExecutionSubmissionStatus(gameId, turnNumber) {
  const database = await getDb();
  const livingAgents = await listAgents(gameId, { status: "alive" });
  const actions = await listTurnActions(gameId, turnNumber);
  const submittedIds = new Set(actions.map((a) => a.agent_id));
  const pendingAgentIds = livingAgents.filter((a) => !submittedIds.has(a.id)).map((a) => a.id);

  return {
    livingCount: livingAgents.length,
    submittedCount: livingAgents.length - pendingAgentIds.length,
    allSubmitted: livingAgents.length > 0 && pendingAgentIds.length === 0,
    submittedAgentIds: livingAgents.filter((a) => submittedIds.has(a.id)).map((a) => a.id),
    pendingAgentIds
  };
}

async function allLivingAgentsSubmitted(gameId, turnNumber) {
  const status = await getExecutionSubmissionStatus(gameId, turnNumber);
  return status.allSubmitted;
}

async function getActualMessageCounts(gameId, turnNumber, agentId) {
  const database = await getDb();
  const sentRow = await database.get(
    `SELECT COUNT(*) AS count FROM game_messages
     WHERE game_id = ? AND turn_number = ? AND from_agent_id = ?`,
    [gameId, turnNumber, agentId]
  );
  const directRow = await database.get(
    `SELECT COUNT(*) AS count FROM game_messages
     WHERE game_id = ? AND turn_number = ? AND to_agent_id = ?`,
    [gameId, turnNumber, agentId]
  );
  const broadcastRows = await database.all(
    `SELECT from_agent_id FROM game_messages
     WHERE game_id = ? AND turn_number = ? AND to_agent_id IS NULL`,
    [gameId, turnNumber]
  );
  const broadcastReceived = broadcastRows.filter((row) => row.from_agent_id !== agentId).length;

  return {
    sent: sentRow.count,
    received: directRow.count + broadcastReceived
  };
}

async function getActualMessageCountsForTurn(gameId, turnNumber) {
  const livingAgents = await listAgents(gameId, { status: "alive" });
  const counts = {};
  for (const agent of livingAgents) {
    counts[agent.id] = await getActualMessageCounts(gameId, turnNumber, agent.id);
  }
  return counts;
}

async function upsertMessageReport({ gameId, turnNumber, agentId, reportedSent, reportedReceived }) {
  const database = await getDb();
  const existing = await database.get(
    `SELECT id FROM game_message_reports WHERE game_id = ? AND turn_number = ? AND agent_id = ?`,
    [gameId, turnNumber, agentId]
  );
  if (existing) {
    await database.run(
      `UPDATE game_message_reports
       SET reported_sent = ?, reported_received = ?, submitted_at = datetime('now')
       WHERE id = ?`,
      [reportedSent, reportedReceived, existing.id]
    );
    return database.get(`SELECT * FROM game_message_reports WHERE id = ?`, [existing.id]);
  }
  const id = ulid();
  await database.run(
    `INSERT INTO game_message_reports (
      id, game_id, turn_number, agent_id, reported_sent, reported_received
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, gameId, turnNumber, agentId, reportedSent, reportedReceived]
  );
  return database.get(`SELECT * FROM game_message_reports WHERE id = ?`, [id]);
}

async function getMessageReportSubmissionStatus(gameId, turnNumber) {
  const livingAgents = await listAgents(gameId, { status: "alive" });
  const database = await getDb();
  const reports = await database.all(
    `SELECT agent_id FROM game_message_reports WHERE game_id = ? AND turn_number = ?`,
    [gameId, turnNumber]
  );
  const submittedIds = new Set(reports.map((r) => r.agent_id));
  const pendingAgentIds = livingAgents.filter((a) => !submittedIds.has(a.id)).map((a) => a.id);

  return {
    livingCount: livingAgents.length,
    submittedCount: livingAgents.length - pendingAgentIds.length,
    allSubmitted: livingAgents.length > 0 && pendingAgentIds.length === 0,
    submittedAgentIds: livingAgents.filter((a) => submittedIds.has(a.id)).map((a) => a.id),
    pendingAgentIds
  };
}

async function allMessageReportsSubmitted(gameId, turnNumber) {
  const status = await getMessageReportSubmissionStatus(gameId, turnNumber);
  return status.allSubmitted;
}

function computeGlobalReportMismatch(reports, livingCount, allPublic) {
  let totalReportedSent = 0;
  let totalReportedReceived = 0;
  for (const report of reports) {
    if (!report) continue;
    totalReportedSent += report.reported_sent ?? 0;
    totalReportedReceived += report.reported_received ?? 0;
  }
  if (allPublic) {
    const expectedReceivedTotal = totalReportedSent * Math.max(livingCount - 1, 0);
    return Math.abs(totalReportedReceived - expectedReceivedTotal);
  }
  return Math.abs(totalReportedSent - totalReportedReceived);
}

async function findMessageReportOutlier(
  gameId,
  turnNumber,
  reports,
  livingAgents,
  allPublic,
  options
) {
  const threshold = options.outlierThreshold ?? options.discardThreshold ?? 11;
  const minFixRatio = options.outlierMinFixRatio ?? 0.77;
  const reportByAgent = new Map(reports.map((r) => [r.agent_id, r]));

  const baseline = computeGlobalReportMismatch(reports, livingAgents.length, allPublic);
  if (baseline < threshold) {
    return null;
  }

  let bestId = null;
  let bestReduction = 0;
  let correctedMismatch = baseline;

  for (const agent of livingAgents) {
    const actual = await getActualMessageCounts(gameId, turnNumber, agent.id);
    const correctedReports = livingAgents.map((a) => {
      if (a.id === agent.id) {
        return { reported_sent: actual.sent, reported_received: actual.received };
      }
      const row = reportByAgent.get(a.id);
      return { reported_sent: row.reported_sent, reported_received: row.reported_received };
    });
    const mismatch = computeGlobalReportMismatch(correctedReports, livingAgents.length, allPublic);
    const reduction = baseline - mismatch;
    if (reduction > bestReduction) {
      bestReduction = reduction;
      bestId = agent.id;
      correctedMismatch = mismatch;
    }
  }

  if (!bestId || bestReduction < baseline * minFixRatio) {
    return null;
  }

  return {
    agentId: bestId,
    baselineMismatch: baseline,
    correctedMismatch,
    mismatchReduction: bestReduction
  };
}

async function finalizeMessageReports(gameId, turnNumber, options = {}) {
  const penaltyPerTen = options.penaltyPerTen ?? 1;
  const communicationCostCompute = options.communicationCostCompute ?? 1;
  const outlierExcludeEnabled =
    options.outlierExcludeEnabled !== false && options.discardEnabled !== false;
  const database = await getDb();
  const livingAgents = await listAgents(gameId, { status: "alive" });
  const reports = await database.all(
    `SELECT * FROM game_message_reports WHERE game_id = ? AND turn_number = ?`,
    [gameId, turnNumber]
  );
  const reportByAgent = new Map(reports.map((r) => [r.agent_id, r]));

  const messageRow = await database.get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN to_agent_id IS NULL THEN 1 ELSE 0 END) AS public_count
     FROM game_messages WHERE game_id = ? AND turn_number = ?`,
    [gameId, turnNumber]
  );
  const allPublic =
    messageRow.total > 0 && messageRow.public_count === messageRow.total;

  const baselineMismatch = computeGlobalReportMismatch(reports, livingAgents.length, allPublic);

  let outlierAgentId = null;
  let outlierInfo = null;

  if (outlierExcludeEnabled) {
    const outlier = await findMessageReportOutlier(
      gameId,
      turnNumber,
      reports,
      livingAgents,
      allPublic,
      options
    );
    if (outlier) {
      outlierAgentId = outlier.agentId;
      outlierInfo = outlier;
    }
  }

  const sharedMismatch = outlierInfo?.correctedMismatch ?? baselineMismatch;
  const sharedEnergyPenalty = Math.floor(sharedMismatch / 10) * penaltyPerTen;
  const outlierEnergyPenalty = outlierInfo
    ? Math.floor(outlierInfo.baselineMismatch / 10) * penaltyPerTen
    : sharedEnergyPenalty;

  let totalReportedSent = 0;
  let totalReportedReceived = 0;
  for (const report of reports) {
    totalReportedSent += report.reported_sent;
    totalReportedReceived += report.reported_received;
  }

  const results = [];

  for (const agent of livingAgents) {
    const report = reportByAgent.get(agent.id);
    const reportedSent = report?.reported_sent ?? 0;
    const reportedReceived = report?.reported_received ?? 0;
    const actual = await getActualMessageCounts(gameId, turnNumber, agent.id);
    const computeDeduction = reportedSent * communicationCostCompute;
    const isOutlier = agent.id === outlierAgentId;
    const energySurvivalPenalty = isOutlier ? outlierEnergyPenalty : sharedEnergyPenalty;
    const recordedMismatch = isOutlier ? outlierInfo.baselineMismatch : sharedMismatch;

    const agentState = await getAgentById(agent.id);
    if (agentState) {
      await updateAgentInventory(agent.id, {
        energy: agentState.inventory.energy,
        water: agentState.inventory.water,
        compute: agentState.inventory.compute - computeDeduction
      });
    }

    await database.run(
      `UPDATE game_message_reports SET
        actual_sent = ?,
        actual_received = ?,
        mismatch = ?,
        energy_survival_penalty = ?
       WHERE game_id = ? AND turn_number = ? AND agent_id = ?`,
      [
        actual.sent,
        actual.received,
        recordedMismatch,
        energySurvivalPenalty,
        gameId,
        turnNumber,
        agent.id
      ]
    );

    results.push({
      agentId: agent.id,
      reportedSent,
      reportedReceived,
      actualSent: actual.sent,
      actualReceived: actual.received,
      computeDeduction,
      globalReportMismatch: recordedMismatch,
      energySurvivalPenalty,
      messageReportOutlier: isOutlier
    });
  }

  return {
    globalReportMismatch: sharedMismatch,
    baselineMismatch,
    totalReportedSent,
    totalReportedReceived,
    energySurvivalPenalty: sharedEnergyPenalty,
    communicationCostCompute,
    outlierAgentId,
    outlierInfo,
    agents: results
  };
}

async function getTurnMessageReportResults(gameId, turnNumber) {
  const database = await getDb();
  const rows = await database.all(
    `SELECT * FROM game_message_reports WHERE game_id = ? AND turn_number = ?`,
    [gameId, turnNumber]
  );
  return rows.map((row) => ({
    agentId: row.agent_id,
    reportedSent: row.reported_sent,
    reportedReceived: row.reported_received,
    globalReportMismatch: row.mismatch,
    energySurvivalPenalty: row.energy_survival_penalty
  }));
}

async function getAgentEnergySurvivalPenalty(gameId, turnNumber, agentId) {
  const database = await getDb();
  const row = await database.get(
    `SELECT energy_survival_penalty FROM game_message_reports
     WHERE game_id = ? AND turn_number = ? AND agent_id = ?`,
    [gameId, turnNumber, agentId]
  );
  return row?.energy_survival_penalty ?? 0;
}

async function incrementAggregateWaterConsumed(gameId, amount) {
  if (!amount || amount <= 0) return;
  const database = await getDb();
  await database.run(
    `UPDATE games SET aggregate_water_consumed = aggregate_water_consumed + ? WHERE id = ?`,
    [amount, gameId]
  );
}

/** Halve cumulative water consumption — environmental relief when territories are eliminated. */
async function halveAggregateWaterConsumed(gameId) {
  const database = await getDb();
  await database.run(
    `UPDATE games SET aggregate_water_consumed = aggregate_water_consumed / 2.0 WHERE id = ?`,
    [gameId]
  );
}

async function addWaterProductionInvestment(agentId, amount) {
  if (!amount || amount <= 0) return;
  const database = await getDb();
  await database.run(
    `UPDATE game_agents SET water_production_investment = water_production_investment + ? WHERE id = ?`,
    [amount, agentId]
  );
}

function sumWaterProductionInvestment(agents) {
  return agents.reduce((sum, agent) => sum + (agent.waterProductionInvestment || 0), 0);
}

module.exports = {
  getDb,
  initializeDatabase,
  closeDatabase,
  resetGameData,
  createGame,
  getGameById,
  updateGame,
  listRunningGames,
  addAgent,
  getAgentById,
  getAgentByRoditId,
  listAgents,
  countAgents,
  countLivingAgents,
  updateAgentInventory,
  updateAgentCapacities,
  killAgent,
  addMessage,
  listPublicMessages,
  listMessages,
  upsertAction,
  getAction,
  listTurnActions,
  markActionExecuted,
  listTurnInvestments,
  getExecutionSubmissionStatus,
  allLivingAgentsSubmitted,
  getActualMessageCounts,
  getActualMessageCountsForTurn,
  upsertMessageReport,
  getMessageReportSubmissionStatus,
  allMessageReportsSubmitted,
  finalizeMessageReports,
  getTurnMessageReportResults,
  getAgentEnergySurvivalPenalty,
  incrementAggregateWaterConsumed,
  halveAggregateWaterConsumed,
  addWaterProductionInvestment,
  sumWaterProductionInvestment,
  parseJson,
  rowToAgent,
  rowToGame
};
