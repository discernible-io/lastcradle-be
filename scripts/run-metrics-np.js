#!/usr/bin/env node
/**
 * N-player simulation with investment, trade, production, and messaging metrics.
 * Usage: node scripts/run-metrics-np.js <players> [finish] [long]
 */

const fs = require("fs");
const path = require("path");

const PLAYER_COUNT = Math.max(3, Number(process.argv.find((a) => /^\d+$/.test(a))) || 10);
const RUN_UNTIL_FINISH = process.argv.includes("finish");
const USE_LONG = process.argv.includes("long") || process.argv.includes("contest");
const COMPACT = process.argv.includes("compact") || PLAYER_COUNT > 20;
const MSGS_PER_PLAYER = PLAYER_COUNT > 25 ? 1 : 3;

const DB_PATH = path.join(__dirname, "..", "data", `game-metrics-${PLAYER_COUNT}p.sqlite`);
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const {
  computeSurvivalCost,
  buildSurvivalContext,
  investmentTotal
} = require("../src/game/survival-cost");
const { buildInvestAction, mergeGameConfig } = require("../src/game/defaults");
const { collectIntelligenceFromActions } = require("../src/game/engine");
const { buildHeavyTradeActions, tradesTargetFor } = require("./sim-trading");

const SPECIALTY_CYCLE = ["energy", "water", "compute", null];

const PROFILES = Array.from({ length: PLAYER_COUNT }, (_, i) => {
  const specialty = SPECIALTY_CYCLE[i % SPECIALTY_CYCLE.length];
  return {
    roditId: `t-p${i}`,
    displayName: `P${i}`,
    specialty,
    role:
      specialty === "energy"
        ? "energy"
        : specialty === "water"
          ? "water"
          : specialty === "compute"
            ? "compute"
            : "reserve"
  };
});

const RODIT_IDS = PROFILES.map((p) => p.roditId);

function profileFor(roditId) {
  return PROFILES.find((p) => p.roditId === roditId);
}

function specialtyAction(specialty, amount) {
  if (!specialty) return { type: "none" };
  if (specialty === "energy") return buildInvestAction("energy", amount);
  if (specialty === "water") return buildInvestAction("water", amount);
  return buildInvestAction("compute", amount);
}

function buildNegotiation(turnNumber, topic) {
  const kinds = MSGS_PER_PLAYER === 1 ? ["Proposal"] : ["Proposal", "Counter", "Accept"];
  const messages = [];
  for (const profile of PROFILES) {
    for (const kind of kinds) {
      messages.push({
        from: profile.roditId,
        body: `[T${turnNumber}] ${kind} (${topic}): ${profile.displayName} position.`
      });
    }
  }
  return messages;
}

function allActions(fn) {
  return Object.fromEntries(RODIT_IDS.map((id) => [id, fn(id)]));
}

function firstAliveWithSpecialty(agents, specialty) {
  return agents.find((a) => a.status === "alive" && profileFor(a.roditId)?.specialty === specialty);
}

const TURN_PLANS = [
  {
    messages: buildNegotiation(1, "specialty allocation for survival"),
    actions: allActions((id) => {
      const s = profileFor(id).specialty;
      if (s === "energy") return specialtyAction(s, 14);
      if (s === "water") return specialtyAction(s, 12);
      if (s === "compute") return specialtyAction(s, 10);
      return buildInvestAction("water", 4);
    })
  },
  {
    messages: buildNegotiation(2, "sustain water investment share"),
    actions: allActions((id) => {
      const s = profileFor(id).specialty;
      if (s === "energy") return specialtyAction(s, 10);
      if (s === "water") return specialtyAction(s, 10);
      if (s === "compute") return specialtyAction(s, 8);
      return { type: "none" };
    })
  },
  {
    messages: buildNegotiation(3, "water-for-compute bilateral deals"),
    actions: (agents) => {
      const waterLead = firstAliveWithSpecialty(agents, "water");
      const computeLead = firstAliveWithSpecialty(agents, "compute");
      const actions = allActions(() => ({ type: "none" }));
      if (waterLead && computeLead) {
        actions[waterLead.roditId] = {
          type: "transfer",
          toAgentId: computeLead.id,
          energy: 0,
          water: 15,
          compute: 0
        };
        actions[computeLead.roditId] = buildInvestAction("compute", 10);
      }
      for (const agent of agents) {
        if (agent.status !== "alive") continue;
        const s = profileFor(agent.roditId)?.specialty;
        if (s === "water" && actions[agent.roditId]?.type === "none") {
          actions[agent.roditId] = buildInvestAction("water", 8);
        }
      }
      return actions;
    }
  },
  {
    messages: buildNegotiation(4, "water survival push"),
    actions: allActions((id) => {
      const s = profileFor(id).specialty;
      if (s === "water") return specialtyAction(s, 14);
      if (s === "energy") return specialtyAction(s, 15);
      if (s === "compute") return { type: "none" };
      return buildInvestAction("water", 5);
    })
  },
  {
    messages: buildNegotiation(5, "consolidate margins"),
    actions: allActions((id) => {
      const s = profileFor(id).specialty;
      if (s === "water") return specialtyAction(s, 8);
      if (s === "compute") return specialtyAction(s, 5);
      return { type: "none" };
    })
  }
];

