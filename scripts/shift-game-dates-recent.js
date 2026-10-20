#!/usr/bin/env node
/**
 * Shift game chronology so finished games land on recent calendar days.
 *
 * Each game keeps its internal relative timing (durations, FIFO order).
 * Games are packed one-per-day ending at "now", oldest → newest.
 * Season windows get the same delta as the newest game (durations preserved).
 *
 * Usage:
 *   API_DEFAULT_OPTIONS_DB_PATH=/path/to/database.sqlite \
 *     node scripts/shift-game-dates-recent.js [--dry-run]
 *
 * Prefer stopping writers (API container) before applying.
 */

const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");

const DB_PATH =
  process.env.API_DEFAULT_OPTIONS_DB_PATH ||
  process.env.DB_PATH ||
  path.join(__dirname, "..", "data", "database.sqlite");

const DRY_RUN = process.argv.includes("--dry-run");

/** Parse mixed ISO / SQLite datetime TEXT → Date, or null. */
function parseTs(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (!s) return null;
  // SQLite datetime('now'): "YYYY-MM-DD HH:MM:SS" (UTC)
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s.replace(" ", "T") + "Z");
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Rewrite timestamp preserving original string shape when possible. */
function formatTs(original, date) {
  const s = String(original).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    const iso = date.toISOString(); // ...Z
    return iso.slice(0, 19).replace("T", " ");
  }
  return date.toISOString();
}

function shiftValue(original, deltaMs) {
  if (original == null || original === "") return original;
  const d = parseTs(original);
  if (!d) return original;
  return formatTs(original, new Date(d.getTime() + deltaMs));
}

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function updateRowColumns(db, table, idCol, id, columns, deltaMs) {
  const sets = [];
  const params = [];
  for (const [col, oldVal] of Object.entries(columns)) {
    if (oldVal == null || oldVal === "") continue;
    const next = shiftValue(oldVal, deltaMs);
    if (next === oldVal) continue;
    sets.push(`${col} = ?`);
    params.push(next);
  }
  if (!sets.length) return 0;
  params.push(id);
  if (!DRY_RUN) {
    await db.run(`UPDATE ${table} SET ${sets.join(", ")} WHERE ${idCol} = ?`, params);
  }
  return 1;
}

async function shiftByGameId(db, table, cols, gameId, deltaMs) {
  const colList = cols.join(", ");
  const rows = await db.all(`SELECT rowid AS _rid, ${colList} FROM ${table} WHERE game_id = ?`, [
    gameId
  ]);
  let n = 0;
  for (const row of rows) {
    const columns = {};
    for (const c of cols) columns[c] = row[c];
    n += await updateRowColumns(db, table, "rowid", row._rid, columns, deltaMs);
  }
  return n;
}

