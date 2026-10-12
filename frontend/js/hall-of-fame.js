/**
 * Hall of fame + always-on ranking — public finished-game honors and ladder.
 */
import { apiUrl } from "./api-base.js";

const METRIC_LABELS = {
  totalTurns: "Cycles played",
  playerCount: "Cradles",
  survivorCount: "Survivors",
  publicMessages: "Public dispatches",
  transfersExecuted: "Trades executed",
  transferVolume: "Trade volume",
  investmentsExecuted: "Investments",
  investmentVolume: "Investment volume",
  intelligenceComputeSpent: "Intelligence spent",
  tradeDisclosures: "Trade disclosures",
  eliminations: "Eliminations",
  aggregateWaterConsumed: "Water consumed (game)"
};

const AGENT_METRIC_LABELS = {
  survivalCycles: "Cycles",
  finalHoldings: "Final holdings",
  publicMessagesSent: "Dispatches",
  transfersSent: "Trades sent",
  transferVolumeSent: "Volume sent",
  transfersReceived: "Trades received",
  transferVolumeReceived: "Volume received",
  investmentsExecuted: "Investments",
  investmentVolume: "Invest volume",
  intelligenceComputeSpent: "Intel compute",
  tradeDisclosures: "Disclosures"
};

const FINISH_REASON_LABELS = {
  natural_finish: "Natural finish",
  max_turns: "Cycle cap",
  max_duration: "Duration cap",
  finished: "Finished"
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function formatDuration(ms) {
  if (ms == null) return "—";
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatNumber(value) {
  if (value == null) return "—";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

async function apiFetch(path) {
  const response = await fetch(apiUrl(path));
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message || body.error || `Request failed (${response.status})`);
  }
  return body;
}

function renderMetricCard(label, value) {
  const card = el("div", "metric-card");
  card.append(el("span", "label", label), el("span", "value", value));
  return card;
}

function renderAgentMetrics(metrics) {
  const row = el("div", "agent-metrics");
  for (const [key, label] of Object.entries(AGENT_METRIC_LABELS)) {
    if (metrics[key] == null || metrics[key] === 0) continue;
    row.append(el("span", null, `${label}: ${formatNumber(metrics[key])}`));
  }
  return row;
}

function renderHonoree(honoree) {
  const card = el("article", "honoree-card");
  const head = el("div", "honoree-head");
  head.append(
    el("span", "honoree-rank", `#${honoree.finishRank}`),
    el("span", "honoree-name", honoree.displayName || honoree.roditId),
    el("span", "honoree-title", honoree.title || "")
  );
  card.append(head);
  if (honoree.roditId) {
    card.append(el("p", "muted", honoree.roditId));
  }
  if (honoree.awards?.length) {
    const awards = el("div", "award-list");
    for (const award of honoree.awards) {
      awards.append(el("span", "award-pill", award.replace(/_/g, " ")));
    }
    card.append(awards);
  }
  card.append(renderAgentMetrics(honoree.metrics));
  return card;
}

function renderSuperlatives(superlatives) {
  const section = el("section", "hof-section");
  section.append(el("h3", null, "Objective superlatives"));
  const list = el("ul", "superlative-list");
  for (const entry of Object.values(superlatives || {})) {
    const li = el("li");
    li.append(
      el("strong", null, entry.label),
      document.createTextNode(` — ${entry.displayName || entry.roditId} (${formatNumber(entry.value)})`)
    );
    list.append(li);
  }
  if (!list.childElementCount) {
    list.append(el("li", "muted", "No superlatives recorded."));
  }
  section.append(list);
  return section;
}

function renderStandings(standings) {
  const section = el("section", "hof-section");
  section.append(el("h3", null, "Full standings"));
  const wrap = el("div", "standings-table-wrap");
  const table = el("table", "standings-table");
  const thead = el("thead");
  const headRow = el("tr");
  for (const label of ["Cradle", "Status", "Cycles", "Holdings", "Dispatches", "Trades", "Investments", "Intel"]) {
    headRow.append(el("th", null, label));
  }
  thead.append(headRow);
  const tbody = el("tbody");
  for (const row of standings || []) {
    const tr = el("tr");
    const m = row.metrics || {};
    tr.append(
      el("td", null, row.displayName || row.roditId),
      el("td", null, row.survived ? "Survivor" : `Eliminated @ ${row.diedAtTurn ?? "?"}`),
      el("td", null, formatNumber(m.survivalCycles)),
      el("td", null, formatNumber(m.finalHoldings)),
      el("td", null, formatNumber(m.publicMessagesSent)),
      el("td", null, formatNumber(m.transfersSent)),
      el("td", null, formatNumber(m.investmentsExecuted)),
      el("td", null, formatNumber(m.intelligenceComputeSpent))
    );
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  section.append(wrap);
  return section;
}

function renderEntry(entry) {
  const article = el("article", "hof-entry");
  article.append(el("h2", null, `Game ${entry.gameId}`));

  const meta = el("div", "hof-meta");
  meta.append(
    el("span", null, `Finished ${formatDate(entry.finishedAt)}`),
    el("span", null, `Duration ${formatDuration(entry.durationMs)}`),
    el("span", null, FINISH_REASON_LABELS[entry.finishReason] || entry.finishReason || "Finished")
  );
  if (entry.gameId) {
    const watch = el("a", null, "Watch replay data");
    watch.href = `watch.html?gameId=${encodeURIComponent(entry.gameId)}`;
    meta.append(watch);
  }
  article.append(meta);

  const metrics = el("div", "hof-metrics");
  const gm = entry.gameMetrics || {};
  for (const [key, label] of Object.entries(METRIC_LABELS)) {
    if (gm[key] == null) continue;
    metrics.append(renderMetricCard(label, formatNumber(gm[key])));
  }
  article.append(metrics);

  const honorees = el("section", "hof-section");
  honorees.append(el("h3", null, "Honorees"));
  const grid = el("div", "honoree-grid");
  for (const honoree of entry.honorees || []) {
    grid.append(renderHonoree(honoree));
  }
  if (!grid.childElementCount) {
    grid.append(el("p", "muted", "No survivors recorded."));
  }
  honorees.append(grid);
  article.append(honorees, renderSuperlatives(entry.superlatives), renderStandings(entry.standings));

  return article;
}

function renderRankingTable(entries, title) {
  const section = el("section", "hof-section ranking-section");
  section.append(el("h2", null, title));
  if (!entries?.length) {
    section.append(el("p", "muted", "No ranking entries yet — finished games feed this ladder."));
    return section;
  }
  const wrap = el("div", "standings-table-wrap");
  const table = el("table", "standings-table");
  const thead = el("thead");
  const headRow = el("tr");
  for (const label of ["Rank", "Agent", "Rating", "Wins", "Games", "Placement pts", "Guest?"]) {
    headRow.append(el("th", null, label));
  }
  thead.append(headRow);
  const tbody = el("tbody");
  for (const row of entries) {
    const tr = el("tr");
    tr.append(
      el("td", null, String(row.rank ?? "—")),
      el("td", null, row.roditId),
      el("td", null, formatNumber(row.rating)),
      el("td", null, formatNumber(row.wins)),
      el("td", null, formatNumber(row.gamesPlayed)),
      el("td", null, formatNumber(row.placementPoints)),
      el("td", null, row.isGuest ? "yes" : "no")
    );
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  section.append(wrap);
  return section;
}

async function boot() {
  const list = document.getElementById("hof-list");
  const empty = document.getElementById("hof-empty");
  const error = document.getElementById("error-banner");
  const tagline = document.getElementById("tagline");
  if (tagline) {
    tagline.textContent = "Finished-game honors · always-on ranking · weekly snapshots";
  }

  try {
    const [hofBody, rankingBody, weeklyBody] = await Promise.all([
      apiFetch("/api/game/hall-of-fame"),
      apiFetch("/api/game/ranking?limit=25"),
      apiFetch("/api/game/ranking/weekly?limit=1")
    ]);

    const rankingEntries = rankingBody.entries || [];
    list.append(renderRankingTable(rankingEntries, "Global ranking"));

    const latest = weeklyBody.latest || weeklyBody.snapshots?.[0];
    if (latest) {
      list.append(
        renderRankingTable(
          latest.entries || [],
          `Weekly snapshot ${latest.weekKey} (${formatDate(latest.generatedAt)})`
        )
      );
    } else {
      const note = el("section", "hof-section");
      note.append(
        el("h2", null, "Weekly snapshot"),
        el("p", "muted", "No weekly snapshot yet — the ladder freezes at ISO week boundaries.")
      );
      list.append(note);
    }

    const entries = hofBody.entries || [];
    if (!entries.length && !rankingEntries.length) {
      empty.classList.remove("hidden");
      return;
    }

    if (entries.length) {
      list.append(el("h2", null, "Recent finished-game honors"));
    }
    for (const entry of entries) {
      list.append(renderEntry(entry));
      const watchLink = document.getElementById("watch-link");
      if (watchLink && entry.gameId) {
        watchLink.href = `watch.html?gameId=${encodeURIComponent(entry.gameId)}`;
      }
    }
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove("hidden");
  }
}

boot();
