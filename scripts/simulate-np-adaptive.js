#!/usr/bin/env node
/**
 * N-player adaptive simulation with milestone metrics and lore highlights.
 *
 * Usage:
 *   node scripts/simulate-np-adaptive.js 7 finish
 *   node scripts/simulate-np-adaptive.js 7 30        # max 30 turns
 *   node scripts/simulate-np-adaptive.js 7 finish --verbose
 */

const fs = require("fs");
const path = require("path");

const PLAYER_COUNT = Math.max(3, Number(process.argv.find((a) => /^\d+$/.test(a))) || 7);
const RUN_UNTIL_FINISH = process.argv.includes("finish");
const VERBOSE = process.argv.includes("--verbose");
const maxTurns = RUN_UNTIL_FINISH
  ? 10_000
  : Number(process.argv.filter((a) => /^\d+$/.test(a))[1]) ||
    Number(process.argv.find((a) => /^\d+$/.test(a) && Number(a) !== PLAYER_COUNT)) ||
    25;

const DB_PATH = path.join(
  __dirname,
  "..",
  "data",
  `game-simulation-${PLAYER_COUNT}p-adaptive.sqlite`
);
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const { collectIntelligenceFromActions } = require("../src/game/engine");
const {
  computeSurvivalCost,
  buildSurvivalContext,
  communicationCostComputeForTurn,
  investmentTotal
} = require("../src/game/survival-cost");
const { GAME_LORE, MECHANIC_NARRATIVES, buildSurvivalNarrative } = require("../src/game/narrative");
const { buildAdaptiveActions, buildAdaptiveNegotiation, negotiationTopic } = require("./sim-adaptive");

const SPECIALTY_CYCLE = ["energy", "water", "compute", null];

const PROFILES = Array.from({ length: PLAYER_COUNT }, (_, i) => {
  const specialty = SPECIALTY_CYCLE[i % SPECIALTY_CYCLE.length];
  return {
    roditId: `t-p${i}`,
    displayName: `P${i}`,
    specialty,
    role:
      specialty === "energy"
        ? "energy cradle"
        : specialty === "water"
          ? "cooling cradle"
          : specialty === "compute"
            ? "fab cradle"
            : "reserve cradle"
  };
});

function fmt(n) {
  return typeof n === "number" ? n.toFixed(1) : "—";
}

function fmtR(r) {
  return `E${fmt(r.energy)} W${fmt(r.water)} C${fmt(r.compute)}`;
}

function emptyR() {
  return { energy: 0, water: 0, compute: 0 };
}

function addR(a, b) {
  a.energy += b.energy || 0;
  a.water += b.water || 0;
  a.compute += b.compute || 0;
}

function agentName(agents, id) {
  return agents.find((a) => a.id === id)?.displayName || id;
}

function productionRate(agent) {
  if (!agent || agent.status !== "alive" || !agent.productionCapacity) return null;
  return { ...agent.productionCapacity };
}

function highlight(metrics, turn, title, lore, detail) {
  metrics.highlights.push({ turn, title, lore, detail });
  if (!VERBOSE) {
    console.log(`\n✦ CYCLE ${turn} — ${title}`);
    console.log(`  ${lore}`);
    console.log(`  ${detail}`);
  }
}