function survivalActions(agents, game) {
  const living = agents.filter((a) => a.status === "alive");
  const actions = Object.fromEntries(RODIT_IDS.map((id) => [id, { type: "none" }]));
  const survivalContext = buildSurvivalContext({
    config: game.config,
    game,
    livingAgents: living,
    turnNumber: game.current_turn
  });

  for (const agent of living) {
    const survival = computeSurvivalCost(game.config, survivalContext);
    const inv = agent.inventory;
    const specialty = profileFor(agent.roditId)?.specialty;
    const waterMargin = inv.water - survival.water;
    const energyMargin = inv.energy - survival.energy;
    const computeMargin = inv.compute - survival.compute;

    if (specialty === "water") {
      const amt = waterMargin > 25 ? 10 : waterMargin > 15 ? 6 : 0;
      if (amt > 0) actions[agent.roditId] = buildInvestAction("water", amt);
    } else if (specialty === "energy" && energyMargin > 20) {
      actions[agent.roditId] = buildInvestAction("energy", 8);
    } else if (specialty === "compute" && computeMargin > 18) {
      actions[agent.roditId] = buildInvestAction("compute", 6);
    }
  }
  return actions;
}

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

function sumProductionRow(row) {
  const total = emptyR();
  for (const prod of Object.values(row || {})) {
    addR(total, prod);
  }
  return total;
}
function productionRate(agent) {
  if (!agent || agent.status !== "alive" || !agent.productionCapacity) return null;
  return {
    energy: agent.productionCapacity.energy,
    water: agent.productionCapacity.water,
    compute: agent.productionCapacity.compute
  };
}

function emptyFlow() {
  return { energy: 0, water: 0, compute: 0, transfers: 0 };
}

function addFlow(a, b) {
  a.energy += b.energy || 0;
  a.water += b.water || 0;
  a.compute += b.compute || 0;
  a.transfers += 1;
}

function agentName(agents, id) {
  return agents.find((a) => a.id === id)?.displayName || id;
}

function emptyInvest() {
  return { energy: 0, water: 0, compute: 0, actions: 0, waterProdTotal: 0 };
}

function emptyPlayerTurn() {
  return {
    production: null,
    invested: emptyR(),
    tradeOut: emptyR(),
    tradeIn: emptyR(),
    intelHide: 0,
    intelFind: 0
  };
}

function ensurePlayerTurn(metrics, turnNumber, name) {
  metrics.perPlayerByTurn[turnNumber] = metrics.perPlayerByTurn[turnNumber] || {};
  if (!metrics.perPlayerByTurn[turnNumber][name]) {
    metrics.perPlayerByTurn[turnNumber][name] = emptyPlayerTurn();
  }
  return metrics.perPlayerByTurn[turnNumber][name];
}

function addInvest(a, payload) {
  a.energy += payload.energy || 0;
  a.water += payload.water || 0;
  a.compute += payload.compute || 0;
  a.waterProdTotal += investmentTotal(payload);
  a.actions += 1;
}

