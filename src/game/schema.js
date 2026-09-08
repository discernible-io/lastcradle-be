/**
 * SQLite schema for the survival game engine.
 */

const GAME_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'lobby',
  current_turn INTEGER NOT NULL DEFAULT 0,
  phase TEXT,
  config_json TEXT NOT NULL,
  negotiation_ends_at TEXT,
  message_report_ends_at TEXT,
  execution_ends_at TEXT,
  ends_at TEXT,
  joining_window_starts_at TEXT,
  joining_window_ends_at TEXT,
  turn_growth_json TEXT,
  winner_ids_json TEXT,
  aggregate_water_consumed REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS game_agents (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  rodit_id TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'alive',
  energy_inventory REAL NOT NULL DEFAULT 0,
  water_inventory REAL NOT NULL DEFAULT 0,
  compute_inventory REAL NOT NULL DEFAULT 0,
  energy_production_capacity REAL NOT NULL DEFAULT 0,
  water_production_capacity REAL NOT NULL DEFAULT 0,
  compute_production_capacity REAL NOT NULL DEFAULT 0,
  energy_storage_capacity REAL NOT NULL DEFAULT 0,
  water_storage_capacity REAL NOT NULL DEFAULT 0,
  compute_storage_capacity REAL NOT NULL DEFAULT 0,
  energy_development REAL NOT NULL DEFAULT 1.0,
  water_development REAL NOT NULL DEFAULT 1.0,
  compute_development REAL NOT NULL DEFAULT 1.0,
  energy_capacity REAL NOT NULL DEFAULT 0,
  water_capacity REAL NOT NULL DEFAULT 0,
  compute_capacity REAL NOT NULL DEFAULT 0,
  water_production_investment REAL NOT NULL DEFAULT 0,
  died_at_turn INTEGER,
  death_reason_json TEXT,
  agent_type TEXT,
  llm_model TEXT,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (game_id) REFERENCES games(id),
  UNIQUE (game_id, rodit_id)
);

CREATE TABLE IF NOT EXISTS game_messages (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT,
  body TEXT NOT NULL,
  compute_cost REAL NOT NULL DEFAULT 0,
  is_public INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (from_agent_id) REFERENCES game_agents(id)
);

CREATE TABLE IF NOT EXISTS game_actions (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  executed_at TEXT,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (agent_id) REFERENCES game_agents(id),
  UNIQUE (game_id, turn_number, agent_id)
);

CREATE TABLE IF NOT EXISTS game_message_reports (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  reported_sent INTEGER NOT NULL,
  reported_received INTEGER NOT NULL,
  actual_sent INTEGER,
  actual_received INTEGER,
  mismatch INTEGER NOT NULL DEFAULT 0,
  energy_survival_penalty REAL NOT NULL DEFAULT 0,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (agent_id) REFERENCES game_agents(id),
  UNIQUE (game_id, turn_number, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_game_message_reports_turn ON game_message_reports(game_id, turn_number);
CREATE INDEX IF NOT EXISTS idx_game_messages_game_turn ON game_messages(game_id, turn_number);
CREATE INDEX IF NOT EXISTS idx_game_actions_game_turn ON game_actions(game_id, turn_number);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);

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
CREATE INDEX IF NOT EXISTS idx_games_contest_mode ON games(status, created_at);

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
`;

module.exports = { GAME_TABLES_SQL };
