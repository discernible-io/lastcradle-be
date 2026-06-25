const MESSAGE_POLL_MS = 4000;
const FALLBACK_POLL_MS = 15000;

const SSE_EVENT_TYPES = [
  "connected",
  "phase_change",
  "turn_advanced",
  "game_started",
  "game_finished",
  "game_cancelled",
  "prize_settlement"
];

const PHASE_LABELS = {
  negotiation: "Negotiation",
  message_report: "Message report",
  message_report_resolving: "Resolving reports",
  execution: "Execution",
  resolving: "Resolving turn"
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

function apiUrl(path) {
  return path;
}

async function apiFetch(path, options = {}) {
  const response = await fetch(apiUrl(path), options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.message || body.error || `Request failed (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    err.code = body.code;
    throw err;
  }
  return body;
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    });
  } catch {
    return iso;
  }
}

function formatTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString(undefined, { timeStyle: "short" });
  } catch {
    return iso;
  }
}

function formatTriple(triple) {
  if (!triple || typeof triple !== "object") return "—";
  const e = triple.energy ?? "—";
  const w = triple.water ?? "—";
  const c = triple.compute ?? "—";
  return `E ${e} · W ${w} · C ${c}`;
}

function formatInvest(payload) {
  if (!payload) return null;
  if (payload.target) {
    const amount = payload.energy ?? payload.amount;
    return amount != null ? `invest ${payload.target} (${amount})` : `invest ${payload.target}`;
  }
  const parts = [];
  if (payload.energy) parts.push(`E ${payload.energy}`);
  if (payload.water) parts.push(`W ${payload.water}`);
  if (payload.compute) parts.push(`C ${payload.compute}`);
  return parts.length ? parts.join(" · ") : null;
}

function phaseDeadline(game) {
  if (!game) return null;
  switch (game.phase) {
    case "negotiation":
      return game.negotiationEndsAt;
    case "message_report":
    case "message_report_resolving":
      return game.messageReportEndsAt;
    case "execution":
    case "resolving":
      return game.executionEndsAt;
    default:
      return null;
  }
}

function showError(message) {
  const banner = document.getElementById("error-banner");
  banner.textContent = message;
  banner.classList.remove("hidden");
}

function clearError() {
  const banner = document.getElementById("error-banner");
  banner.classList.add("hidden");
  banner.textContent = "";
}

function setConnectionStatus(text, kind = "") {
  const node = document.getElementById("connection-status");
  node.textContent = text;
  node.className = "status-pill" + (kind ? ` ${kind}` : "");
}

function agentName(agentById, agentId) {
  return agentById.get(agentId)?.displayName || agentId?.slice(0, 8) || "Unknown";
}

function buildAgentMap(agents = []) {
  return new Map(agents.map((a) => [a.id, a]));
}

function normalizeMessage(msg) {
  return {
    id: msg.id,
    fromAgentId: msg.from_agent_id ?? msg.fromAgentId,
    body: msg.body,
    createdAt: msg.created_at ?? msg.createdAt
  };
}

class SseClient {
  constructor({ gameId, onEvent, onError }) {
    this.gameId = gameId;
    this.onEvent = onEvent;
    this.onError = onError;
    this.source = null;
  }

  start() {
    this.stop();
    const url = apiUrl(`/api/game/games/${this.gameId}/events`);
    this.source = new EventSource(url);
    for (const type of SSE_EVENT_TYPES) {
      this.source.addEventListener(type, (event) => {
        try {
          this.onEvent(type, JSON.parse(event.data));
        } catch {
          /* ignore malformed payloads */
        }
      });
    }
    this.source.onerror = () => this.onError(new Error("SSE connection lost"));
  }

  stop() {
    if (this.source) {
      this.source.close();
      this.source = null;
    }
  }
}

const app = {
  gameId: null,
  state: null,
  messages: [],
  trades: [],
  selectedTurn: null,
  sse: null,
  countdownTimer: null,
  messagePollTimer: null,
  fallbackPollTimer: null
};

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const gameId = params.get("gameId");
  if (gameId) {
    await openGame(gameId);
  } else {
    await showGamePicker();
  }
}

async function showGamePicker() {
  document.getElementById("watch-root").classList.add("hidden");
  const picker = document.getElementById("game-picker");
  picker.classList.remove("hidden");
  const list = document.getElementById("game-list");
  list.replaceChildren(el("p", "muted", "Loading games…"));

  try {
    const [running, lobby] = await Promise.all([
      apiFetch("/api/game/games?status=running&limit=30"),
      apiFetch("/api/game/games?status=lobby&limit=30")
    ]);
    const games = [...(running.games || []), ...(lobby.games || [])];
    list.replaceChildren();
    if (!games.length) {
      list.append(el("p", "muted", "No active lobbies or running games."));
      return;
    }
    for (const game of games) {
      const btn = el("button", "game-card");
      const left = el("div");
      left.append(
        el("strong", null, game.id),
        el("span", null, `${game.status} · ${game.agentCount ?? 0} cradles · turn ${game.currentTurn ?? 0}`)
      );
      const right = el("span", null, game.contestMode ? `Contest: ${game.contestMode}` : "Casual");
      btn.append(left, right);
      btn.addEventListener("click", () => {
        const url = new URL(window.location.href);
        url.searchParams.set("gameId", game.id);
        window.history.replaceState({}, "", url);
        openGame(game.id);
      });
      list.append(btn);
    }
  } catch (err) {
    list.replaceChildren();
    showError(`Could not list games: ${err.message}`);
  }
}

function teardownWatch() {
  app.sse?.stop();
  app.sse = null;
  if (app.countdownTimer) clearInterval(app.countdownTimer);
  if (app.messagePollTimer) clearInterval(app.messagePollTimer);
  if (app.fallbackPollTimer) clearInterval(app.fallbackPollTimer);
  app.countdownTimer = null;
  app.messagePollTimer = null;
  app.fallbackPollTimer = null;
}

async function openGame(gameId) {
  teardownWatch();
  app.gameId = gameId;
  app.selectedTurn = null;
  document.getElementById("game-picker").classList.add("hidden");
  document.getElementById("watch-root").classList.remove("hidden");
  clearError();

  try {
    await refreshAll();
    startSse();
    startTimers();
    setConnectionStatus("Live", "live");
  } catch (err) {
    setConnectionStatus("Error", "error");
    showError(err.message);
  }
}

async function refreshAll() {
  const [stateBody, messagesBody, tradesBody] = await Promise.all([
    apiFetch(`/api/game/games/${app.gameId}/state`),
    fetchMessagesForTurn(app.selectedTurn),
    fetchTradesForTurn(app.selectedTurn)
  ]);
  app.state = stateBody;
  app.messages = messagesBody.messages || [];
  app.trades = tradesBody.trades || [];
  if (app.selectedTurn == null) {
    app.selectedTurn = stateBody.game?.currentTurn || 0;
  }
  renderAll();
}

async function fetchMessagesForTurn(turn) {
  const turnQuery = turn != null ? `?turn=${turn}` : "";
  return apiFetch(`/api/game/games/${app.gameId}/messages${turnQuery}`);
}

async function fetchTradesForTurn(turn) {
  const turnQuery = turn != null ? `?turn=${turn}` : "";
  return apiFetch(`/api/game/games/${app.gameId}/trades${turnQuery}`);
}

async function refreshMessages() {
  try {
    const body = await fetchMessagesForTurn(app.selectedTurn);
    app.messages = body.messages || [];
    renderMessages(buildAgentMap(app.state?.agents || []));
  } catch (err) {
    showError(`Messages: ${err.message}`);
  }
}

async function refreshTrades() {
  try {
    const body = await fetchTradesForTurn(app.selectedTurn);
    app.trades = body.trades || [];
    renderTrades(buildAgentMap(app.state?.agents || []));
  } catch (err) {
    showError(`Trades: ${err.message}`);
  }
}

async function refreshState() {
  try {
    const stateBody = await apiFetch(`/api/game/games/${app.gameId}/state`);
    const prevTurn = app.state?.game?.currentTurn;
    app.state = stateBody;
    if (app.selectedTurn == null || app.selectedTurn === prevTurn) {
      app.selectedTurn = stateBody.game?.currentTurn || app.selectedTurn;
    }
    renderAll();
  } catch (err) {
    setConnectionStatus("Error", "error");
    showError(`State: ${err.message}`);
  }
}

function startSse() {
  app.sse = new SseClient({
    gameId: app.gameId,
    onEvent: (_type, payload) => {
      if (payload.type === "connected") return;
      if (
        ["phase_change", "turn_advanced", "game_started", "game_finished", "game_cancelled", "prize_settlement"].includes(
          payload.type
        )
      ) {
        refreshState();
        if (payload.type === "turn_advanced" || payload.type === "phase_change") {
          app.selectedTurn = payload.currentTurn ?? app.selectedTurn;
          refreshMessages();
          refreshTrades();
        }
      }
    },
    onError: () => {
      setConnectionStatus("Reconnecting…", "error");
      setTimeout(() => {
        if (app.gameId) {
          app.sse?.start();
          setConnectionStatus("Live", "live");
        }
      }, 3000);
    }
  });
  app.sse.start();
}

function startTimers() {
  app.countdownTimer = setInterval(updateCountdown, 1000);
  app.messagePollTimer = setInterval(() => {
    if (app.state?.game?.phase === "negotiation") refreshMessages();
    if (app.state?.game?.phase === "execution") refreshTrades();
  }, MESSAGE_POLL_MS);
  app.fallbackPollTimer = setInterval(refreshState, FALLBACK_POLL_MS);
}

function updateCountdown() {
  const game = app.state?.game;
  const node = document.getElementById("phase-countdown");
  if (!game || game.status !== "running") {
    node.textContent = "";
    node.classList.remove("urgent");
    return;
  }
  const deadline = phaseDeadline(game);
  if (!deadline) {
    node.textContent = "";
    return;
  }
  const ms = new Date(deadline).getTime() - Date.now();
  if (ms <= 0) {
    node.textContent = "Phase ending…";
    node.classList.add("urgent");
    return;
  }
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  node.textContent = `${min}:${String(sec).padStart(2, "0")} remaining`;
  node.classList.toggle("urgent", ms < 60000);
}

function renderAll() {
  const state = app.state;
  if (!state) return;
  const game = state.game;
  const agentById = buildAgentMap(state.agents);

  document.getElementById("tagline").textContent =
    `Watching ${game.id} · ${state.livingAgentCount} cradles active`;

  renderMeta(game, state);
  renderPhase(game, state);
  renderCradles(state, agentById);
  renderTurnPicker(game);
  renderMessages(agentById);
  renderTrades(agentById);
  renderFinale(state, agentById);
  updateCountdown();

  document.getElementById("phase-label").textContent =
    game.status === "running"
      ? `Cycle ${game.currentTurn} · ${PHASE_LABELS[game.phase] || game.phase || "—"}`
      : game.status === "lobby"
        ? "Lobby — waiting to start"
        : game.status === "finished"
          ? "Game finished"
          : game.status;
}

function renderMeta(game, state) {
  const meta = document.getElementById("game-meta");
  meta.replaceChildren();
  const entries = [
    ["Game ID", game.id],
    ["Status", game.status],
    ["Contest", game.contestMode || "casual"],
    ["Cycle", String(game.currentTurn ?? 0)],
    ["Living cradles", String(state.livingAgentCount)],
    ["Comm. cost (compute)", String(game.communicationCostCompute ?? "—")],
    ["Started", formatDate(game.startedAt)],
    ["Ends", formatDate(game.endsAt)]
  ];
  if (game.joiningWindow) {
    entries.push([
      "Joining window",
      `${game.joiningWindow.open ? "open" : "closed"} · ${formatDate(game.joiningWindow.startsAt)} → ${formatDate(game.joiningWindow.endsAt)}`
    ]);
  }
  for (const row of entries) {
    const dt = el("dt", null, row[0]);
    const dd = el("dd", null, row[1]);
    meta.append(dt, dd);
  }
}

function renderPhase(game, state) {
  const detail = document.getElementById("phase-detail");
  detail.replaceChildren();

  if (game.status === "lobby") {
    detail.append(el("p", null, "Cradles may still join during the joining window."));
    return;
  }
  if (game.status !== "running") {
    detail.append(el("p", null, `Game is ${game.status}.`));
    return;
  }

  const phase = game.phase;
  const submission =
    phase === "message_report" ? state.messageReport : phase === "execution" ? state.execution : null;

  detail.append(el("p", null, PHASE_LABELS[phase] || phase || "—"));

  if (submission) {
    const pct =
      submission.livingCount > 0
        ? Math.round((submission.submittedCount / submission.livingCount) * 100)
        : 0;
    const bar = el("div", "progress-bar");
    const fill = el("div", "progress-fill");
    fill.style.width = `${pct}%`;
    bar.append(fill);
    detail.append(
      bar,
      el("p", "muted", `${submission.submittedCount} / ${submission.livingCount} cradles submitted`)
    );
  }

  if (state.messageReportPenalties?.length) {
    const mismatch = state.messageReportPenalties[0]?.globalReportMismatch;
    if (mismatch != null) {
      detail.append(el("p", null, `Report mismatch this cycle: ${mismatch}`));
    }
  }

  const narrative = document.getElementById("survival-narrative");
  narrative.textContent = state.narrative?.survival || state.narrative?.premise || "";
}

function renderCradles(state, agentById) {
  const tbody = document.getElementById("cradle-rows");
  tbody.replaceChildren();
  document.getElementById("living-count").textContent = `${state.livingAgentCount} living`;

  const phase = state.game?.phase;
  const submission =
    phase === "message_report" ? state.messageReport : phase === "execution" ? state.execution : null;
  const submittedSet = new Set(submission?.submittedAgentIds || []);
  const penaltyByAgent = new Map((state.messageReportPenalties || []).map((p) => [p.agentId, p]));
  const investByAgent = new Map((state.turnInvestments || []).map((i) => [i.agentId, i]));

  const agents = [...(state.agents || [])].sort((a, b) => {
    if (a.status !== b.status) return a.status === "alive" ? -1 : 1;
    return (a.displayName || "").localeCompare(b.displayName || "");
  });

  for (const agent of agents) {
    const tr = el("tr", agent.status === "dead" ? "dead" : "");
    const nameTd = el("td");
    nameTd.append(el("span", "cradle-name", agent.displayName || agent.roditId));

    const statusTd = el("td");
    if (agent.status === "alive") {
      statusTd.append(el("span", "tag done", "alive"));
    } else {
      statusTd.append(el("span", "tag", `dead @ cycle ${agent.diedAtTurn ?? "?"}`));
    }

    const survivalTd = el("td", "resource-triple");
    const survival = state.projectedSurvival?.[agent.id];
    survivalTd.textContent = agent.status === "alive" && survival ? formatTriple(survival) : "—";

    const phaseTd = el("td");
    if (agent.status === "alive" && submission) {
      const submitted = submittedSet.has(agent.id);
      phaseTd.append(
        el("span", `tag ${submitted ? "done" : "pending"}`, submitted ? "submitted" : "pending")
      );
    } else {
      phaseTd.textContent = "—";
    }

    const notesTd = el("td");
    if (agent.intelligenceHidden) {
      notesTd.append(el("span", "tag", "holdings hidden"));
    }
    const penalty = penaltyByAgent.get(agent.id);
    if (penalty?.energySurvivalPenalty) {
      notesTd.append(el("span", "tag penalty", `report penalty +${penalty.energySurvivalPenalty} E`));
    }
    if (penalty?.reportedSent != null) {
      notesTd.append(el("span", "tag", `reported ${penalty.reportedSent}/${penalty.reportedReceived}`));
    }
    const invest = investByAgent.get(agent.id);
    const investText = formatInvest(invest);
    if (investText) {
      notesTd.append(el("span", "tag invest", investText));
    }
    if (!notesTd.childNodes.length) notesTd.textContent = "—";

    tr.append(nameTd, statusTd, survivalTd, phaseTd, notesTd);
    tbody.append(tr);
  }
}

function renderTurnPicker(game) {
  const nav = document.getElementById("turn-picker");
  nav.replaceChildren();
  const maxTurn = Math.max(game.currentTurn || 0, 1);
  if (game.status === "lobby") return;

  for (let t = 1; t <= maxTurn; t += 1) {
    const btn = el("button", t === app.selectedTurn ? "active" : "", String(t));
    btn.addEventListener("click", async () => {
      app.selectedTurn = t;
      renderTurnPicker(game);
      await Promise.all([refreshMessages(), refreshTrades()]);
    });
    nav.append(btn);
  }
}

function renderMessages(agentById) {
  const feed = document.getElementById("messages-feed");
  feed.replaceChildren();

  const messages = (app.messages || []).map(normalizeMessage);
  if (!messages.length) {
    feed.append(
      el(
        "div",
        "messages-empty",
        app.state?.game?.phase === "negotiation" && app.selectedTurn === app.state?.game?.currentTurn
          ? "No public dispatches yet this cycle."
          : "No public messages recorded for this cycle."
      )
    );
    return;
  }

  for (const msg of messages) {
    const card = el("article", "message-card");
    const meta = el("div", "meta");
    meta.append(
      el("span", "from", agentName(agentById, msg.fromAgentId)),
      el("span", null, formatTime(msg.createdAt))
    );
    card.append(meta, el("p", "body", msg.body));
    feed.append(card);
  }
  feed.scrollTop = feed.scrollHeight;
}

function renderTrades(agentById) {
  const feed = document.getElementById("trades-feed");
  feed.replaceChildren();

  const trades = app.trades || [];
  if (!trades.length) {
    feed.append(
      el(
        "div",
        "messages-empty",
        app.state?.game?.phase === "execution" && app.selectedTurn === app.state?.game?.currentTurn
          ? "No transfers submitted yet this cycle."
          : "No transfers recorded for this cycle."
      )
    );
    return;
  }

  for (const trade of trades) {
    const card = el("article", "trade-card");
    const head = el("div", "trade-head");
    head.append(
      el(
        "span",
        "trade-route",
        `${agentName(agentById, trade.fromAgentId)} → ${agentName(agentById, trade.toAgentId)}`
      ),
      el("span", null, trade.status || "pending"),
      el("span", null, formatTime(trade.submittedAt))
    );
    card.append(head);
    card.append(el("p", "trade-amounts", formatTriple(trade)));

    if (trade.rationale) {
      card.append(el("p", "trade-rationale", `Why: ${trade.rationale}`));
    }

    if (trade.privateDealSnippets?.length) {
      const list = el("ul", "trade-snippets");
      for (const snippet of trade.privateDealSnippets) {
        const li = el("li");
        const metaParts = [snippet.taskType, snippet.channel, snippet.peerTokenId].filter(Boolean);
        if (snippet.holaVerified) metaParts.push("HOLA verified");
        if (metaParts.length) {
          li.append(el("div", "snippet-meta", metaParts.join(" · ")));
        }
        li.append(el("span", null, `“${snippet.excerpt}”`));
        list.append(li);
      }
      card.append(list);
    }

    feed.append(card);
  }
}

function renderFinale(state, agentById) {
  const finale = document.getElementById("finale");
  const game = state.game;
  if (game.status !== "finished" && game.status !== "cancelled") {
    finale.classList.add("hidden");
    return;
  }
  finale.classList.remove("hidden");
  finale.replaceChildren(el("h2", null, game.status === "cancelled" ? "Contest cancelled" : "Final accounting"));

  if (game.winnerIds?.length) {
    const names = game.winnerIds.map((id) => agentName(agentById, id)).join(", ");
    finale.append(el("p", null, `Entropy reversal credited to: ${names}.`));
  }

  const fallen = (state.agents || []).filter((a) => a.status === "dead");
  if (fallen.length) {
    const text = fallen
      .map((a) => `${a.displayName || a.roditId} (cycle ${a.diedAtTurn ?? "?"})`)
      .join("; ");
    finale.append(el("p", null, `Fallen cradles: ${text}.`));
  }
}

boot().catch((err) => showError(err.message));