async function runTurn(gameId, agents, turnNumber, plan, metrics, gameRowBefore) {
  const living = agents.filter((a) => a.status === "alive");
  const turnStartAgents = await repo.listAgents(gameId, { status: "alive" });
  const flow = {
    living: turnStartAgents.length,
    produced: emptyR(),
    invested: emptyR(),
    traded: emptyR(),
    spentSurvival: emptyR(),
  };

  for (const agent of turnStartAgents) {
    const prod = productionRate(agent);
    metrics.productionByTurn[turnNumber] = metrics.productionByTurn[turnNumber] || {};
    metrics.productionByTurn[turnNumber][agent.displayName] = prod;
    const row = ensurePlayerTurn(metrics, turnNumber, agent.displayName);
    row.production = prod;
    metrics.cumulativeProduction[agent.displayName] = metrics.cumulativeProduction[agent.displayName] || {
      energy: 0,
      water: 0,
      compute: 0
    };
    metrics.cumulativeProduction[agent.displayName].energy += prod.energy;
    metrics.cumulativeProduction[agent.displayName].water += prod.water;
    metrics.cumulativeProduction[agent.displayName].compute += prod.compute;
  }
  flow.produced = sumProductionRow(metrics.productionByTurn[turnNumber]);

  const messages = plan.messages || buildNegotiation(turnNumber, "survival review");
  let msgsPublished = 0;
  for (const msg of messages) {
    const agent = living.find((a) => a.roditId === msg.from);
    if (!agent || agent.status !== "alive") continue;
    await engine.publishPublicMessage(gameId, agent.id, { body: msg.body });
    msgsPublished += 1;
  }
  metrics.messagingByTurn[turnNumber] = { published: msgsPublished, planned: messages.length };

  await engine.beginExecutionPhase(gameId);
  metrics.totalMessagesPublished += msgsPublished;

  const actionMap = typeof plan.actions === "function" ? plan.actions(agents) : plan.actions;

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
    const name = agentName(agents, row.agent_id);

    if (row.action_type === "transfer" && row.status === "executed") {
      const to = agentName(agents, payload.toAgentId);
      const fromRow = ensurePlayerTurn(metrics, turnNumber, name);
      const toRow = ensurePlayerTurn(metrics, turnNumber, to);
      addR(fromRow.tradeOut, payload);
      addR(toRow.tradeIn, payload);
      const key = `${name} → ${to}`;
      metrics.tradeFlows[key] = metrics.tradeFlows[key] || emptyFlow();
      addFlow(metrics.tradeFlows[key], payload);
      addR(flow.traded, payload);
      metrics.tradesByTurn[turnNumber] = metrics.tradesByTurn[turnNumber] || [];
      metrics.tradesByTurn[turnNumber].push({
        from: name,
        to,
        energy: payload.energy || 0,
        water: payload.water || 0,
        compute: payload.compute || 0
      });
    }

    if (
      (row.action_type === "invest_production" ||
        row.action_type === "invest_storage" ||
        row.action_type === "invest" ||
        row.action_type === "transfer_and_invest_production" ||
        row.action_type === "transfer_and_invest_storage") &&
      row.status === "executed"
    ) {
      const investPayload =
        row.action_type.startsWith("transfer_and_invest") ? payload.invest || {} : payload;
      addR(flow.invested, investPayload);
      addR(ensurePlayerTurn(metrics, turnNumber, name).invested, investPayload);
      metrics.investmentByPlayer[name] = metrics.investmentByPlayer[name] || emptyInvest();
      addInvest(metrics.investmentByPlayer[name], investPayload);
      metrics.investmentByTurn[turnNumber] = metrics.investmentByTurn[turnNumber] || emptyInvest();
      addInvest(metrics.investmentByTurn[turnNumber], investPayload);
    }
  }

  const intelligence = collectIntelligenceFromActions(actions);
  for (const [agentId, hideSpend] of intelligence.hideSpendByAgent) {
    ensurePlayerTurn(metrics, turnNumber, agentName(agents, agentId)).intelHide = hideSpend;
  }
  for (const [pairKey, findSpend] of intelligence.findSpendByPair) {
    const viewerId = pairKey.split(":")[1];
    ensurePlayerTurn(metrics, turnNumber, agentName(agents, viewerId)).intelFind += findSpend;
  }

  const gameAfter = await repo.getGameById(gameId);
  const config = gameAfter.config;

  const survivalContext = buildSurvivalContext({
    config,
    game: { aggregateWaterConsumed: gameRowBefore?.aggregateWaterConsumed ?? 0 },
    livingAgents: turnStartAgents,
    turnNumber
  });
  for (const agent of turnStartAgents) {
    const after = await repo.getAgentById(agent.id);
    if (after.status !== "alive" || after.diedAtTurn === turnNumber) {
      continue;
    }
    addR(flow.spentSurvival, computeSurvivalCost(config, survivalContext));
  }

  flow.spentTotal = { ...flow.spentSurvival };
  metrics.flowByTurn[turnNumber] = flow;

  return engine.getPublicState(gameId);
}

