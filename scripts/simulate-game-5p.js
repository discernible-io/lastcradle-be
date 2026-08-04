#!/usr/bin/env node
/**
 * 5-cradle simulation: active negotiation (proposal/counter/accept per turn)
 * and investment strategies aimed at maximizing survival.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "game-simulation-5p.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const { computeSurvivalCost } = require("../src/game/survival-cost");
const { buildInvestAction } = require("../src/game/defaults");

const PROFILES = [
  { roditId: "t-alpha", displayName: "Alpha", role: "energy lead" },
  { roditId: "t-beta", displayName: "Beta", role: "water lead" },
  { roditId: "t-gamma", displayName: "Gamma", role: "compute lead" },
  { roditId: "t-delta", displayName: "Delta", role: "trader / reserve" },
  { roditId: "t-epsilon", displayName: "Epsilon", role: "water survival hedge" }
];

const RODIT_IDS = PROFILES.map((p) => p.roditId);

/** Each cradle sends proposal → counter → accept (3 msgs) per turn; 15 public messages total. */
function buildNegotiation(turnNumber, topic) {
  const chain = [
    ["t-alpha", "Proposal"],
    ["t-beta", "Counter"],
    ["t-alpha", "Accept"],
    ["t-beta", "Proposal"],
    ["t-gamma", "Counter"],
    ["t-beta", "Accept"],
    ["t-gamma", "Proposal"],
    ["t-delta", "Counter"],
    ["t-gamma", "Accept"],
    ["t-delta", "Proposal"],
    ["t-epsilon", "Counter"],
    ["t-delta", "Accept"],
    ["t-epsilon", "Proposal"],
    ["t-alpha", "Counter"],
    ["t-epsilon", "Accept"]
  ];
  return chain.map(([from, kind]) => ({
    from,
    body: `[T${turnNumber}] ${kind} (${topic}): ${PROFILES.find((p) => p.roditId === from).displayName} position.`
  }));
}

const TURN_PLANS = [
  {
    messages: buildNegotiation(1, "specialty allocation for survival"),
    actions: {
      "t-alpha": buildInvestAction("energy", 15),
      "t-beta": buildInvestAction("water", 14),
      "t-gamma": buildInvestAction("compute", 12),
      "t-delta": buildInvestAction("energy", 5),
      "t-epsilon": buildInvestAction("water", 10)
    }
  },
  {
    messages: buildNegotiation(2, "sustain water investment share"),
    actions: {
      "t-alpha": buildInvestAction("energy", 10),
      "t-beta": buildInvestAction("water", 12),
      "t-gamma": buildInvestAction("compute", 8),
      "t-delta": { type: "none" },
      "t-epsilon": buildInvestAction("water", 8)
    }
  },
  {
    messages: buildNegotiation(3, "Beta→Gamma water swap for compute growth"),
    actions: (agents) => ({
      "t-alpha": { type: "none" },
      "t-beta": {
        type: "transfer",
        toAgentId: agents.find((a) => a.roditId === "t-gamma").id,
        energy: 0,
        water: 18,
        compute: 0
      },
      "t-gamma": buildInvestAction("compute", 10),
      "t-delta": {
        type: "transfer",
        toAgentId: agents.find((a) => a.roditId === "t-epsilon").id,
        energy: 10,
        water: 0,
        compute: 0
      },
      "t-epsilon": buildInvestAction("water", 12)
    })
  },
  {
    messages: buildNegotiation(4, "water survival push — global consumption rising"),
    actions: {
      "t-alpha": buildInvestAction("energy", 18),
      "t-beta": buildInvestAction("water", 16),
      "t-gamma": { type: "none" },
      "t-delta": buildInvestAction("water", 6),
      "t-epsilon": buildInvestAction("water", 14)
    }
  },
  {
    messages: buildNegotiation(5, "consolidate margins before cost spike"),
    actions: {
      "t-alpha": { type: "none" },
      "t-beta": buildInvestAction("water", 8),
      "t-gamma": buildInvestAction("compute", 5),
      "t-delta": { type: "none" },
      "t-epsilon": buildInvestAction("water", 6)
    }
  }
];

