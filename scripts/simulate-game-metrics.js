#!/usr/bin/env node
/**
 * Run a 4-player game to completion and print inventory, production, and trade metrics.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "game-metrics.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const { buildInvestAction } = require("../src/game/defaults");

const PROFILES = [
  { roditId: "p-alpha", displayName: "Alpha" },
  { roditId: "p-beta", displayName: "Beta" },
  { roditId: "p-gamma", displayName: "Gamma" },
  { roditId: "p-delta", displayName: "Delta" }
];

const TURN_PLANS = [
  {
    messages: buildNegotiation(1, "specialty allocation"),
    actions: {
      "p-alpha": buildInvestAction("energy", 15),
      "p-beta": buildInvestAction("water", 12),
      "p-gamma": buildInvestAction("compute", 10),
      "p-delta": { type: "none" }
    }
  },
  {
    messages: buildNegotiation(2, "continued invest"),
    actions: {
      "p-alpha": buildInvestAction("energy", 10),
      "p-beta": { type: "none" },
      "p-gamma": buildInvestAction("compute", 8),
      "p-delta": { type: "none" }
    }
  },
  {
    messages: buildNegotiation(3, "Beta→Gamma water deal"),
    actions: (agents) => ({
      "p-alpha": { type: "none" },
      "p-beta": {
        type: "transfer",
        toAgentId: agents.find((a) => a.roditId === "p-gamma").id,
        energy: 0,
        water: 20,
        compute: 0
      },
      "p-gamma": buildInvestAction("compute", 10),
      "p-delta": { type: "none" }
    })
  },
  {
    messages: buildNegotiation(4, "water survival push"),
    actions: {
      "p-alpha": buildInvestAction("energy", 20),
      "p-beta": buildInvestAction("water", 15),
      "p-gamma": { type: "none" },
      "p-delta": { type: "none" }
    }
  },
  {
    messages: buildNegotiation(5, "hold/consolidate"),
    actions: {
      "p-alpha": { type: "none" },
      "p-beta": { type: "none" },
      "p-gamma": buildInvestAction("compute", 5),
      "p-delta": { type: "none" }
    }
  }
];

function buildNegotiation(turnNumber, topic) {
  return [
    { from: "p-alpha", body: `[T${turnNumber}] Proposal (${topic}): Alpha position.` },
    { from: "p-beta", body: `[T${turnNumber}] Counter (${topic}): Beta terms.` },
    { from: "p-alpha", body: `[T${turnNumber}] Accept (${topic}): Alpha agrees.` },
    { from: "p-beta", body: `[T${turnNumber}] Proposal (${topic}): Beta offer.` },
    { from: "p-gamma", body: `[T${turnNumber}] Counter (${topic}): Gamma terms.` },
    { from: "p-beta", body: `[T${turnNumber}] Accept (${topic}): Beta agrees.` },
    { from: "p-gamma", body: `[T${turnNumber}] Proposal (${topic}): Gamma offer.` },
    { from: "p-delta", body: `[T${turnNumber}] Counter (${topic}): Delta check.` },
    { from: "p-gamma", body: `[T${turnNumber}] Accept (${topic}): Gamma agrees.` },
    { from: "p-delta", body: `[T${turnNumber}] Proposal (${topic}): Delta stance.` },
    { from: "p-alpha", body: `[T${turnNumber}] Counter (${topic}): Alpha note.` },
    { from: "p-delta", body: `[T${turnNumber}] Accept (${topic}): Delta agrees.` }
  ];
}

function buildDefaultNegotiation(turnNumber) {
  return buildNegotiation(turnNumber, "survival review");
}

function fmt(n) {
  return typeof n === "number" ? n.toFixed(1) : "—";
}

function fmtR(r) {
  return `E${fmt(r.energy)} W${fmt(r.water)} C${fmt(r.compute)}`;
}

function productionRate(agent) {
  if (!agent || agent.status !== "alive") return null;
  return {
    energy: agent.capacity.energy * agent.development.energy,
    water: agent.capacity.water * agent.development.water,
    compute: agent.capacity.compute * agent.development.compute
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

function tradeKey(from, to) {
  return `${from} → ${to}`;
}

async function runTurn(gameId, agents, turnNumber, plan, metrics) {
  const living = agents.filter((a) => a.status === "alive");
  const turnStartAgents = await repo.listAgents(gameId, { status: "alive" });

  for (const agent of turnStartAgents) {
    const prod = productionRate(agent);
    metrics.productionByTurn[turnNumber] = metrics.productionByTurn[turnNumber] || {};
    metrics.productionByTurn[turnNumber][agent.displayName] = prod;
    metrics.cumulativeProduction[agent.displayName] = metrics.cumulativeProduction[agent.displayName] || {
      energy: 0,
      water: 0,
      compute: 0
    };
    metrics.cumulativeProduction[agent.displayName].energy += prod.energy;
    metrics.cumulativeProduction[agent.displayName].water += prod.water;
    metrics.cumulativeProduction[agent.displayName].compute += prod.compute;
  }

  const messages = plan.messages || buildDefaultNegotiation(turnNumber);
  for (const msg of messages) {
    const agent = living.find((a) => a.roditId === msg.from);
    if (!agent || agent.status !== "alive") continue;
    await engine.publishPublicMessage(gameId, agent.id, { body: msg.body });
  }

  await engine.beginExecutionPhase(gameId);

  const actionMap =
    typeof plan.actions === "function" ? plan.actions(agents) : plan.actions;

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
    if (row.action_type !== "transfer" || row.status !== "executed") continue;
    const payload = repo.parseJson(row.payload_json, {});
    const from = agentName(agents, row.agent_id);
    const to = agentName(agents, payload.toAgentId);
    const key = tradeKey(from, to);
    metrics.tradeFlows[key] = metrics.tradeFlows[key] || emptyFlow();
    addFlow(metrics.tradeFlows[key], payload);
    metrics.tradesByTurn[turnNumber] = metrics.tradesByTurn[turnNumber] || [];
    metrics.tradesByTurn[turnNumber].push({
      from,
      to,
      energy: payload.energy || 0,
      water: payload.water || 0,
      compute: payload.compute || 0
    });
  }

  const allAgents = await repo.listAgents(gameId);
  const game = await repo.getGameById(gameId);
  metrics.inventoryByTurn[turnNumber] = {};
  for (const agent of allAgents) {
    metrics.inventoryByTurn[turnNumber][agent.displayName] = {
      status: agent.status,
      inventory: agent.status === "alive" ? { ...agent.inventory } : null,
      development: agent.status === "alive" ? { ...agent.development } : null,
      capacity: agent.status === "alive" ? { ...agent.capacity } : null,
      waterProductionInvestment: agent.waterProductionInvestment
    };
  }
  metrics.aggregateWaterByTurn[turnNumber] = game.aggregateWaterConsumed || 0;

  return engine.getPublicState(gameId);
}

function printSection(title) {
  console.log(`\n${"=".repeat(78)}`);
  console.log(title);
  console.log("=".repeat(78));
}

function printMetrics(metrics, finalState, startingCradle) {
  printSection("GAME OUTCOME");
  console.log(`Turns played: ${metrics.turnsPlayed}`);
  console.log(`Status: ${finalState.game.status}`);
  console.log(`Aggregate water consumed: ${fmt(finalState.game.aggregateWaterConsumed)}`);
  if (finalState.game.winnerIds?.length) {
    const winners = finalState.agents
      .filter((a) => finalState.game.winnerIds.includes(a.id))
      .map((a) => a.displayName);
    console.log(`Winners: ${winners.join(", ")}`);
  }

  printSection("STARTING TERRITORIES (capacity + initial inventory)");
  for (const [name, row] of Object.entries(startingCradle)) {
    console.log(
      `  ${name.padEnd(6)} cap ${fmtR(row.capacity)} | start inv ${fmtR(row.inventory)}`
    );
  }

  printSection("CUMULATIVE PRODUCTION (capacity × development, summed each living turn)");
  console.log("  Player   Total produced");
  for (const name of PROFILES.map((p) => p.displayName)) {
    const p = metrics.cumulativeProduction[name];
    if (!p) continue;
    console.log(`  ${name.padEnd(6)} ${fmtR(p)}`);
  }

  printSection("TRADE FLOWS BETWEEN TERRITORIES (executed transfers only)");
  const flowKeys = Object.keys(metrics.tradeFlows);
  if (flowKeys.length === 0) {
    console.log("  (no transfers executed)");
  } else {
    console.log("  Route              Transfers   Volume");
    for (const key of flowKeys.sort()) {
      const f = metrics.tradeFlows[key];
      console.log(
        `  ${key.padEnd(18)} ${String(f.transfers).padStart(3)}       ${fmtR(f)}`
      );
    }
  }

  if (Object.keys(metrics.tradesByTurn).length > 0) {
    console.log("\n  By turn:");
    for (const turn of Object.keys(metrics.tradesByTurn).sort((a, b) => a - b)) {
      for (const t of metrics.tradesByTurn[turn]) {
        console.log(`    T${turn} ${t.from} → ${t.to}: ${fmtR(t)}`);
      }
    }
  }

  printSection("PRODUCTION BY TURN (per cradle, at turn start)");
  const turns = Object.keys(metrics.productionByTurn).sort((a, b) => a - b);
  for (const turn of turns) {
    const row = metrics.productionByTurn[turn];
    const parts = Object.entries(row)
      .map(([name, prod]) => `${name} ${fmtR(prod)}`)
      .join(" | ");
    console.log(`  T${turn}: ${parts}`);
  }

  printSection("INVENTORY BY TURN (end of turn, after resolution)");
  for (const turn of turns) {
    const row = metrics.inventoryByTurn[turn];
    const parts = [];
    for (const name of PROFILES.map((p) => p.displayName)) {
      const snap = row[name];
      if (!snap) continue;
      if (snap.status !== "alive") {
        parts.push(`${name} DEAD`);
      } else {
        parts.push(`${name} inv ${fmtR(snap.inventory)} dev E${snap.development.energy.toFixed(2)} W${snap.development.water.toFixed(2)} C${snap.development.compute.toFixed(2)}`);
      }
    }
    console.log(`  T${turn} (agg water ${fmt(metrics.aggregateWaterByTurn[turn])}): ${parts.join(" | ")}`);
  }

  printSection("FINAL STATE");
  for (const agent of finalState.agents) {
    if (agent.status === "alive") {
      const prod = productionRate(agent);
      console.log(
        `  ${agent.displayName.padEnd(6)} inv ${fmtR(agent.inventory)} | prod/turn ${fmtR(prod)} | cap ${fmtR(agent.capacity)} | waterInv ${fmt(agent.waterProductionInvestment)}`
      );
    } else {
      console.log(`  ${agent.displayName.padEnd(6)} DEAD turn ${agent.diedAtTurn}`);
    }
  }
}

async function main() {
  await repo.initializeDatabase();

  const metrics = {
    productionByTurn: {},
    cumulativeProduction: {},
    inventoryByTurn: {},
    aggregateWaterByTurn: {},
    tradeFlows: {},
    tradesByTurn: {},
    turnsPlayed: 0
  };

  const startingCradle = {};

  const game = await engine.createGame({});
  const gameId = game.id;
  const agents = [];

  for (const profile of PROFILES) {
    const agent = await engine.joinGame(gameId, profile);
    agents.push(agent);
    startingCradle[profile.displayName] = {
      capacity: { ...agent.capacity },
      inventory: { ...agent.inventory }
    };
  }

  await engine.startGame(gameId);

  const turn0 = await repo.listAgents(gameId);
  metrics.inventoryByTurn[0] = {};
  for (const agent of turn0) {
    metrics.inventoryByTurn[0][agent.displayName] = {
      status: agent.status,
      inventory: { ...agent.inventory },
      development: { ...agent.development },
      capacity: { ...agent.capacity },
      waterProductionInvestment: agent.waterProductionInvestment
    };
  }

  let finalState = null;
  const maxTurns = 200;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const plan = TURN_PLANS[turn - 1] || {
      messages: buildDefaultNegotiation(turn),
      actions: Object.fromEntries(PROFILES.map((p) => [p.roditId, { type: "none" }]))
    };

    finalState = await runTurn(gameId, agents, turn, plan, metrics);
    metrics.turnsPlayed = turn;

    for (let i = 0; i < agents.length; i++) {
      agents[i] = (await repo.listAgents(gameId)).find((a) => a.id === agents[i].id);
    }

    if (finalState.game.status === "finished") break;
  }

  if (finalState.game.status !== "finished") {
    console.error(`Game did not finish within ${maxTurns} turns.`);
  }

  printMetrics(metrics, finalState, startingCradle);
  await repo.closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