async function runTurn(gameId, agents, turnNumber, gameRow, metrics) {
  const living = agents.filter((a) => a.status === "alive");
  const livingBefore = living.length;
  const turnStartAgents = await repo.listAgents(gameId, { status: "alive" });
  const flow = {
    living: turnStartAgents.length,
    produced: emptyR(),
    invested: emptyR(),
    traded: emptyR(),
    msgsPublished: 0,
    intelHide: 0,
    intelFind: 0,
    investActions: 0,
    transferActions: 0
  };

  for (const agent of turnStartAgents) {
    const prod = productionRate(agent);
    if (prod) addR(flow.produced, prod);
  }

  const messages = buildAdaptiveNegotiation(agents, PROFILES, gameRow, turnNumber);
  const topic = negotiationTopic(gameRow, living, turnNumber);

  if (VERBOSE) {
    console.log(`\n${"═".repeat(76)}`);
    console.log(`CYCLE ${turnNumber}  topic: ${topic}  (${messages.length} messages)`);
  }

  for (const msg of messages) {
    const agent = living.find((a) => a.roditId === msg.from);
    if (!agent || agent.status !== "alive") continue;
    await engine.publishPublicMessage(gameId, agent.id, { body: msg.body });
    flow.msgsPublished += 1;
  }

  await engine.beginMessageReportPhase(gameId);
  let messageReportResults = null;
  for (const agent of living) {
    const fresh = await repo.getAgentById(agent.id);
    if (fresh.status !== "alive") continue;
    const counts = await repo.getActualMessageCounts(gameId, turnNumber, agent.id);
    const result = await engine.submitMessageReport(gameId, agent.id, counts);
    if (result.messageReportResults) messageReportResults = result.messageReportResults;
  }

  await engine.beginExecutionPhase(gameId);
  const actionMap = buildAdaptiveActions(agents, PROFILES, gameRow, turnNumber);

  for (const agent of living) {
    const fresh = await repo.getAgentById(agent.id);
    if (fresh.status !== "alive") continue;
    let action = actionMap[agent.roditId] || { type: "none" };
    if (action.type === "transfer") {
      const recipient = agents.find((a) => a.id === action.toAgentId);
      if (!recipient || recipient.status !== "alive") action = { type: "none" };
    }
    await engine.submitAction(gameId, agent.id, action);
  }

  const actions = await repo.listTurnActions(gameId, turnNumber);
  for (const row of actions) {
    const payload = repo.parseJson(row.payload_json, {});
    if (row.action_type === "transfer" && row.status === "executed") {
      flow.transferActions += 1;
      addR(flow.traded, payload);
      metrics.tradeLog.push({
        turn: turnNumber,
        from: agentName(agents, row.agent_id),
        to: agentName(agents, payload.toAgentId),
        volume: fmtR(payload)
      });
    }
    if (row.action_type === "invest" && row.status === "executed") {
      flow.investActions += 1;
      addR(flow.invested, payload);
    }
  }

  const intelligence = collectIntelligenceFromActions(actions);
  for (const hide of intelligence.hideSpendByAgent.values()) flow.intelHide += hide;
  for (const find of intelligence.findSpendByPair.values()) flow.intelFind += find;

  const gameAfter = await repo.getGameById(gameId);
  const fullAgents = await repo.listAgents(gameId);
  const livingAfter = fullAgents.filter((a) => a.status === "alive");
  const ctx = buildSurvivalContext({
    config: gameAfter.config,
    game: gameAfter,
    livingAgents: livingAfter,
    turnNumber
  });
  const survivalPerPlayer = computeSurvivalCost(gameAfter.config, ctx);
  const msgCost = communicationCostComputeForTurn(gameAfter.config, turnNumber);

  metrics.flowByTurn[turnNumber] = flow;
  metrics.totalMessages += flow.msgsPublished;
  addR(metrics.totalInvested, flow.invested);
  addR(metrics.totalTraded, flow.traded);
  metrics.totalIntelHide = (metrics.totalIntelHide || 0) + flow.intelHide;
  metrics.totalIntelFind = (metrics.totalIntelFind || 0) + flow.intelFind;

  // Milestone highlights
  if (turnNumber === 1) {
    const narrative = buildSurvivalNarrative({
      livingAgentCount: livingAfter.length,
      turnNumber,
      playerReference: gameAfter.config.survivalCostPlayerReference ?? 3
    });
    highlight(
      metrics,
      turnNumber,
      "The reproduction race opens",
      GAME_LORE.premise,
      `${livingAfter.length} territories alive | aggregate production ${fmtR(flow.produced)}/cycle | ` +
        `survival overhead ${fmtR(survivalPerPlayer)}/territory (scales with ${livingAfter.length} rivals) | ` +
        `${flow.investActions} capacity investments, ${flow.transferActions} trades`
    );
    if (!metrics._loreSurvival) {
      metrics._loreSurvival = narrative.summary;
    }
  }

  if (turnNumber === 1 && flow.investActions > 0) {
    highlight(
      metrics,
      turnNumber,
      "Cradles expand reproduction lines",
      MECHANIC_NARRATIVES.investment,
      `${flow.investActions} territories invested ${fmtR(flow.invested)} toward production/storage capacity`
    );
  }

  if (flow.msgsPublished > 0 && turnNumber <= 3) {
    highlight(
      metrics,
      turnNumber,
      "Doctrine in the public channels",
      MECHANIC_NARRATIVES.negotiation,
      `${flow.msgsPublished} public messages (${topic}); compute toll ${fmt(msgCost)} per reported send`
    );
  }

  if (flow.intelHide + flow.intelFind > 0 && !metrics._intelNoted) {
    metrics._intelNoted = true;
    highlight(
      metrics,
      turnNumber,
      "Shadow diplomacy",
      "Territories conceal fab capacity or spend compute to pierce rival fog — the race is fought in whispers as well as trade.",
      `hide ${fmt(flow.intelHide)} / find ${fmt(flow.intelFind)} compute spent this cycle`
    );
  }

  if (flow.transferActions > 0 && metrics.tradeLog.length === flow.transferActions) {
    const first = metrics.tradeLog[0];
    if (first.turn === turnNumber) {
      highlight(
        metrics,
        turnNumber,
        "First bilateral relief",
        MECHANIC_NARRATIVES.production,
        `${first.from} → ${first.to}: ${first.volume}`
      );
    }
  }

  if (messageReportResults?.globalReportMismatch) {
    highlight(
      metrics,
      turnNumber,
      "Entropy's tax on liars",
      MECHANIC_NARRATIVES.messageReports,
      `Global message-report mismatch; +${messageReportResults.energySurvivalPenalty} energy survival penalty each`
    );
  }

  if (livingAfter.length < livingBefore) {
    const dead = fullAgents.filter((a) => a.status !== "alive" && a.diedAtTurn === turnNumber);
    for (const d of dead) {
      metrics.eliminations.push({ turn: turnNumber, name: d.displayName });
    }
    highlight(
      metrics,
      turnNumber,
      "A cradle falls silent",
      MECHANIC_NARRATIVES.elimination,
      `Eliminated: ${dead.map((a) => a.displayName).join(", ")} | ${livingAfter.length}/${PLAYER_COUNT} remain | ` +
        `survival overhead now ${fmtR(survivalPerPlayer)}/territory`
    );
  }

  if (livingAfter.length <= Math.ceil(PLAYER_COUNT / 2) && !metrics._halfNoted && livingAfter.length > 2) {
    metrics._halfNoted = true;
    highlight(
      metrics,
      turnNumber,
      "The field thins",
      MECHANIC_NARRATIVES.survivalExpenses.scaling,
      `Only ${livingAfter.length} forge-cradles remain; global reproduction pressure eases slightly per rival lost, but per-cycle costs keep climbing with the epoch count`
    );
  }

  if (livingAfter.length === 3 && !metrics._threeNoted) {
    metrics._threeNoted = true;
    highlight(
      metrics,
      turnNumber,
      "Three claimants to the god-child",
      GAME_LORE.conflict,
      `Living: ${livingAfter.map((a) => a.displayName).join(", ")} | traded ${fmtR(flow.traded)} this cycle`
    );
  }

  if (livingAfter.length === 2 && !metrics._duelNoted) {
    metrics._duelNoted = true;
    highlight(
      metrics,
      turnNumber,
      "The last two forge-cradles",
      "Survivors who outlasted the reproduction race may yet learn that entropy reversal demands cooperation — not a solitary god-child.",
      `${livingAfter.map((a) => a.displayName).join(" vs ")} | cumulative investment ${fmtR(metrics.totalInvested)}`
    );
  }

  const state = await engine.getPublicState(gameId);
  return { state, gameAfter, livingAfter, flow };
}