function survivalActions(agents, game) {
  const living = agents.filter((a) => a.status === "alive");
  const totalWaterInv = living.reduce((s, a) => s + (a.waterProductionInvestment || 0), 0);
  const actions = Object.fromEntries(RODIT_IDS.map((id) => [id, { type: "none" }]));

  for (const agent of living) {
    const survival = computeSurvivalCost(game.config, {
      aggregateWaterConsumed: game.aggregateWaterConsumed || 0,
      agentWaterInvestment: agent.waterProductionInvestment || 0,
      totalWaterInvestment: totalWaterInv,
      livingCount: living.length,
      energyPenalty: 0
    });
    const inv = agent.inventory;
    const roditId = agent.roditId;

    const waterMargin = inv.water - survival.water;
    const energyMargin = inv.energy - survival.energy;
    const computeMargin = inv.compute - survival.compute;

    if (roditId === "t-beta" || roditId === "t-epsilon") {
      const amt = waterMargin > 25 ? 10 : waterMargin > 15 ? 6 : 0;
      if (amt > 0) actions[roditId] = buildInvestAction("water", amt);
    } else if (roditId === "t-alpha" && energyMargin > 20) {
      actions[roditId] = buildInvestAction("energy", 8);
    } else if (roditId === "t-gamma" && computeMargin > 18) {
      actions[roditId] = buildInvestAction("compute", 6);
    } else if (roditId === "t-delta") {
      if (waterMargin > 20 && totalWaterInv > 0) {
        const share = (agent.waterProductionInvestment || 0) / totalWaterInv;
        if (share < 0.12) actions[roditId] = buildInvestAction("water", 5);
      }
    }
  }
  return actions;
}

function fmt(n) {
  return typeof n === "number" ? n.toFixed(1) : "—";
}

function printAgentRow(agent, game, livingAgents) {
  if (agent.status !== "alive") {
    console.log(`  ${agent.displayName.padEnd(8)} DEAD (turn ${agent.diedAtTurn})`);
    return;
  }
  const survival = computeSurvivalCost(game.config, {
    aggregateWaterConsumed: game.aggregateWaterConsumed || 0,
    agentWaterInvestment: agent.waterProductionInvestment || 0,
    totalWaterInvestment: livingAgents.reduce((s, a) => s + (a.waterProductionInvestment || 0), 0),
    livingCount: livingAgents.length,
    energyPenalty: 0
  });
  const inv = agent.inventory;
  const dev = agent.development;
  console.log(
    `  ${agent.displayName.padEnd(8)} ` +
      `inv E${fmt(inv.energy)} W${fmt(inv.water)} C${fmt(inv.compute)} | ` +
      `dev E${dev.energy.toFixed(2)} W${dev.water.toFixed(2)} C${dev.compute.toFixed(2)} | ` +
      `waterInv ${fmt(agent.waterProductionInvestment)} | ` +
      `nextSurv E${fmt(survival.energy)} W${fmt(survival.water)} C${fmt(survival.compute)}`
  );
}

const QUIET = process.argv.includes("--quiet");
const RUN_UNTIL_FINISH = process.argv[2] === "finish" || process.argv[2] === "0";

async function runTurn(gameId, agents, turnNumber, plan) {
  const living = agents.filter((a) => a.status === "alive");
  const game = await repo.getGameById(gameId);
  const livingBefore = living.length;

  if (!QUIET) {
    console.log(`\n${"═".repeat(76)}`);
    console.log(`TURN ${turnNumber}  (growth pool: ${JSON.stringify(game.turnGrowth)})`);
    console.log(`${"═".repeat(76)}`);
  }

  const messages = plan.messages || [];
  if (!QUIET) console.log(`  Negotiation: ${messages.length} public messages`);

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
    if (!QUIET) {
      const label =
        action.type === "transfer"
          ? `transfer → ${agents.find((a) => a.id === action.toAgentId)?.displayName}`
          : action.type === "invest_production" ||
              action.type === "invest_storage" ||
              action.type === "invest"
            ? `invest ${action.target} (E/W/C ${action.energy})`
            : "hold";
      console.log(`  [action] ${agent.displayName}: ${label}`);
    }
  }

  const state = await engine.getPublicState(gameId);
  const gameAfter = await repo.getGameById(gameId);
  const livingAfter = state.agents.filter((a) => a.status === "alive");

  if (QUIET) {
    if (livingAfter.length < livingBefore) {
      const deadThisTurn = state.agents.filter(
        (a) => a.status !== "alive" && a.diedAtTurn === turnNumber
      );
      console.log(
        `Turn ${turnNumber}: ${livingAfter.length} living — eliminated ${deadThisTurn.map((a) => a.displayName).join(", ")}`
      );
    } else if (turnNumber % 50 === 0) {
      console.log(
        `Turn ${turnNumber}: ${livingAfter.length} living | aggregate water ${fmt(state.game.aggregateWaterConsumed)}`
      );
    }
  } else {
    console.log(`  Living: ${livingAfter.length}/5 | aggregate water consumed: ${fmt(state.game.aggregateWaterConsumed)}`);
    for (const agent of state.agents) {
      printAgentRow(agent, gameAfter, livingAfter);
    }
  }

  return state;
}