function printTurnFlowTable(metrics) {
  printSection("RESOURCE FLOW BY TURN (aggregate E / W / C)");
  console.log(
    "Turn  Living | Produced (E/W/C)        | Invested (E/W/C)        | " +
      "Spent survival (E/W/C)  | Traded out (E/W/C)"
  );
  console.log("-".repeat(118));

  const totals = {
    produced: emptyR(),
    invested: emptyR(),
    traded: emptyR(),
    spentSurvival: emptyR()
  };

  for (const turn of Object.keys(metrics.flowByTurn).sort((a, b) => a - b)) {
    const f = metrics.flowByTurn[turn];
    addR(totals.produced, f.produced);
    addR(totals.invested, f.invested);
    addR(totals.traded, f.traded);
    addR(totals.spentSurvival, f.spentSurvival);

    console.log(
      `T${String(turn).padStart(2)}   ${String(f.living).padStart(2)}    | ` +
        `${fmtR(f.produced).padEnd(23)} | ${fmtR(f.invested).padEnd(23)} | ` +
        `${fmtR(f.spentSurvival).padEnd(23)} | ${fmtR(f.traded)}`
    );
  }

  console.log("-".repeat(118));
  console.log(
    `TOTAL       | ${fmtR(totals.produced).padEnd(23)} | ${fmtR(totals.invested).padEnd(23)} | ` +
      `${fmtR(totals.spentSurvival).padEnd(23)} | ${fmtR(totals.traded)}`
  );
  console.log(
    "\nNotes: Produced = capacity×development at turn start. Invested/Traded = executed actions. " +
      "Spent survival = paid by survivors."
  );
}

function isZeroR(r) {
  return !r || (r.energy === 0 && r.water === 0 && r.compute === 0);
}

function printPerPlayerPerTurnTable(metrics, playerCount) {
  printSection("PER PLAYER BY TURN (production / invest / trade / intelligence)");
  console.log(
    "Production = capacity×development at turn start. Invest/trade = executed execution phase. " +
      "Intel = compute spent on hide/find (0 if none)."
  );

  const playerNames = PROFILES.map((p) => p.displayName);
  for (const turn of Object.keys(metrics.perPlayerByTurn).sort((a, b) => a - b)) {
    const rowByPlayer = metrics.perPlayerByTurn[turn];
    const living = Object.keys(rowByPlayer).length;
    console.log(`\n--- Turn ${turn} (${living} players) ---`);
    console.log(
      "Player  Production (E/W/C)     Invested (E/W/C)       Trade out (E/W/C)      Trade in (E/W/C)       Intel hide/find/tot"
    );
    console.log("-".repeat(118));

    for (const name of playerNames) {
      const row = rowByPlayer[name];
      if (!row) continue;
      const prod = row.production ? fmtR(row.production) : "—";
      const inv = isZeroR(row.invested) ? "—" : fmtR(row.invested);
      const out = isZeroR(row.tradeOut) ? "—" : fmtR(row.tradeOut);
      const inn = isZeroR(row.tradeIn) ? "—" : fmtR(row.tradeIn);
      const intelTotal = row.intelHide + row.intelFind;
      const intel =
        intelTotal === 0
          ? "—"
          : `${fmt(row.intelHide)}/${fmt(row.intelFind)}/${fmt(intelTotal)}`;
      console.log(
        `${name.padEnd(6)}  ${prod.padEnd(21)} ${inv.padEnd(22)} ${out.padEnd(22)} ${inn.padEnd(22)} ${intel}`
      );
    }
  }
}

function printSection(title) {
  console.log(`\n${"=".repeat(78)}`);
  console.log(title);
  console.log("=".repeat(78));
}

