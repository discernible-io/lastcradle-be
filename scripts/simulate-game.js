#!/usr/bin/env node
/**
 * Simulates a full 5-turn Synthetics' Last Cradle game using the engine directly.
 * Uses an isolated SQLite file so it does not touch production data.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "game-simulation.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
}

process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const { buildInvestAction } = require("../src/game/defaults");

const SIM_CONFIG = {
  useRandomStartingInventory: false,
  startingInventory: { energy: 90, water: 90, compute: 90 },
  cradleCapacityMin: 40,
  cradleCapacityMax: 40,
  minAgents: 3,
  negotiationDurationMs: 60_000,
  executionDurationMs: 60_000
};

const AGENT_PROFILES = [
  { roditId: "sim-alpha", displayName: "Alpha", role: "energy investor" },
  { roditId: "sim-beta", displayName: "Beta", role: "water investor & trader" },
  { roditId: "sim-gamma", displayName: "Gamma", role: "compute investor" },
  { roditId: "sim-delta", displayName: "Delta", role: "observer" }
];

const TURN_PLANS = [
  {
    messages: [
      { from: "sim-alpha", body: "Proposing we each invest in our specialty this round." },
      { from: "sim-beta", body: "Agreed. I can spare water if anyone needs it next turn." },
      { from: "sim-delta", body: "Watching inventory levels — report honestly." }
    ],
    actions: {
      "sim-alpha": buildInvestAction("energy", 15),
      "sim-beta": buildInvestAction("water", 12),
      "sim-gamma": buildInvestAction("compute", 10),
      "sim-delta": { type: "none" }
    }
  },
  {
    messages: [
      { from: "sim-gamma", body: "Compute growth looks good. Anyone low on compute?" },
      { from: "sim-alpha", body: "Energy reserves stable for now." }
    ],
    actions: {
      "sim-alpha": buildInvestAction("energy", 10),
      "sim-beta": { type: "none" },
      "sim-gamma": buildInvestAction("compute", 8),
      "sim-delta": { type: "none" }
    }
  },
  {
    messages: [
      { from: "sim-beta", body: "Transferring water to Gamma per our deal." },
      { from: "sim-gamma", body: "Received — will invest compute proceeds." }
    ],
    actions: (agents) => ({
      "sim-alpha": { type: "none" },
      "sim-beta": {
        type: "transfer",
        toAgentId: agents.find((a) => a.roditId === "sim-gamma").id,
        energy: 0,
        water: 20,
        compute: 0
      },
      "sim-gamma": buildInvestAction("compute", 10),
      "sim-delta": { type: "none" }
    })
  },
  {
    messages: [
      { from: "sim-delta", body: "Message counts: I sent 1, received 0 this turn." },
      { from: "sim-alpha", body: "Consolidating before final stretch." }
    ],
    actions: {
      "sim-alpha": buildInvestAction("energy", 20),
      "sim-beta": buildInvestAction("water", 15),
      "sim-gamma": { type: "none" },
      "sim-delta": { type: "none" }
    }
  },
  {
    messages: [
      { from: "sim-alpha", body: "Final round — hold survival costs." },
      { from: "sim-beta", body: "All agents still alive. Good coordination." },
      { from: "sim-gamma", body: "Compute dev highest on my sheet." },
      { from: "sim-delta", body: "No actions from me this round." }
    ],
    actions: {
      "sim-alpha": { type: "none" },
      "sim-beta": { type: "none" },
      "sim-gamma": buildInvestAction("compute", 5),
      "sim-delta": { type: "none" }
    }
  }
];

function fmtInv(inv) {
  if (!inv) return "—";
  return `E:${inv.energy.toFixed(1)} W:${inv.water.toFixed(1)} C:${inv.compute.toFixed(1)}`;
}

function fmtDev(dev) {
  if (!dev) return "—";
  return `E:${dev.energy.toFixed(2)} W:${dev.water.toFixed(2)} C:${dev.compute.toFixed(2)}`;
}

function fmtCap(cap) {
  if (!cap) return "—";
  return `E:${cap.energy} W:${cap.water} C:${cap.compute}`;
}


async function runTurn(gameId, agents, turnNumber, plan) {
  const living = agents.filter((a) => a.status === "alive");

  console.log(`\n${"═".repeat(72)}`);
  console.log(`TURN ${turnNumber}`);
  console.log(`${"═".repeat(72)}`);

  const game = await repo.getGameById(gameId);
  console.log(`Phase: negotiation (turn growth pool: ${JSON.stringify(game.turnGrowth)})`);

  for (const msg of plan.messages || []) {
    const agent = living.find((a) => a.roditId === msg.from);
    if (!agent || agent.status !== "alive") continue;
    await engine.publishPublicMessage(gameId, agent.id, { body: msg.body });
    console.log(`  [msg] ${agent.displayName}: "${msg.body}"`);
  }

  await engine.beginExecutionPhase(gameId);
  console.log(`Phase: execution`);

  const actionMap =
    typeof plan.actions === "function" ? plan.actions(agents) : plan.actions;

  for (const agent of living) {
    const fresh = await repo.getAgentById(agent.id);
    if (fresh.status !== "alive") continue;
    let action = actionMap[agent.roditId] || { type: "none" };
    if (action.type === "transfer") {
      const recipient = agents.find((a) => a.id === action.toAgentId);
      if (!recipient || recipient.status !== "alive") {
        action = { type: "none" };
      }
    }
    const result = await engine.submitAction(gameId, agent.id, action);
    const label =
      action.type === "transfer"
        ? `transfer → ${agents.find((a) => a.id === action.toAgentId)?.displayName || action.toAgentId} (${fmtInv({ energy: action.energy || 0, water: action.water || 0, compute: action.compute || 0 })})`
        : action.type === "invest"
          ? `invest ${action.target} (${fmtInv({ energy: action.energy || 0, water: action.water || 0, compute: action.compute || 0 })})`
          : "none";
    console.log(`  [action] ${agent.displayName}: ${label}`);
    if (result.turnCompleted) {
      console.log(`  [turn resolved]`);
    }
  }

  const state = await engine.getPublicState(gameId);
  console.log(`\nEnd of turn ${turnNumber} — ${state.livingAgentCount} agents alive`);
  console.log(`  Aggregate water consumed: ${state.game.aggregateWaterConsumed.toFixed(1)}`);
  for (const agent of state.agents) {
    const tag = agent.status === "alive" ? "alive" : `dead (turn ${agent.diedAtTurn})`;
    const waterInv =
      agent.status === "alive" && agent.waterProductionInvestment != null
        ? ` waterInv=${agent.waterProductionInvestment.toFixed(0)}`
        : "";
    console.log(
      `  ${agent.displayName.padEnd(6)} [${tag}] inv ${fmtInv(agent.inventory)} dev ${fmtDev(agent.development)}${waterInv}`
    );
  }

  return state;
}

async function main() {
  const rounds = Number(process.argv[2]) || 5;

  await repo.initializeDatabase();

  console.log("Synthetics' Last Cradle — simulation");
  console.log(`Database: ${DB_PATH}`);
  console.log(`Agents: ${AGENT_PROFILES.map((a) => a.displayName).join(", ")}`);
  console.log(`Planned rounds: ${rounds}`);

  const game = await engine.createGame({ config: SIM_CONFIG });
  const gameId = game.id;
  console.log(`\nGame created: ${gameId} (lobby)`);

  const agents = [];
  for (const profile of AGENT_PROFILES) {
    const agent = await engine.joinGame(gameId, profile);
    agents.push(agent);
    console.log(
      `  Joined ${profile.displayName} — start ${fmtInv(agent.inventory)}, cradle ${fmtCap(agent.capacity)}`
    );
  }

  let started = await engine.startGame(gameId);
  console.log(`\nGame started — turn ${started.current_turn}, phase ${started.phase}`);
  console.log(`Turn 1 production applied.`);

  let finalState = null;
  for (let turn = 1; turn <= rounds; turn++) {
    const plan = TURN_PLANS[turn - 1] || {
      messages: [],
      actions: Object.fromEntries(agents.map((a) => [a.roditId, { type: "none" }]))
    };

    finalState = await runTurn(gameId, agents, turn, plan);

    for (let i = 0; i < agents.length; i++) {
      agents[i] = (await repo.listAgents(gameId)).find((a) => a.id === agents[i].id);
    }

    if (finalState.game.status === "finished") {
      console.log(`\nGame ended early after turn ${turn} — winners: ${finalState.game.winnerIds.join(", ")}`);
      break;
    }

    if (turn < rounds && finalState.game.currentTurn !== turn + 1) {
      console.log(`\nExpected turn ${turn + 1} but game is on turn ${finalState.game.currentTurn}`);
      break;
    }
  }

  console.log(`\n${"═".repeat(72)}`);
  console.log("FINAL SUMMARY");
  console.log(`${"═".repeat(72)}`);
  console.log(`Status: ${finalState.game.status}`);
  console.log(`Turn reached: ${finalState.game.currentTurn}`);
  console.log(`Phase: ${finalState.game.phase || "—"}`);
  if (finalState.game.winnerIds?.length) {
    const names = finalState.agents
      .filter((a) => finalState.game.winnerIds.includes(a.id))
      .map((a) => a.displayName);
    console.log(`Winners: ${names.join(", ") || finalState.game.winnerIds.join(", ")}`);
  }

  await repo.closeDatabase();
}

main().catch((err) => {
  console.error("Simulation failed:", err.message);
  if (err.details) console.error(err.details);
  process.exit(1);
});