async function main() {
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  console.log("DB:", DB_PATH);
  console.log(DRY_RUN ? "Mode: DRY-RUN (no writes)" : "Mode: APPLY");

  const games = await db.all(
    `SELECT id, status, created_at, started_at, finished_at,
            joining_window_starts_at, joining_window_ends_at,
            negotiation_ends_at, message_report_ends_at, execution_ends_at, ends_at
     FROM games
     ORDER BY COALESCE(finished_at, started_at, created_at) ASC`
  );

  if (!games.length) {
    console.log("No games found; nothing to do.");
    await db.close();
    return;
  }

  const now = new Date();
  const today = startOfUtcDay(now);
  // Place games on consecutive UTC days ending today (oldest first).
  const plan = games.map((g, i) => {
    const anchor = parseTs(g.created_at) || parseTs(g.started_at) || parseTs(g.finished_at);
    if (!anchor) throw new Error(`Game ${g.id} has no parseable anchor timestamp`);
    const dayOffset = games.length - 1 - i; // newest → today
    const targetDay = new Date(today.getTime() - dayOffset * 86400000);
    // Keep time-of-day from original created_at
    const targetAnchor = new Date(
      Date.UTC(
        targetDay.getUTCFullYear(),
        targetDay.getUTCMonth(),
        targetDay.getUTCDate(),
        anchor.getUTCHours(),
        anchor.getUTCMinutes(),
        anchor.getUTCSeconds(),
        anchor.getUTCMilliseconds()
      )
    );
    const deltaMs = targetAnchor.getTime() - anchor.getTime();
    return { game: g, deltaMs, targetAnchor };
  });

  console.log("\nPer-game plan:");
  for (const { game: g, deltaMs, targetAnchor } of plan) {
    const days = (deltaMs / 86400000).toFixed(2);
    console.log(
      `  ${g.id.slice(0, 10)}…  ${g.created_at}  →  ${targetAnchor.toISOString()}  (Δ ${days}d)`
    );
  }

  const newestDelta = plan[plan.length - 1].deltaMs;

  if (!DRY_RUN) await db.exec("BEGIN IMMEDIATE");

  try {
    let touched = 0;
    for (const { game: g, deltaMs } of plan) {
      const gameCols = {
        created_at: g.created_at,
        started_at: g.started_at,
        finished_at: g.finished_at,
        joining_window_starts_at: g.joining_window_starts_at,
        joining_window_ends_at: g.joining_window_ends_at,
        negotiation_ends_at: g.negotiation_ends_at,
        message_report_ends_at: g.message_report_ends_at,
        execution_ends_at: g.execution_ends_at,
        ends_at: g.ends_at
      };
      touched += await updateRowColumns(db, "games", "id", g.id, gameCols, deltaMs);
      touched += await shiftByGameId(db, "game_agents", ["joined_at"], g.id, deltaMs);
      touched += await shiftByGameId(db, "game_messages", ["created_at"], g.id, deltaMs);
      touched += await shiftByGameId(
        db,
        "game_actions",
        ["submitted_at", "executed_at"],
        g.id,
        deltaMs
      );
      touched += await shiftByGameId(
        db,
        "game_message_reports",
        ["submitted_at"],
        g.id,
        deltaMs
      );
      touched += await shiftByGameId(
        db,
        "game_recollections",
        ["submitted_at", "updated_at"],
        g.id,
        deltaMs
      );
      touched += await shiftByGameId(
        db,
        "game_ip_login_methods",
        ["created_at"],
        g.id,
        deltaMs
      );
      touched += await shiftByGameId(db, "ranking_events", ["created_at"], g.id, deltaMs);
    }

    // Ranking rows keyed by rodit (not game): shift last_played / updated with newest delta
    const rankings = await db.all(
      `SELECT rodit_id, last_played_at, updated_at FROM agent_ranking`
    );
    for (const r of rankings) {
      touched += await updateRowColumns(
        db,
        "agent_ranking",
        "rodit_id",
        r.rodit_id,
        { last_played_at: r.last_played_at, updated_at: r.updated_at },
        newestDelta
      );
    }

    // Contests (legacy)
    const contests = await db.all(
      `SELECT id, practice_window_starts_at, practice_window_ends_at,
              definitive_joining_starts_at, prize_settled_at, created_at, updated_at
       FROM contests`
    );
    for (const c of contests) {
      touched += await updateRowColumns(
        db,
        "contests",
        "id",
        c.id,
        {
          practice_window_starts_at: c.practice_window_starts_at,
          practice_window_ends_at: c.practice_window_ends_at,
          definitive_joining_starts_at: c.definitive_joining_starts_at,
          prize_settled_at: c.prize_settled_at,
          created_at: c.created_at,
          updated_at: c.updated_at
        },
        newestDelta
      );
    }

    // Seasons: same delta as newest game so relative schedule stays coherent
    const seasons = await db.all(
      `SELECT id, practice_starts_at, practice_ends_at, qualifying_starts_at,
              qualifying_ends_at, final_joining_starts_at, created_at, updated_at
       FROM contest_seasons`
    );
    for (const s of seasons) {
      const before = {
        practice_starts_at: s.practice_starts_at,
        practice_ends_at: s.practice_ends_at,
        qualifying_starts_at: s.qualifying_starts_at,
        qualifying_ends_at: s.qualifying_ends_at,
        final_joining_starts_at: s.final_joining_starts_at
      };
      touched += await updateRowColumns(
        db,
        "contest_seasons",
        "id",
        s.id,
        { ...before, created_at: s.created_at, updated_at: s.updated_at },
        newestDelta
      );
      console.log("\nSeason shift (newest-game Δ):");
      for (const [k, v] of Object.entries(before)) {
        console.log(`  ${k}: ${v} → ${shiftValue(v, newestDelta)}`);
      }
    }

    // Season credit/win recordings
    for (const table of ["season_practice_credits", "season_qualifying_wins"]) {
      const rows = await db.all(`SELECT rowid AS _rid, recorded_at FROM ${table}`);
      for (const row of rows) {
        touched += await updateRowColumns(
          db,
          table,
          "rowid",
          row._rid,
          { recorded_at: row.recorded_at },
          newestDelta
        );
      }
    }

    // Ranking snapshots: drop so the app regenerates the current week cleanly
    const snapCount = await db.get(`SELECT COUNT(*) AS n FROM ranking_snapshots`);
    if (snapCount.n > 0) {
      console.log(`\nDeleting ${snapCount.n} ranking_snapshots (will regenerate on restart)`);
      if (!DRY_RUN) await db.run(`DELETE FROM ranking_snapshots`);
    }

    if (!DRY_RUN) await db.exec("COMMIT");

    const after = await db.all(
      `SELECT id, created_at, started_at, finished_at
       FROM games
       ORDER BY COALESCE(finished_at, created_at) ASC`
    );
    console.log("\nGames after:");
    for (const g of after) {
      console.log(`  ${g.created_at}  …  ${g.finished_at || "-"}  (${g.id.slice(0, 12)}…)`);
    }
    console.log(`\nDone. Rows touched (approx updates): ${touched}`);
  } catch (err) {
    if (!DRY_RUN) {
      try {
        await db.exec("ROLLBACK");
      } catch (_) {
        /* ignore */
      }
    }
    throw err;
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
