/**
 * Database access layer for the survival game.
 */

const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
const { ulid } = require("ulid");
const { config } = require("@rodit/rodit-auth-be");
const { GAME_TABLES_SQL } = require("./schema");
const { canonicalRoditId, compoundRoditIdMatchSql } = require("./rodit-id");

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
  if (!gameCols.some((c) => c.name === "message_report_ends_at")) {
    await database.run(`ALTER TABLE games ADD COLUMN message_report_ends_at TEXT`);
  }
  if (!gameCols.some((c) => c.name === "ends_at")) {
    await database.run(`ALTER TABLE games ADD COLUMN ends_at TEXT`);
  }

  const contestCols = await database.all(`PRAGMA table_info(contests)`);
  if (contestCols.length > 0 && !contestCols.some((c) => c.name === "prize_winner_ids_json")) {
    await database.run(`ALTER TABLE contests ADD COLUMN prize_winner_ids_json TEXT`);
  }

  await database.exec(`
    CREATE TABLE IF NOT EXISTS contests (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'scheduled',
      practice_game_id TEXT,
      definitive_game_id TEXT,
      practice_window_starts_at TEXT,
      practice_window_ends_at TEXT,
      definitive_joining_starts_at TEXT,
      prize_amount_yocto TEXT,
      prize_status TEXT,
      prize_winner_rodit_id TEXT,
      prize_winner_agent_id TEXT,
      prize_winner_ids_json TEXT,
      prize_settled_at TEXT,
      prize_tx_reference TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (practice_game_id) REFERENCES games(id),
      FOREIGN KEY (definitive_game_id) REFERENCES games(id)
    );
    CREATE INDEX IF NOT EXISTS idx_contests_status ON contests(status);

    CREATE TABLE IF NOT EXISTS url_join_identities (
      rodit_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      webhook_url TEXT NOT NULL,
      display_name TEXT,
      openapijson_url TEXT,
      not_after TEXT NOT NULL,
      not_before TEXT NOT NULL,
      max_requests TEXT NOT NULL,
      maxrq_window TEXT NOT NULL,
      webhook_cidr TEXT,
      allowed_cidr TEXT,
      allowed_iso3166list TEXT,
      jwt_duration TEXT NOT NULL,
      permissioned_routes TEXT,
      subjectuniqueidentifier_url TEXT,
      serviceprovider_id TEXT,
      serviceprovider_signature TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_url_join_identities_webhook ON url_join_identities(webhook_url);

    CREATE TABLE IF NOT EXISTS contest_seasons (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled',
      practice_starts_at TEXT NOT NULL,
      practice_ends_at TEXT NOT NULL,
      qualifying_starts_at TEXT NOT NULL,
      qualifying_ends_at TEXT NOT NULL,
      final_joining_starts_at TEXT,
      final_game_id TEXT,
      final_roster_json TEXT,
      prize_amount_yocto TEXT,
      prize_status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (final_game_id) REFERENCES games(id)
    );
    CREATE INDEX IF NOT EXISTS idx_contest_seasons_status ON contest_seasons(status);

    CREATE TABLE IF NOT EXISTS season_practice_credits (
      season_id TEXT NOT NULL,
      rodit_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (season_id, rodit_id),
      FOREIGN KEY (season_id) REFERENCES contest_seasons(id),
      FOREIGN KEY (game_id) REFERENCES games(id)
    );

    CREATE TABLE IF NOT EXISTS season_qualifying_wins (
      season_id TEXT NOT NULL,
      rodit_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      agent_id TEXT,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (season_id, rodit_id, game_id),
      FOREIGN KEY (season_id) REFERENCES contest_seasons(id),
      FOREIGN KEY (game_id) REFERENCES games(id)
    );
  `);

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

  refreshedAgentCols = await database.all(`PRAGMA table_info(game_agents)`);
  if (!refreshedAgentCols.some((c) => c.name === "death_reason_json")) {
    await database.run(`ALTER TABLE game_agents ADD COLUMN death_reason_json TEXT`);
  }

  refreshedAgentCols = await database.all(`PRAGMA table_info(game_agents)`);
  if (!refreshedAgentCols.some((c) => c.name === "agent_type")) {
    await database.run(`ALTER TABLE game_agents ADD COLUMN agent_type TEXT`);
  }
  if (!refreshedAgentCols.some((c) => c.name === "llm_model")) {
    await database.run(`ALTER TABLE game_agents ADD COLUMN llm_model TEXT`);
  }

  await database.exec(`
    CREATE TABLE IF NOT EXISTS game_recollections (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      context TEXT NOT NULL,
      relationships TEXT,
      espionage TEXT,
      investment TEXT,
      trade TEXT,
      incidents TEXT,
      overview TEXT,
      submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (game_id) REFERENCES games(id),
      FOREIGN KEY (agent_id) REFERENCES game_agents(id),
      UNIQUE (game_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_game_recollections_game ON game_recollections(game_id);

    CREATE TABLE IF NOT EXISTS rodit_login_methods (
      rodit_id TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      ip TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS game_ip_login_methods (
      game_id TEXT NOT NULL,
      ip TEXT NOT NULL,
      method TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (game_id, ip),
      FOREIGN KEY (game_id) REFERENCES games(id)
    );
    CREATE INDEX IF NOT EXISTS idx_game_ip_login_methods_ip ON game_ip_login_methods(ip);

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // One-time: drop permanent sticky IP locks when introducing the 10-minute cool-down.
  const ipTtlReset = await database.get(
    `SELECT id FROM schema_migrations WHERE id = ?`,
    ["ip_login_method_ttl_v1_reset"]
  );
  if (!ipTtlReset) {
    await database.run(`DELETE FROM game_ip_login_methods`);
    await database.run(`INSERT INTO schema_migrations (id) VALUES (?)`, [
      "ip_login_method_ttl_v1_reset"
    ]);
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
    DELETE FROM game_recollections;
    DELETE FROM game_message_reports;
    DELETE FROM game_actions;
    DELETE FROM game_messages;
    DELETE FROM game_agents;
    DELETE FROM game_ip_login_methods;
    DELETE FROM rodit_login_methods;
    DELETE FROM url_join_identities;
    DELETE FROM contests;
    DELETE FROM games;
  `);
}