function printFinalReport(metrics, state, playerCount) {
  console.log(`\n${"═".repeat(78)}`);
  console.log("CHRONICLE — METRIC HIGHLIGHTS");
  console.log(`${"═".repeat(78)}`);
  console.log(
    MECHANIC_NARRATIVES.territories +
      " " +
      (metrics._loreSurvival || "")
  );

  for (const h of metrics.highlights) {
    console.log(`\n✦ CYCLE ${h.turn} — ${h.title}`);
    console.log(`  Lore: ${h.lore}`);
    console.log(`  Metrics: ${h.detail}`);
  }

  console.log(`\n${"─".repeat(78)}`);
  console.log("AGGREGATE LEDGER");
  console.log(`${"─".repeat(78)}`);
  console.log(`Territories entered:     ${playerCount}`);
  console.log(`Cycles played:           ${metrics.turnsPlayed}`);
  console.log(`Status:                  ${state.game.status}`);
  console.log(`Survivors:               ${state.livingAgentCount}`);
  if (state.game.winnerIds?.length) {
    const winners = state.agents
      .filter((a) => state.game.winnerIds.includes(a.id))
      .map((a) => a.displayName);
    console.log(`Entropy-reversal pool:   ${winners.join(", ")}`);
  }
  console.log(`Public messages:         ${metrics.totalMessages}`);
  console.log(`Total invested (EWC):    ${fmtR(metrics.totalInvested)}`);
  console.log(`Total traded (EWC):      ${fmtR(metrics.totalTraded)}`);
  console.log(`Intelligence spend:      hide ${fmt(metrics.totalIntelHide)} / find ${fmt(metrics.totalIntelFind)} compute`);
  if (metrics.eliminations.length) {
    console.log(
      `Fallen cradles:          ${metrics.eliminations.map((e) => `${e.name}@T${e.turn}`).join(", ")}`
    );
  }

  const turns = Object.keys(metrics.flowByTurn).map(Number).sort((a, b) => a - b);
  if (turns.length) {
    console.log(`\n${"─".repeat(78)}`);
    console.log("RESOURCE FLOW (selected cycles)");
    console.log(`${"─".repeat(78)}`);
    const sample = turns.length <= 8 ? turns : [...turns.slice(0, 3), ...turns.slice(-3)];
    for (const t of sample) {
      const f = metrics.flowByTurn[t];
      console.log(
        `T${String(t).padStart(2)}  ${f.living} alive | prod ${fmtR(f.produced)} | invest ${fmtR(f.invested)} | trade ${fmtR(f.traded)} | msgs ${f.msgsPublished}`
      );
    }
    if (turns.length > 8) {
      console.log(`     … ${turns.length - 6} cycles omitted …`);
    }
  }
}