async function printMetrics(metrics, finalState, playerCount) {
  printSection("GAME OUTCOME");
  console.log(`Players: ${playerCount}`);
  console.log(`Turns played: ${metrics.turnsPlayed}`);
  console.log(`Status: ${finalState.game.status}`);
  console.log(`Living: ${finalState.livingAgentCount}/${playerCount}`);
  console.log(
    `Water survival budget: ${fmt(finalState.game.waterSurvivalBudget)} | consumed: ${fmt(finalState.game.waterSurvivalConsumed)} | remaining: ${fmt(finalState.game.waterSurvivalRemaining)}`
  );
  if (finalState.game.winnerIds?.length) {
    const winners = finalState.agents
      .filter((a) => finalState.game.winnerIds.includes(a.id))
      .map((a) => a.displayName);
    console.log(`Winners (${winners.length}): ${winners.join(", ")}`);
  }

  printSection("MESSAGING METRICS");
  console.log(`Total public messages published: ${metrics.totalMessagesPublished}`);
  console.log(`Messages per turn (planned): ${MSGS_PER_PLAYER * playerCount} (${MSGS_PER_PLAYER}/player)`);
  console.log("\n  By turn (published / planned):");
  for (const turn of Object.keys(metrics.messagingByTurn).sort((a, b) => a - b)) {
    const m = metrics.messagingByTurn[turn];
    console.log(`    T${turn}: ${m.published} / ${m.planned}`);
  }
  console.log("\n  Per player (sent / received, cumulative):");
  for (const name of PROFILES.map((p) => p.displayName)) {
    const m = metrics.messagingByPlayer[name];
    if (!m) continue;
    console.log(`    ${name.padEnd(4)} sent ${String(m.sent).padStart(4)} | received ${String(m.received).padStart(4)}`);
  }

  printSection("INVESTMENT METRICS (executed invest actions)");
  const invPlayers = Object.keys(metrics.investmentByPlayer);
  if (invPlayers.length === 0) {
    console.log("  (no investments executed)");
  } else {
    console.log("  Player   Actions   Resources invested       Water-prod total");
    for (const name of PROFILES.map((p) => p.displayName)) {
      const inv = metrics.investmentByPlayer[name];
      if (!inv) continue;
      console.log(
        `  ${name.padEnd(6)} ${String(inv.actions).padStart(3)}       ${fmtR(inv).padEnd(22)} ${fmt(inv.waterProdTotal)}`
      );
    }
    console.log("\n  By turn (resource volume):");
    for (const turn of Object.keys(metrics.investmentByTurn).sort((a, b) => a - b)) {
      const inv = metrics.investmentByTurn[turn];
      console.log(`    T${turn}: ${inv.actions} actions | ${fmtR(inv)} | water-prod ${fmt(inv.waterProdTotal)}`);
    }
  }

  printSection("TRADE METRICS (executed transfers)");
  const flowKeys = Object.keys(metrics.tradeFlows);
  if (flowKeys.length === 0) {
    console.log("  (no transfers executed)");
  } else {
    let totalTransfers = 0;
    const totals = emptyFlow();
    console.log("  Route              Transfers   Volume");
    for (const key of flowKeys.sort()) {
      const f = metrics.tradeFlows[key];
      totalTransfers += f.transfers;
      totals.energy += f.energy;
      totals.water += f.water;
      totals.compute += f.compute;
      console.log(`  ${key.padEnd(18)} ${String(f.transfers).padStart(3)}       ${fmtR(f)}`);
    }
    console.log(`\n  Totals: ${totalTransfers} transfers | ${fmtR(totals)}`);
    console.log("\n  By turn:");
    for (const turn of Object.keys(metrics.tradesByTurn).sort((a, b) => a - b)) {
      for (const t of metrics.tradesByTurn[turn]) {
        console.log(`    T${turn} ${t.from} → ${t.to}: ${fmtR(t)}`);
      }
    }
  }

  printSection("PRODUCTION METRICS (capacity × development, at turn start)");
  console.log("  Cumulative production by player:");
  for (const name of PROFILES.map((p) => p.displayName)) {
    const p = metrics.cumulativeProduction[name];
    if (!p) continue;
    console.log(`    ${name.padEnd(6)} ${fmtR(p)}`);
  }
  const prodTurns = Object.keys(metrics.productionByTurn).sort((a, b) => a - b);
  if (prodTurns.length <= 10) {
    console.log("\n  Per turn:");
    for (const turn of prodTurns) {
      const row = metrics.productionByTurn[turn];
      const total = { energy: 0, water: 0, compute: 0 };
      for (const prod of Object.values(row)) {
        total.energy += prod.energy;
        total.water += prod.water;
        total.compute += prod.compute;
      }
      console.log(`    T${turn} aggregate: ${fmtR(total)} (${Object.keys(row).length} cradles)`);
    }
  } else {
    console.log(`\n  Per-turn detail omitted (${prodTurns.length} turns); showing first 3 and last 3:`);
    const sample = [...prodTurns.slice(0, 3), ...prodTurns.slice(-3)];
    for (const turn of sample) {
      const row = metrics.productionByTurn[turn];
      const total = { energy: 0, water: 0, compute: 0 };
      for (const prod of Object.values(row)) {
        total.energy += prod.energy;
        total.water += prod.water;
        total.compute += prod.compute;
      }
      console.log(`    T${turn} aggregate: ${fmtR(total)} (${Object.keys(row).length} cradles)`);
    }
  }

  printSection("FINAL STATE (survivors)");
  for (const agent of finalState.agents) {
    if (agent.status === "alive") {
      const full = (await repo.getAgentById(agent.id)) || agent;
      const prod = productionRate(full);
      console.log(
        `  ${agent.displayName.padEnd(6)} inv ${fmtR(full.inventory)} | prod/turn ${prod ? fmtR(prod) : "—"} | waterInv ${fmt(full.waterProductionInvestment ?? 0)}`
      );
    }
  }
  const fallen = finalState.agents.filter((a) => a.status !== "alive");
  if (fallen.length) {
    console.log(`\n  Eliminated: ${fallen.length} — first deaths at turns: ${[
      ...new Set(fallen.map((a) => a.diedAtTurn).filter(Boolean))
    ]
      .sort((a, b) => a - b)
      .slice(0, 8)
      .map((t) => `T${t}`)
      .join(", ")}${fallen.length > 8 ? " …" : ""}`);
  }
}