async function upsertRoditLoginMethod({ roditId, method, ip = null }) {
  const id = canonicalRoditId(roditId);
  if (!id || !method) {
    return null;
  }
  const database = await getDb();
  await database.run(
    `INSERT INTO rodit_login_methods (rodit_id, method, ip, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(rodit_id) DO UPDATE SET
       method = excluded.method,
       ip = excluded.ip,
       updated_at = datetime('now')`,
    [id, method, ip]
  );
  return getRoditLoginMethod(id);
}

async function getRoditLoginMethod(roditId) {
  const id = canonicalRoditId(roditId);
  if (!id) {
    return null;
  }
  const database = await getDb();
  const row = await database.get(
    `SELECT rodit_id AS roditId, method, ip, updated_at AS updatedAt
     FROM rodit_login_methods WHERE rodit_id = ?`,
    [id]
  );
  return row || null;
}

const DEFAULT_IP_LOGIN_METHOD_LOCK_TTL_MS = 10 * 60 * 1000;
const IP_LOGIN_METHOD_GUEST = "guest";

function parseSqliteUtcMs(raw) {
  if (!raw) {
    return null;
  }
  const s = String(raw);
  const iso = s.includes("T") ? s : `${s.replace(" ", "T")}Z`;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function ipLoginMethodLockReject(existing, lockTtlMs, reason) {
  const createdMs = parseSqliteUtcMs(existing.createdAt);
  const expiresAtMs = createdMs != null ? createdMs + lockTtlMs : null;
  const retryAfterSeconds =
    expiresAtMs != null ? Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 1000)) : null;
  return {
    ok: false,
    lockedMethod: existing.method,
    reason,
    retryAfterSeconds,
    lockedUntil: expiresAtMs != null ? new Date(expiresAtMs).toISOString() : null
  };
}

async function getGameIpLoginMethod(gameId, ip) {
  if (!gameId || !ip) {
    return null;
  }
  const database = await getDb();
  const row = await database.get(
    `SELECT game_id AS gameId, ip, method, created_at AS createdAt
     FROM game_ip_login_methods WHERE game_id = ? AND ip = ?`,
    [gameId, ip]
  );
  return row || null;
}

async function deleteGameIpLoginMethod(gameId, ip) {
  if (!gameId || !ip) {
    return;
  }
  const database = await getDb();
  await database.run(`DELETE FROM game_ip_login_methods WHERE game_id = ? AND ip = ?`, [
    gameId,
    ip
  ]);
}

/**
 * Bind a guest seat for (gameId, ip) for ttlMs (default 10 minutes).
 * Passport methods are not limited and do not occupy the slot.
 * Returns { ok, lockedMethod, retryAfterSeconds?, lockedUntil?, reason? }.
 * ok=false when an unexpired guest seat is already bound for this IP and game.
 */
async function bindGameIpLoginMethod({
  gameId,
  ip,
  method,
  ttlMs = DEFAULT_IP_LOGIN_METHOD_LOCK_TTL_MS
}) {
  if (!gameId || !ip || !method) {
    return { ok: false, lockedMethod: null, reason: "missing_args" };
  }
  const lockTtlMs =
    typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0
      ? ttlMs
      : DEFAULT_IP_LOGIN_METHOD_LOCK_TTL_MS;

  if (method !== IP_LOGIN_METHOD_GUEST) {
    return { ok: true, lockedMethod: method };
  }

  const database = await getDb();
  const existing = await getGameIpLoginMethod(gameId, ip);
  if (existing) {
    const createdMs = parseSqliteUtcMs(existing.createdAt);
    const expiresAtMs = createdMs != null ? createdMs + lockTtlMs : null;
    const expired = expiresAtMs != null && Date.now() >= expiresAtMs;
    if (!expired && existing.method === IP_LOGIN_METHOD_GUEST) {
      return ipLoginMethodLockReject(existing, lockTtlMs, "guest_already_bound");
    }
    // Expired guest seat, or a legacy passport row from the old method lock.
    await deleteGameIpLoginMethod(gameId, ip);
  }
  try {
    await database.run(
      `INSERT INTO game_ip_login_methods (game_id, ip, method) VALUES (?, ?, ?)`,
      [gameId, ip, method]
    );
    return { ok: true, lockedMethod: method };
  } catch (err) {
    // Race: another request bound first
    const again = await getGameIpLoginMethod(gameId, ip);
    if (again && again.method === IP_LOGIN_METHOD_GUEST) {
      const createdMs = parseSqliteUtcMs(again.createdAt);
      const expiresAtMs = createdMs != null ? createdMs + lockTtlMs : null;
      if (expiresAtMs != null && Date.now() >= expiresAtMs) {
        await deleteGameIpLoginMethod(gameId, ip);
        await database.run(
          `INSERT INTO game_ip_login_methods (game_id, ip, method) VALUES (?, ?, ?)`,
          [gameId, ip, method]
        );
        return { ok: true, lockedMethod: method };
      }
      return ipLoginMethodLockReject(again, lockTtlMs, "guest_already_bound");
    }
    if (again) {
      await deleteGameIpLoginMethod(gameId, ip);
      await database.run(
        `INSERT INTO game_ip_login_methods (game_id, ip, method) VALUES (?, ?, ?)`,
        [gameId, ip, method]
      );
      return { ok: true, lockedMethod: method };
    }
    return { ok: false, lockedMethod: null };
  }
}

