#!/usr/bin/env node
/**
 * Add always-on ranking tables to an existing SQLite game DB.
 * Contest/season tables are left in place (soft-remove / historical).
 *
 * Usage:
 *   API_DEFAULT_OPTIONS_DB_PATH=/path/to/database.sqlite node scripts/migrate-always-on-ranking.js
 *
 * Inside the production container:
 *   podman exec -i slcbackend-container node -e "$(cat scripts/migrate-always-on-ranking.js)"
 * or copy this file and run with the container DB path `/app/data/database.sqlite`.
 */

const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");

const DB_PATH =
  process.env.API_DEFAULT_OPTIONS_DB_PATH ||
  process.env.DB_PATH ||
  path.join(__dirname, "..", "data", "database.sqlite");

async function main() {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS agent_ranking (
      rodit_id TEXT PRIMARY KEY,
      rating REAL NOT NULL DEFAULT 1000,
      games_played INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      placement_points INTEGER NOT NULL DEFAULT 0,
      last_played_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_ranking_rating ON agent_ranking(rating DESC, wins DESC);

    CREATE TABLE IF NOT EXISTS ranking_events (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      rodit_id TEXT NOT NULL,
      result TEXT NOT NULL,
      delta REAL NOT NULL,
      placement_points INTEGER NOT NULL DEFAULT 0,
      is_win INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (game_id) REFERENCES games(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ranking_events_game ON ranking_events(game_id);
    CREATE INDEX IF NOT EXISTS idx_ranking_events_rodit ON ranking_events(rodit_id);

    CREATE TABLE IF NOT EXISTS ranking_snapshots (
      week_key TEXT PRIMARY KEY,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      entries_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ranking_snapshots_generated ON ranking_snapshots(generated_at DESC);

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO schema_migrations (id) VALUES ('always_on_ranking_v1');
  `);

  const tables = await db.all(
    `SELECT name FROM sqlite_master
     WHERE type='table' AND name IN ('agent_ranking','ranking_events','ranking_snapshots')
     ORDER BY name`
  );
  const mig = await db.get(
    `SELECT id, applied_at FROM schema_migrations WHERE id = 'always_on_ranking_v1'`
  );
  console.log("DB:", DB_PATH);
  console.log("ranking tables:", tables.map((t) => t.name).join(", "));
  console.log("migration:", mig);
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