async function main() {
  await repo.initializeDatabase();

  const metrics = {
    highlights: [],
    flowByTurn: {},
    tradeLog: [],
    eliminations: [],
    totalMessages: 0,
    totalInvested: emptyR(),
    totalTraded: emptyR(),
    totalIntelHide: 0,
    totalIntelFind: 0,
    turnsPlayed: 0
  };

  if (VERBOSE) {
    console.log(`Adaptive simulation — ${PLAYER_COUNT} territories`);
  } else {
    console.log(`Running ${PLAYER_COUNT}-player adaptive simulation to ${RUN_UNTIL_FINISH ? "finish" : `${maxTurns} cycles`}…`);
  }

  const game = await engine.createGame({
    config: { maxAgents: PLAYER_COUNT, minAgents: 3 }
  });
  const gameId = game.id;
  const agents = [];

  for (const profile of PROFILES) {
    agents.push(await engine.joinGame(gameId, profile));
  }
  await engine.startGame(gameId);

  let state = null;
  let gameRow = await repo.getGameById(gameId);

  for (let turn = 1; turn <= maxTurns; turn++) {
    const result = await runTurn(gameId, agents, turn, gameRow, metrics);
    state = result.state;
    gameRow = result.gameAfter;
    metrics.turnsPlayed = turn;

    for (let i = 0; i < agents.length; i++) {
      agents[i] = (await repo.listAgents(gameId)).find((a) => a.id === agents[i].id);
    }

    if (state.game.status === "finished") {
      const winners = state.agents
        .filter((a) => state.game.winnerIds.includes(a.id))
        .map((a) => a.displayName);
      highlight(
        metrics,
        turn,
        "Entropy reversal — joint discovery",
        "The cradle doctrines were wrong: only the last survivors, pooling what remains, can reverse entropy together.",
        `Game finished cycle ${turn} | co-survivors: ${winners.join(", ") || "—"}`
      );
      break;
    }
  }

  printFinalReport(metrics, state, PLAYER_COUNT);
  await repo.closeDatabase();
}

main().catch((err) => {
  console.error("Simulation failed:", err.message);
  if (err.details) console.error(err.details);
  process.exit(1);
});