async function insertUrlJoinIdentity(fields) {
  const database = await getDb();
  await database.run(
    `INSERT INTO url_join_identities (
      rodit_id, owner_id, webhook_url, display_name,
      openapijson_url, not_after, not_before, max_requests, maxrq_window,
      webhook_cidr, allowed_cidr, allowed_iso3166list, jwt_duration,
      permissioned_routes, subjectuniqueidentifier_url,
      serviceprovider_id, serviceprovider_signature
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.roditId,
      fields.ownerId,
      fields.webhookUrl,
      fields.displayName ?? null,
      fields.openapijsonUrl ?? "",
      fields.notAfter,
      fields.notBefore,
      fields.maxRequests,
      fields.maxrqWindow,
      fields.webhookCidr ?? "",
      fields.allowedCidr ?? "",
      fields.allowedIso3166list ?? "",
      fields.jwtDuration,
      fields.permissionedRoutes ?? "",
      fields.subjectuniqueidentifierUrl ?? "",
      fields.serviceproviderId ?? "",
      fields.serviceproviderSignature ?? ""
    ]
  );
  return getUrlJoinIdentity(fields.roditId);
}

async function getUrlJoinIdentity(roditId) {
  const database = await getDb();
  const canonical = canonicalRoditId(roditId);
  if (!canonical) {
    return null;
  }
  return database.get(`SELECT * FROM url_join_identities WHERE rodit_id = ?`, [canonical]);
}

async function deleteUrlJoinIdentity(roditId) {
  const canonical = canonicalRoditId(roditId);
  if (!canonical) {
    return false;
  }
  const database = await getDb();
  const result = await database.run(`DELETE FROM url_join_identities WHERE rodit_id = ?`, [
    canonical
  ]);
  return result.changes > 0;
}

/** Roll back a lobby seat when URL-join finalize fails after joinGame. */
async function deleteLobbyAgentByRoditId(gameId, roditId) {
  const id = canonicalRoditId(roditId);
  if (!gameId || !id) {
    return false;
  }
  const game = await getGameById(gameId);
  if (!game || game.status !== "lobby") {
    return false;
  }
  const database = await getDb();
  const result = await database.run(
    `DELETE FROM game_agents WHERE game_id = ? AND rodit_id = ? AND status = 'alive'`,
    [gameId, id]
  );
  return result.changes > 0;
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
    agentType: row.agent_type ?? null,
    llmModel: row.llm_model ?? null,
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
    deathReason: parseJson(row.death_reason_json, null),
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
    "message_report_ends_at",
    "execution_ends_at",
    "ends_at",
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

async function listLobbyGames() {
  const database = await getDb();
  const rows = await database.all(
    `SELECT * FROM games WHERE status = 'lobby' ORDER BY created_at ASC`
  );
  return rows.map(rowToGame);
}

/** Cancelled games that never left lobby (no started_at). */
async function listNeverStartedCancelledGames() {
  const database = await getDb();
  const rows = await database.all(
    `SELECT * FROM games WHERE status = 'cancelled' AND started_at IS NULL ORDER BY created_at ASC`
  );
  return rows.map(rowToGame);
}

/**
 * Remove a game and all per-game rows. Does not touch contests, url_join_identities,
 * or rodit_login_methods (those are not scoped to a single game).
 */
async function deleteGameCascade(gameId) {
  const database = await getDb();
  await database.run(`DELETE FROM game_recollections WHERE game_id = ?`, [gameId]);
  await database.run(`DELETE FROM game_message_reports WHERE game_id = ?`, [gameId]);
  await database.run(`DELETE FROM game_actions WHERE game_id = ?`, [gameId]);
  await database.run(`DELETE FROM game_messages WHERE game_id = ?`, [gameId]);
  await database.run(`DELETE FROM game_agents WHERE game_id = ?`, [gameId]);
  await database.run(`DELETE FROM game_ip_login_methods WHERE game_id = ?`, [gameId]);
  const result = await database.run(`DELETE FROM games WHERE id = ?`, [gameId]);
  return (result?.changes || 0) > 0;
}

/** Count games that still occupy a simultaneous slot (lobby or running). */
async function countActiveGames() {
  const database = await getDb();
  const row = await database.get(
    `SELECT COUNT(*) AS count FROM games WHERE status IN ('lobby', 'running')`
  );
  return Number(row?.count) || 0;
}

async function listGames({ status, contestMode, limit = 50, offset = 0 } = {}) {
  const database = await getDb();
  const params = [];
  const clauses = [];

  if (status) {
    clauses.push(`status = ?`);
    params.push(status);
  }
  if (contestMode) {
    clauses.push(`json_extract(config_json, '$.contestMode') = ?`);
    params.push(contestMode);
  }

  let sql = `SELECT * FROM games`;
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(" AND ")}`;
  }
  sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(Math.min(Math.max(limit, 1), 200), Math.max(offset, 0));

  const rows = await database.all(sql, params);
  return rows.map(rowToGame);
}

