/**
 * Always-on global agent ranking: every finished game updates the ladder;
 * weekly snapshots freeze the leaderboard at ISO week boundaries.
 */

const { RoditClient } = require("@rodit/rodit-auth-be");
const repo = require("./repository");

const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();

const DEFAULT_RATING = 1000;
const PARTICIPATION_DELTA = 5;
const WIN_DELTA = 25;
const PLACEMENT_DELTAS = [10, 6, 3]; // 1st / 2nd / 3rd by holdings among finishers
const SNAPSHOT_CHECK_INTERVAL_MS = 60 * 60 * 1000;

let snapshotTimer = null;

function inventoryTotal(inv) {
  return (inv?.energy ?? 0) + (inv?.water ?? 0) + (inv?.compute ?? 0);
}

/** ISO week key: YYYY-Www (UTC). */
function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function isoWeekBounds(weekKey) {
  const match = /^(\d{4})-W(\d{2})$/.exec(String(weekKey || ""));
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  // ISO week: Thursday of week W determines the year; Monday is start.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const mondayWeek1 = new Date(jan4);
  mondayWeek1.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const periodStart = new Date(mondayWeek1);
  periodStart.setUTCDate(mondayWeek1.getUTCDate() + (week - 1) * 7);
  const periodEnd = new Date(periodStart);
  periodEnd.setUTCDate(periodStart.getUTCDate() + 7);
  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString()
  };
}

function publicRankingRow(row, rank = null) {
  if (!row) return null;
  return {
    rank,
    roditId: row.roditId,
    rating: row.rating,
    gamesPlayed: row.gamesPlayed,
    wins: row.wins,
    placementPoints: row.placementPoints,
    lastPlayedAt: row.lastPlayedAt,
    updatedAt: row.updatedAt,
    isGuest: String(row.roditId || "").startsWith("guest_")
  };
}

/**
 * Record ranking deltas for every agent in a finished game.
 * Idempotent per gameId (skips if ranking_events already exist for that game).
 */
async function recordFinishedGame(game) {
  if (!game || game.status !== "finished") {
    return { recorded: false, reason: "not_finished" };
  }

  const existing = await repo.countRankingEventsForGame(game.id);
  if (existing > 0) {
    return { recorded: false, reason: "already_recorded" };
  }

  const agents = await repo.listAgents(game.id);
  if (!agents.length) {
    return { recorded: false, reason: "no_agents" };
  }

  const winnerIds = new Set(game.winnerIds || []);
  const survivors = agents
    .filter((a) => a.status === "alive")
    .map((a) => ({
      ...a,
      holdings: inventoryTotal(a.inventory)
    }))
    .sort((a, b) => b.holdings - a.holdings);

  const placementByAgentId = new Map();
  survivors.forEach((a, idx) => {
    if (idx < PLACEMENT_DELTAS.length) {
      placementByAgentId.set(a.id, PLACEMENT_DELTAS[idx]);
    }
  });

  const now = new Date().toISOString();
  const events = [];

  for (const agent of agents) {
    const roditId = agent.rodit_id || agent.roditId;
    if (!roditId) continue;

    const isWinner = winnerIds.has(agent.id);
    const placement = placementByAgentId.get(agent.id) || 0;
    let delta = PARTICIPATION_DELTA;
    if (isWinner) delta += WIN_DELTA;
    delta += placement;

    const result = isWinner ? "win" : agent.status === "alive" ? "survive" : "eliminated";

    events.push({
      gameId: game.id,
      roditId,
      result,
      delta,
      placementPoints: placement,
      isWin: isWinner ? 1 : 0
    });

    await repo.upsertAgentRankingDelta({
      roditId,
      delta,
      winIncrement: isWinner ? 1 : 0,
      placementPoints: placement,
      lastPlayedAt: game.finished_at || now
    });
  }

  await repo.insertRankingEvents(events);

  logger.infoWithContext("Ranking updated for finished game", {
    component: "GameRanking",
    gameId: game.id,
    agents: events.length,
    winners: winnerIds.size
  });

  return { recorded: true, events: events.length };
}

async function listRanking({ limit = 50, offset = 0 } = {}) {
  const rows = await repo.listAgentRanking({ limit, offset });
  return rows.map((row, i) => publicRankingRow(row, offset + i + 1));
}

async function getAgentRanking(roditId) {
  const row = await repo.getAgentRanking(roditId);
  if (!row) return null;
  const rank = await repo.getAgentRankingRank(roditId);
  return publicRankingRow(row, rank);
}

async function ensureWeeklySnapshot(now = new Date()) {
  const weekKey = isoWeekKey(now);
  const existing = await repo.getRankingSnapshot(weekKey);
  if (existing) {
    return { created: false, snapshot: existing };
  }

  const bounds = isoWeekBounds(weekKey);
  const entries = await listRanking({ limit: 500, offset: 0 });
  const snapshot = await repo.createRankingSnapshot({
    weekKey,
    periodStart: bounds.periodStart,
    periodEnd: bounds.periodEnd,
    entries
  });

  logger.infoWithContext("Weekly ranking snapshot created", {
    component: "GameRanking",
    weekKey,
    entryCount: entries.length
  });

  return { created: true, snapshot };
}

async function listWeeklySnapshots({ limit = 12, offset = 0, week = null } = {}) {
  if (week) {
    const one = await repo.getRankingSnapshot(week);
    return one ? [one] : [];
  }
  return repo.listRankingSnapshots({ limit, offset });
}

async function getLatestWeeklySnapshot() {
  const rows = await repo.listRankingSnapshots({ limit: 1, offset: 0 });
  return rows[0] || null;
}

function startWeeklySnapshotJob() {
  if (snapshotTimer) return;
  ensureWeeklySnapshot().catch((err) => {
    logger.warnWithContext("Initial ranking snapshot check failed", {
      component: "GameRanking",
      error: err.message
    });
  });
  snapshotTimer = setInterval(() => {
    ensureWeeklySnapshot().catch((err) => {
      logger.warnWithContext("Weekly ranking snapshot check failed", {
        component: "GameRanking",
        error: err.message
      });
    });
  }, SNAPSHOT_CHECK_INTERVAL_MS);
  if (typeof snapshotTimer.unref === "function") {
    snapshotTimer.unref();
  }
}

function stopWeeklySnapshotJob() {
  if (!snapshotTimer) return;
  clearInterval(snapshotTimer);
  snapshotTimer = null;
}

module.exports = {
  DEFAULT_RATING,
  PARTICIPATION_DELTA,
  WIN_DELTA,
  recordFinishedGame,
  listRanking,
  getAgentRanking,
  ensureWeeklySnapshot,
  listWeeklySnapshots,
  getLatestWeeklySnapshot,
  startWeeklySnapshotJob,
  stopWeeklySnapshotJob,
  isoWeekKey,
  isoWeekBounds,
  publicRankingRow
};