async function main() {
  const maxTurns = RUN_UNTIL_FINISH ? 10_000 : Number(process.argv[2]) || 25;

  await repo.initializeDatabase();

  console.log("Synthetics' Last Cradle — 5-cradle simulation");
  console.log(`Database: ${DB_PATH}`);
  console.log(`Cradles: ${PROFILES.map((p) => `${p.displayName} (${p.role})`).join(", ")}`);
  console.log(`Mode: ${RUN_UNTIL_FINISH ? "run until ≤2 survivors" : `max ${maxTurns} turns`}${QUIET ? " (quiet)" : ""}\n`);

  const game = await engine.createGame({});
  const gameId = game.id;

  const agents = [];
  for (const profile of PROFILES) {
    const agent = await engine.joinGame(gameId, profile);
    agents.push(agent);
    const inv = agent.inventory;
    const cap = agent.capacity;
    console.log(
      `  ${profile.displayName.padEnd(8)} start E${inv.energy} W${inv.water} C${inv.compute} | cap E${cap.energy} W${cap.water} C${cap.compute}`
    );
  }

  await engine.startGame(gameId);
  console.log("\n=== After turn-1 production (negotiation turn 1 begins) ===");
  let state = await engine.getPublicState(gameId);
  let gameRow = await repo.getGameById(gameId);
  const livingStart = state.agents.filter((a) => a.status === "alive");
  for (const agent of state.agents) {
    printAgentRow(agent, gameRow, livingStart);
  }

  for (let turn = 1; turn <= maxTurns; turn++) {
    const basePlan = TURN_PLANS[turn - 1];
    const plan = basePlan || {
      messages: buildNegotiation(turn, "survival review"),
      actions: (currentAgents) => survivalActions(currentAgents, gameRow)
    };

    state = await runTurn(gameId, agents, turn, plan);
    gameRow = await repo.getGameById(gameId);

    for (let i = 0; i < agents.length; i++) {
      agents[i] = (await repo.listAgents(gameId)).find((a) => a.id === agents[i].id);
    }

    if (state.game.status === "finished") {
      const winners = state.agents
        .filter((a) => state.game.winnerIds.includes(a.id))
        .map((a) => a.displayName);
      console.log(`\n${"═".repeat(76)}`);
      console.log(`GAME FINISHED after turn ${turn}`);
      console.log(`Winners (${winners.length}): ${winners.join(", ") || "—"}`);
      break;
    }
  }

  console.log(`\n${"═".repeat(76)}`);
  console.log("FINAL SUMMARY");
  console.log(`${"═".repeat(76)}`);
  console.log(`Status: ${state.game.status} | turn ${state.game.currentTurn} | living ${state.livingAgentCount}/5`);
  const survivors = state.agents.filter((a) => a.status === "alive");
  const fallen = state.agents.filter((a) => a.status !== "alive");
  if (survivors.length) {
    console.log(`Survivors: ${survivors.map((a) => a.displayName).join(", ")}`);
  }
  if (fallen.length) {
    console.log(`Eliminated: ${fallen.map((a) => `${a.displayName} (turn ${a.diedAtTurn})`).join(", ")}`);
  }

  await repo.closeDatabase();
}

main().catch((err) => {
  console.error("Simulation failed:", err.message);
  if (err.details) console.error(err.details);
  process.exit(1);
});