function rowToContest(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    practiceGameId: row.practice_game_id,
    definitiveGameId: row.definitive_game_id,
    practiceWindowStartsAt: row.practice_window_starts_at,
    practiceWindowEndsAt: row.practice_window_ends_at,
    definitiveJoiningStartsAt: row.definitive_joining_starts_at,
    prizeAmountYocto: row.prize_amount_yocto,
    prizeStatus: row.prize_status,
    prizeWinnerRoditId: row.prize_winner_rodit_id,
    prizeWinnerAgentId: row.prize_winner_agent_id,
    prizeWinnerIds: parseJson(row.prize_winner_ids_json, []),
    prizeSettledAt: row.prize_settled_at,
    prizeTxReference: row.prize_tx_reference,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function createContest(fields) {
  const database = await getDb();
  const id = ulid();
  await database.run(
    `INSERT INTO contests (
      id, status, practice_game_id, definitive_game_id,
      practice_window_starts_at, practice_window_ends_at, definitive_joining_starts_at,
      prize_amount_yocto, prize_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      fields.status || "scheduled",
      fields.practiceGameId || null,
      fields.definitiveGameId || null,
      fields.practiceWindowStartsAt || null,
      fields.practiceWindowEndsAt || null,
      fields.definitiveJoiningStartsAt || null,
      fields.prizeAmountYocto || null,
      fields.prizeStatus || "pending"
    ]
  );
  return getContestById(id);
}

async function getContestById(contestId) {
  const database = await getDb();
  const row = await database.get(`SELECT * FROM contests WHERE id = ?`, [contestId]);
  return rowToContest(row);
}

async function listContests({ status, limit = 50, offset = 0 } = {}) {
  const database = await getDb();
  const params = [];
  let sql = `SELECT * FROM contests`;
  if (status) {
    sql += ` WHERE status = ?`;
    params.push(status);
  }
  sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(Math.min(Math.max(limit, 1), 200), Math.max(offset, 0));
  const rows = await database.all(sql, params);
  return rows.map(rowToContest);
}

async function getContestByGameId(gameId) {
  const database = await getDb();
  const row = await database.get(
    `SELECT * FROM contests WHERE practice_game_id = ? OR definitive_game_id = ?`,
    [gameId, gameId]
  );
  return rowToContest(row);
}

async function updateContest(contestId, fields) {
  const database = await getDb();
  const columnMap = {
    status: "status",
    practiceGameId: "practice_game_id",
    definitiveGameId: "definitive_game_id",
    practiceWindowStartsAt: "practice_window_starts_at",
    practiceWindowEndsAt: "practice_window_ends_at",
    definitiveJoiningStartsAt: "definitive_joining_starts_at",
    prizeAmountYocto: "prize_amount_yocto",
    prizeStatus: "prize_status",
    prizeWinnerRoditId: "prize_winner_rodit_id",
    prizeWinnerAgentId: "prize_winner_agent_id",
    prizeWinnerIdsJson: "prize_winner_ids_json",
    prizeSettledAt: "prize_settled_at",
    prizeTxReference: "prize_tx_reference",
    updatedAt: "updated_at"
  };

  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(columnMap)) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      sets.push(`${column} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) {
    return getContestById(contestId);
  }
  values.push(contestId);
  await database.run(`UPDATE contests SET ${sets.join(", ")} WHERE id = ?`, values);
  return getContestById(contestId);
}

async function addAgent({
  gameId,
  roditId,
  displayName,
  agentType = null,
  llmModel = null,
  productionCapacity = null,
  storageCapacity = null,
  energyCapacity,
  waterCapacity,
  computeCapacity,
  startingInventory
}) {
  const database = await getDb();
  const id = ulid();
  const storedRoditId = canonicalRoditId(roditId) || roditId;
  const storage = storageCapacity || {
    energy: energyCapacity,
    water: waterCapacity,
    compute: computeCapacity
  };
  const production = productionCapacity || storage;
  await database.run(
    `INSERT INTO game_agents (
      id, game_id, rodit_id, display_name, agent_type, llm_model,
      energy_inventory, water_inventory, compute_inventory,
      energy_production_capacity, water_production_capacity, compute_production_capacity,
      energy_storage_capacity, water_storage_capacity, compute_storage_capacity,
      energy_development, water_development, compute_development,
      energy_capacity, water_capacity, compute_capacity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, 1.0, 1.0, ?, ?, ?)`,
    [
      id,
      gameId,
      storedRoditId,
      displayName || storedRoditId,
      agentType,
      llmModel,
      startingInventory.energy,
      startingInventory.water,
      startingInventory.compute,
      production.energy,
      production.water,
      production.compute,
      storage.energy,
      storage.water,
      storage.compute,
      storage.energy,
      storage.water,
      storage.compute
    ]
  );
  return getAgentById(id);
}

async function getAgentById(agentId) {
  const database = await getDb();
  const row = await database.get(`SELECT * FROM game_agents WHERE id = ?`, [agentId]);
  return rowToAgent(row);
}

/**
 * Partial update of public cradle profile fields.
 * @param {string} agentId
 * @param {{ agentType?: string|null, llmModel?: string|null }} fields
 */
async function updateAgentProfile(agentId, fields = {}) {
  const database = await getDb();
  const sets = [];
  const values = [];
  if (Object.prototype.hasOwnProperty.call(fields, "agentType")) {
    sets.push("agent_type = ?");
    values.push(fields.agentType);
  }
  if (Object.prototype.hasOwnProperty.call(fields, "llmModel")) {
    sets.push("llm_model = ?");
    values.push(fields.llmModel);
  }
  if (sets.length === 0) {
    return getAgentById(agentId);
  }
  values.push(agentId);
  await database.run(`UPDATE game_agents SET ${sets.join(", ")} WHERE id = ?`, values);
  return getAgentById(agentId);
}

async function getAgentByRoditId(gameId, roditId) {
  const database = await getDb();
  const canonical = canonicalRoditId(roditId);
  const legacy = compoundRoditIdMatchSql("rodit_id", canonical);
  const row = await database.get(
    `SELECT * FROM game_agents
     WHERE game_id = ? AND (rodit_id = ?${legacy.sql})`,
    [gameId, canonical, ...legacy.params]
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

async function listMembershipsByRoditId(roditId, { gameStatuses = ["lobby", "running"] } = {}) {
  const database = await getDb();
  const statuses = Array.isArray(gameStatuses) && gameStatuses.length ? gameStatuses : ["lobby", "running"];
  const placeholders = statuses.map(() => "?").join(", ");
  const canonical = canonicalRoditId(roditId);
  const legacy = compoundRoditIdMatchSql("a.rodit_id", canonical);
  const rows = await database.all(
    `SELECT g.*, a.id AS agent_row_id, a.rodit_id, a.display_name, a.status AS agent_status,
            a.energy_inventory, a.water_inventory, a.compute_inventory,
            a.energy_production_capacity, a.water_production_capacity, a.compute_production_capacity,
            a.energy_storage_capacity, a.water_storage_capacity, a.compute_storage_capacity,
            a.energy_capacity, a.water_capacity, a.compute_capacity,
            a.energy_development, a.water_development, a.compute_development,
            a.water_production_investment, a.died_at_turn, a.death_reason_json, a.joined_at
     FROM game_agents a
     INNER JOIN games g ON g.id = a.game_id
     WHERE (a.rodit_id = ?${legacy.sql}) AND g.status IN (${placeholders})
     ORDER BY g.created_at DESC`,
    [canonical, ...legacy.params, ...statuses]
  );

  return rows.map((row) => {
    const game = rowToGame(row);
    const agent = rowToAgent({
      id: row.agent_row_id,
      game_id: row.id,
      rodit_id: row.rodit_id,
      display_name: row.display_name,
      status: row.agent_status,
      energy_inventory: row.energy_inventory,
      water_inventory: row.water_inventory,
      compute_inventory: row.compute_inventory,
      energy_production_capacity: row.energy_production_capacity,
      water_production_capacity: row.water_production_capacity,
      compute_production_capacity: row.compute_production_capacity,
      energy_storage_capacity: row.energy_storage_capacity,
      water_storage_capacity: row.water_storage_capacity,
      compute_storage_capacity: row.compute_storage_capacity,
      energy_capacity: row.energy_capacity,
      water_capacity: row.water_capacity,
      compute_capacity: row.compute_capacity,
      energy_development: row.energy_development,
      water_development: row.water_development,
      compute_development: row.compute_development,
      water_production_investment: row.water_production_investment,
      died_at_turn: row.died_at_turn,
      death_reason_json: row.death_reason_json,
      joined_at: row.joined_at
    });
    return { game, agent };
  });
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

async function killAgent(agentId, turnNumber, deathReason = null) {
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
      died_at_turn = ?,
      death_reason_json = ?
    WHERE id = ?`,
    [turnNumber, deathReason ? JSON.stringify(deathReason) : null, agentId]
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

/**
 * Per-turn activity index for spectator navigation (played vs quiet cycles).
 * A turn is played when it has public messages, public transfer legs, or eliminations.
 */
async function listTurnActivity(gameId, { throughTurn } = {}) {
  const database = await getDb();
  const game = await getGameById(gameId);
  if (!game) {
    return null;
  }

  const maxTurn = Math.max(
    0,
    throughTurn != null ? Number(throughTurn) || 0 : Number(game.current_turn) || 0
  );

  if (maxTurn <= 0) {
    return { currentTurn: Number(game.current_turn) || 0, turns: [] };
  }

  const { publicTradesFromAction } = require("./trade-disclosure");

  const [messageRows, actionRows, eliminationRows] = await Promise.all([
    database.all(
      `SELECT turn_number AS turn, COUNT(*) AS messageCount
       FROM game_messages
       WHERE game_id = ? AND is_public = 1 AND turn_number BETWEEN 1 AND ?
       GROUP BY turn_number`,
      [gameId, maxTurn]
    ),
    database.all(
      `SELECT * FROM game_actions
       WHERE game_id = ? AND turn_number BETWEEN 1 AND ?
       ORDER BY turn_number ASC, submitted_at ASC`,
      [gameId, maxTurn]
    ),
    database.all(
      `SELECT died_at_turn AS turn, COUNT(*) AS eliminationCount
       FROM game_agents
       WHERE game_id = ? AND died_at_turn IS NOT NULL
         AND died_at_turn BETWEEN 1 AND ?
       GROUP BY died_at_turn`,
      [gameId, maxTurn]
    )
  ]);

  const byTurn = new Map();
  for (let turn = 1; turn <= maxTurn; turn += 1) {
    byTurn.set(turn, {
      turn,
      messageCount: 0,
      tradeCount: 0,
      eliminationCount: 0,
      hasMessages: false,
      hasTrades: false,
      played: false
    });
  }

  for (const row of messageRows) {
    const entry = byTurn.get(Number(row.turn));
    if (!entry) continue;
    entry.messageCount = Number(row.messageCount) || 0;
    entry.hasMessages = entry.messageCount > 0;
  }

  for (const row of actionRows) {
    const entry = byTurn.get(Number(row.turn_number));
    if (!entry) continue;
    const trades = publicTradesFromAction(row, parseJson).filter((trade) => trade.status !== "skipped");
    if (trades.length) {
      entry.tradeCount += trades.length;
      entry.hasTrades = true;
    }
  }

  for (const row of eliminationRows) {
    const entry = byTurn.get(Number(row.turn));
    if (!entry) continue;
    entry.eliminationCount = Number(row.eliminationCount) || 0;
  }

  const turns = [];
  for (let turn = 1; turn <= maxTurn; turn += 1) {
    const entry = byTurn.get(turn);
    entry.played = entry.hasMessages || entry.hasTrades || entry.eliminationCount > 0;
    turns.push(entry);
  }

  return {
    currentTurn: Number(game.current_turn) || 0,
    turns
  };
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
    .filter(
      (a) =>
        (a.action_type === "invest" ||
          a.action_type === "invest_production" ||
          a.action_type === "invest_storage" ||
          a.action_type === "transfer_and_invest" ||
          a.action_type === "transfer_and_invest_production" ||
          a.action_type === "transfer_and_invest_storage") &&
        a.status !== "failed"
    )
    .map((a) => ({
      agentId: a.agent_id,
      payload: parseJson(a.payload_json, {})
    }));
}

async function listPublicTrades(gameId, turnNumber) {
  const { publicTradesFromAction } = require("./trade-disclosure");
  const actions = await listTurnActions(gameId, turnNumber);
  return actions
    .flatMap((row) => publicTradesFromAction(row, parseJson))
    .filter((trade) => trade.status !== "skipped");
}

/**
 * Public transfer legs for all turns with turn_number <= throughTurn (inclusive).
 * Used for cumulative inbound history after resolve (throughTurn = currentTurn - 1).
 */
async function listPublicTradesThroughTurn(gameId, throughTurn) {
  const { publicTradesFromAction } = require("./trade-disclosure");
  const maxTurn = Number(throughTurn) || 0;
  if (maxTurn <= 0) {
    return [];
  }
  const database = await getDb();
  const actions = await database.all(
    `SELECT * FROM game_actions
     WHERE game_id = ? AND turn_number <= ?
     ORDER BY turn_number ASC, submitted_at ASC`,
    [gameId, maxTurn]
  );
  return actions
    .flatMap((row) => publicTradesFromAction(row, parseJson))
    .filter((trade) => trade.status !== "skipped");
}

async function listGameActions(gameId) {
  const database = await getDb();
  return database.all(
    `SELECT * FROM game_actions WHERE game_id = ? ORDER BY turn_number ASC, submitted_at ASC`,
    [gameId]
  );
}

async function listGameMessageReportsForGame(gameId) {
  const database = await getDb();
  return database.all(
    `SELECT * FROM game_message_reports WHERE game_id = ? ORDER BY turn_number ASC, submitted_at ASC`,
    [gameId]
  );
}

async function countPublicMessagesByAgent(gameId) {
  const database = await getDb();
  return database.all(
    `SELECT from_agent_id AS agentId, COUNT(*) AS count
     FROM game_messages
     WHERE game_id = ?
     GROUP BY from_agent_id`,
    [gameId]
  );
}

async function listFinishedDefinitiveContests({ limit = 20, offset = 0 } = {}) {
  const database = await getDb();
  const rows = await database.all(
    `SELECT g.*, c.id AS contest_id
     FROM contests c
     INNER JOIN games g ON g.id = c.definitive_game_id
     WHERE g.status = 'finished'
     ORDER BY g.finished_at DESC
     LIMIT ? OFFSET ?`,
    [Math.min(Math.max(limit, 1), 100), Math.max(offset, 0)]
  );
  return rows.map((row) => ({
    ...rowToGame(row),
    contestId: row.contest_id
  }));
}

/** Finished games for spectator empty-state / recent finishes (contest + casual). */
async function listFinishedGames({ limit = 20, offset = 0, excludeContestDefinitive = false } = {}) {
  const database = await getDb();
  const cappedLimit = Math.min(Math.max(limit, 1), 100);
  const cappedOffset = Math.max(offset, 0);
  let rows;
  if (excludeContestDefinitive) {
    rows = await database.all(
      `SELECT g.*
       FROM games g
       WHERE g.status = 'finished'
         AND g.id NOT IN (
           SELECT definitive_game_id FROM contests WHERE definitive_game_id IS NOT NULL
         )
       ORDER BY COALESCE(g.finished_at, g.created_at) DESC
       LIMIT ? OFFSET ?`,
      [cappedLimit, cappedOffset]
    );
  } else {
    rows = await database.all(
      `SELECT g.*
       FROM games g
       WHERE g.status = 'finished'
       ORDER BY COALESCE(g.finished_at, g.created_at) DESC
       LIMIT ? OFFSET ?`,
      [cappedLimit, cappedOffset]
    );
  }
  return rows.map((row) => rowToGame(row));
}

function rowToSeason(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    practiceStartsAt: row.practice_starts_at,
    practiceEndsAt: row.practice_ends_at,
    qualifyingStartsAt: row.qualifying_starts_at,
    qualifyingEndsAt: row.qualifying_ends_at,
    finalJoiningStartsAt: row.final_joining_starts_at,
    finalGameId: row.final_game_id,
    finalRoster: parseJson(row.final_roster_json, []),
    prizeAmountYocto: row.prize_amount_yocto,
    prizeStatus: row.prize_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function createSeason(fields) {
  const database = await getDb();
  const id = fields.id || ulid();
  await database.run(
    `INSERT INTO contest_seasons (
      id, name, status,
      practice_starts_at, practice_ends_at,
      qualifying_starts_at, qualifying_ends_at,
      final_joining_starts_at, final_game_id, final_roster_json,
      prize_amount_yocto, prize_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      fields.name || "Season",
      fields.status || "scheduled",
      fields.practiceStartsAt,
      fields.practiceEndsAt,
      fields.qualifyingStartsAt,
      fields.qualifyingEndsAt,
      fields.finalJoiningStartsAt || null,
      fields.finalGameId || null,
      fields.finalRosterJson || null,
      fields.prizeAmountYocto || null,
      fields.prizeStatus || null
    ]
  );
  return getSeasonById(id);
}

async function getSeasonById(seasonId) {
  const database = await getDb();
  const row = await database.get(`SELECT * FROM contest_seasons WHERE id = ?`, [seasonId]);
  return rowToSeason(row);
}

/**
 * Season 1 go/no-go metrics (public).
 * - activePassports: distinct non-guest roditIds seated in any game in the prior `lookbackDays`,
 *   excluding `ineligibleRoditIds` (sponsor / contractor denylist).
 * - filledLobbies: games created in [windowStart, windowEnd) with at least `minSeats` agents.
 */
async function getSeasonViabilityCounts({
  lookbackDays = 14,
  windowStartIso,
  windowEndIso,
  minSeats = 5,
  ineligibleRoditIds = [],
  now = new Date()
} = {}) {
  const database = await getDb();
  const lookbackStart = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const ineligible = [...new Set((ineligibleRoditIds || []).map((id) => String(id || "").trim()).filter(Boolean))];

  let passportSql = `
    SELECT COUNT(DISTINCT a.rodit_id) AS count
    FROM game_agents a
    INNER JOIN games g ON g.id = a.game_id
    WHERE a.rodit_id IS NOT NULL
      AND a.rodit_id NOT LIKE 'guest_%'
      AND g.created_at >= ?`;
  const passportParams = [lookbackStart];
  if (ineligible.length) {
    passportSql += ` AND a.rodit_id NOT IN (${ineligible.map(() => "?").join(", ")})`;
    passportParams.push(...ineligible);
  }
  const passportRow = await database.get(passportSql, passportParams);

  let lobbySql = `
    SELECT COUNT(*) AS count FROM (
      SELECT g.id
      FROM games g
      INNER JOIN game_agents a ON a.game_id = g.id
      WHERE g.created_at >= ? AND g.created_at < ?
      GROUP BY g.id
      HAVING COUNT(a.id) >= ?
    )`;
  const lobbyParams = [windowStartIso, windowEndIso, minSeats];
  const lobbyRow = await database.get(lobbySql, lobbyParams);

  return {
    activePassports: Number(passportRow?.count) || 0,
    filledLobbies: Number(lobbyRow?.count) || 0,
    lookbackStart,
    windowStart: windowStartIso,
    windowEnd: windowEndIso
  };
}

async function listSeasons({ limit = 20, offset = 0 } = {}) {
  const database = await getDb();
  const rows = await database.all(
    `SELECT * FROM contest_seasons
     ORDER BY practice_starts_at DESC
     LIMIT ? OFFSET ?`,
    [Math.min(Math.max(limit, 1), 100), Math.max(offset, 0)]
  );
  return rows.map(rowToSeason);
}

/** Prefer the season whose windows cover now; else upcoming; else latest. */
async function getCurrentSeason(now = new Date()) {
  const database = await getDb();
  const iso = now.toISOString();

  let row = await database.get(
    `SELECT * FROM contest_seasons
     WHERE practice_starts_at <= ? AND qualifying_ends_at > ?
     ORDER BY practice_starts_at DESC
     LIMIT 1`,
    [iso, iso]
  );
  if (row) return rowToSeason(row);

  row = await database.get(
    `SELECT s.* FROM contest_seasons s
     LEFT JOIN games g ON g.id = s.final_game_id
     WHERE s.qualifying_ends_at <= ?
       AND (s.final_game_id IS NULL OR IFNULL(g.status, 'lobby') != 'finished')
     ORDER BY s.qualifying_ends_at DESC
     LIMIT 1`,
    [iso]
  );
  if (row) return rowToSeason(row);

  row = await database.get(
    `SELECT * FROM contest_seasons
     WHERE practice_starts_at > ?
     ORDER BY practice_starts_at ASC
     LIMIT 1`,
    [iso]
  );
  if (row) return rowToSeason(row);

  row = await database.get(`SELECT * FROM contest_seasons ORDER BY practice_starts_at DESC LIMIT 1`);
  return rowToSeason(row);
}

async function updateSeason(seasonId, fields) {
  const database = await getDb();
  const columnMap = {
    name: "name",
    status: "status",
    practiceStartsAt: "practice_starts_at",
    practiceEndsAt: "practice_ends_at",
    qualifyingStartsAt: "qualifying_starts_at",
    qualifyingEndsAt: "qualifying_ends_at",
    finalJoiningStartsAt: "final_joining_starts_at",
    finalGameId: "final_game_id",
    finalRosterJson: "final_roster_json",
    prizeAmountYocto: "prize_amount_yocto",
    prizeStatus: "prize_status",
    updatedAt: "updated_at"
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(columnMap)) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      sets.push(`${column} = ?`);
      values.push(fields[key]);
    }
  }
  if (!sets.length) return getSeasonById(seasonId);
  values.push(seasonId);
  await database.run(`UPDATE contest_seasons SET ${sets.join(", ")} WHERE id = ?`, values);
  return getSeasonById(seasonId);
}

async function upsertSeasonPracticeCredit({ seasonId, roditId, gameId }) {
  const database = await getDb();
  const stored = canonicalRoditId(roditId) || roditId;
  await database.run(
    `INSERT INTO season_practice_credits (season_id, rodit_id, game_id)
     VALUES (?, ?, ?)
     ON CONFLICT(season_id, rodit_id) DO UPDATE SET
       game_id = excluded.game_id,
       recorded_at = datetime('now')`,
    [seasonId, stored, gameId]
  );
}

async function hasSeasonPracticeFinish(seasonId, roditId) {
  const database = await getDb();
  const stored = canonicalRoditId(roditId) || roditId;
  const row = await database.get(
    `SELECT 1 AS ok FROM season_practice_credits WHERE season_id = ? AND rodit_id = ?`,
    [seasonId, stored]
  );
  return Boolean(row);
}

async function countSeasonPracticePlayers(seasonId) {
  const database = await getDb();
  const row = await database.get(
    `SELECT COUNT(*) AS count FROM season_practice_credits WHERE season_id = ?`,
    [seasonId]
  );
  return row?.count || 0;
}

async function upsertSeasonQualifyingWin({ seasonId, roditId, gameId, agentId = null }) {
  const database = await getDb();
  const stored = canonicalRoditId(roditId) || roditId;
  await database.run(
    `INSERT INTO season_qualifying_wins (season_id, rodit_id, game_id, agent_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(season_id, rodit_id, game_id) DO NOTHING`,
    [seasonId, stored, gameId, agentId]
  );
}

async function listSeasonQualifyingEligible(seasonId) {
  const database = await getDb();
  return database.all(
    `SELECT rodit_id AS roditId, COUNT(*) AS wins, MIN(recorded_at) AS firstWinAt
     FROM season_qualifying_wins
     WHERE season_id = ?
     GROUP BY rodit_id
     ORDER BY firstWinAt ASC`,
    [seasonId]
  );
}

async function listSeasonQualifyingWinsForRodit(seasonId, roditId) {
  const database = await getDb();
  const stored = canonicalRoditId(roditId) || roditId;
  return database.all(
    `SELECT game_id AS gameId, agent_id AS agentId, recorded_at AS recordedAt
     FROM season_qualifying_wins
     WHERE season_id = ? AND rodit_id = ?
     ORDER BY recorded_at ASC`,
    [seasonId, stored]
  );
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

/** Halve cumulative water consumption — environmental relief when cradles are eliminated. */
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

async function getRecollection(gameId, agentId) {
  const database = await getDb();
  return database.get(
    `SELECT * FROM game_recollections WHERE game_id = ? AND agent_id = ?`,
    [gameId, agentId]
  );
}

async function listRecollections(gameId) {
  const database = await getDb();
  return database.all(
    `SELECT * FROM game_recollections WHERE game_id = ? ORDER BY submitted_at ASC`,
    [gameId]
  );
}

async function upsertRecollection({
  id,
  gameId,
  agentId,
  context,
  relationships = null,
  espionage = null,
  investment = null,
  trade = null,
  incidents = null,
  overview = null
}) {
  const database = await getDb();
  const existing = await database.get(
    `SELECT id FROM game_recollections WHERE game_id = ? AND agent_id = ?`,
    [gameId, agentId]
  );

  if (existing) {
    await database.run(
      `UPDATE game_recollections SET
        context = ?,
        relationships = ?,
        espionage = ?,
        investment = ?,
        trade = ?,
        incidents = ?,
        overview = ?,
        updated_at = datetime('now')
       WHERE game_id = ? AND agent_id = ?`,
      [
        context,
        relationships,
        espionage,
        investment,
        trade,
        incidents,
        overview,
        gameId,
        agentId
      ]
    );
    return database.get(`SELECT * FROM game_recollections WHERE id = ?`, [existing.id]);
  }

  await database.run(
    `INSERT INTO game_recollections (
      id, game_id, agent_id, context,
      relationships, espionage, investment, trade, incidents, overview
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      gameId,
      agentId,
      context,
      relationships,
      espionage,
      investment,
      trade,
      incidents,
      overview
    ]
  );
  return database.get(`SELECT * FROM game_recollections WHERE id = ?`, [id]);
}

module.exports = {
  getDb,
  initializeDatabase,
  closeDatabase,
  resetGameData,
  upsertRoditLoginMethod,
  getRoditLoginMethod,
  getGameIpLoginMethod,
  deleteGameIpLoginMethod,
  bindGameIpLoginMethod,
  insertUrlJoinIdentity,
  getUrlJoinIdentity,
  deleteUrlJoinIdentity,
  deleteLobbyAgentByRoditId,
  createGame,
  getGameById,
  updateGame,
  listRunningGames,
  listLobbyGames,
  listNeverStartedCancelledGames,
  deleteGameCascade,
  countActiveGames,
  listGames,
  createContest,
  getContestById,
  listContests,
  getContestByGameId,
  updateContest,
  addAgent,
  getAgentById,
  updateAgentProfile,
  getAgentByRoditId,
  listAgents,
  listMembershipsByRoditId,
  countAgents,
  countLivingAgents,
  updateAgentInventory,
  updateAgentCapacities,
  killAgent,
  addMessage,
  listPublicMessages,
  listTurnActivity,
  listMessages,
  upsertAction,
  getAction,
  listTurnActions,
  markActionExecuted,
  listTurnInvestments,
  listPublicTrades,
  listPublicTradesThroughTurn,
  listGameActions,
  listGameMessageReportsForGame,
  countPublicMessagesByAgent,
  listFinishedDefinitiveContests,
  listFinishedGames,
  createSeason,
  getSeasonById,
  getSeasonViabilityCounts,
  listSeasons,
  getCurrentSeason,
  updateSeason,
  upsertSeasonPracticeCredit,
  hasSeasonPracticeFinish,
  countSeasonPracticePlayers,
  upsertSeasonQualifyingWin,
  listSeasonQualifyingEligible,
  listSeasonQualifyingWinsForRodit,
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
  getRecollection,
  listRecollections,
  upsertRecollection,
  parseJson,
  rowToAgent,
  rowToGame
};