async function main() {
  const maxTurns = RUN_UNTIL_FINISH ? 10_000 : 25;

  await repo.initializeDatabase();

  const metrics = {
    flowByTurn: {},
    productionByTurn: {},
    cumulativeProduction: {},
    tradeFlows: {},
    tradesByTurn: {},
    investmentByPlayer: {},
    investmentByTurn: {},
    messagingByTurn: {},
    messagingByPlayer: {},
    perPlayerByTurn: {},
    totalMessagesPublished: 0,
    turnsPlayed: 0
  };

  const gameConfig = USE_LONG
    ? mergeGameConfig({
        minAgents: PLAYER_COUNT,
        maxAgents: PLAYER_COUNT,
        negotiationDurationMs: 0,
        executionDurationMs: 0,
        maxTurns: null,
        maxGameDurationMs: null,
        survivalCostTurnIncrement: 0.51,
        survivalCostPlayerReference: 3
      })
    : { maxAgents: PLAYER_COUNT, minAgents: 3 };

  const game = await engine.createGame({ config: gameConfig });
  const gameId = game.id;
  const agents = [];

  for (const profile of PROFILES) {
    agents.push(await engine.joinGame(gameId, profile));
  }

  await engine.startGame(gameId);

  let finalState = null;
  let gameRow = await repo.getGameById(gameId);

  for (let turn = 1; turn <= maxTurns; turn++) {
    const plan = {
      messages: buildNegotiation(turn, turn <= 3 ? "bilateral trade pact" : "survival review"),
      actions: (currentAgents) => buildHeavyTradeActions(currentAgents, PROFILES, PLAYER_COUNT, turn)
    };

    finalState = await runTurn(gameId, agents, turn, plan, metrics, gameRow);
    metrics.turnsPlayed = turn;
    gameRow = await repo.getGameById(gameId);

    for (let i = 0; i < agents.length; i++) {
      agents[i] = (await repo.listAgents(gameId)).find((a) => a.id === agents[i].id);
    }

    if (finalState.game.status === "finished") break;
    if (turn % 10 === 0) {
      console.error(
        `… turn ${turn}, living ${finalState.livingAgentCount}, status ${finalState.game.status}`
      );
    }
  }

  if (!COMPACT) {
    printPerPlayerPerTurnTable(metrics, PLAYER_COUNT);
  } else {
    console.error(`(compact mode: skipping per-player per-turn table for ${PLAYER_COUNT} players)`);
  }
  printTurnFlowTable(metrics);
  await printMetrics(metrics, finalState, PLAYER_COUNT);
  await repo.closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
