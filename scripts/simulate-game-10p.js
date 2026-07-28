#!/usr/bin/env node
/**
 * 10-player simulation: active negotiation and survival-focused investment.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(
  __dirname,
  "..",
  "data",
  process.argv.includes("--all-water") ? "game-simulation-10p-all-water.sqlite" : "game-simulation-10p.sqlite"
);
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const { computeSurvivalCost } = require("../src/game/survival-cost");
const { buildInvestAction } = require("../src/game/defaults");

const SPECIALTIES = [
  "energy",
  "water",
  "compute",
  null,
  "energy",
  "water",
  "compute",
  null,
  "water",
  "water"
];

const PROFILES = SPECIALTIES.map((specialty, i) => ({
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
}));

const RODIT_IDS = PROFILES.map((p) => p.roditId);
const PLAYER_COUNT = PROFILES.length;

function profileFor(roditId) {
  return PROFILES.find((p) => p.roditId === roditId);
}

function specialtyAction(specialty, amount) {
  if (!specialty) return { type: "none" };
  if (specialty === "energy") return buildInvestAction("energy", amount);
  if (specialty === "water") return buildInvestAction("water", amount);
  return buildInvestAction("compute", amount);
}

/** Each player sends proposal → counter → accept (3 msgs); 30 public messages per turn. */
function buildNegotiation(turnNumber, topic) {
  const kinds = ["Proposal", "Counter", "Accept"];
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

const WATER_TURN_PLANS = [
  {
    messages: buildNegotiation(1, "universal water investment pact"),
    actions: allActions(() => buildInvestAction("water", 12))
  },
  {
    messages: buildNegotiation(2, "maintain collective water investment"),
    actions: allActions(() => buildInvestAction("water", 10))
  },
  {
    messages: buildNegotiation(3, "no transfers — invest water only"),
    actions: allActions(() => buildInvestAction("water", 10))
  },
  {
    messages: buildNegotiation(4, "water survival push — all-in"),
    actions: allActions(() => buildInvestAction("water", 12))
  },
  {
    messages: buildNegotiation(5, "consolidate water margins"),
    actions: allActions(() => buildInvestAction("water", 8))
  }
];

function waterSurvivalActions(agents, game) {
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
    const waterMargin = inv.water - survival.water;
    const energyMargin = inv.energy - survival.energy;
    const computeMargin = inv.compute - survival.compute;
    const minMargin = Math.min(waterMargin, energyMargin, computeMargin);

    const amt = minMargin > 30 ? 10 : minMargin > 20 ? 8 : minMargin > 12 ? 5 : 0;
    if (amt > 0) actions[agent.roditId] = buildInvestAction("water", amt);
  }
  return actions;
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
      const waterLead = agents.find((a) => a.roditId === "t-p1" && a.status === "alive");
      const computeLead = agents.find((a) => a.roditId === "t-p2" && a.status === "alive");
      const actions = allActions(() => ({ type: "none" }));
      if (waterLead && computeLead) {
        actions["t-p1"] = {
          type: "transfer",
          toAgentId: computeLead.id,
          energy: 0,
          water: 15,
          compute: 0
        };
        actions["t-p2"] = buildInvestAction("compute", 10);
      }
      actions["t-p5"] = profileFor("t-p5").specialty
        ? specialtyAction("water", 10)
        : { type: "none" };
      actions["t-p8"] = buildInvestAction("water", 10);
      actions["t-p9"] = buildInvestAction("water", 8);
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
  const totalWaterInv = living.reduce((s, a) => s + (a.waterProductionInvestment || 0), 0);
  const equalShare = 1 / Math.max(living.length, 1);
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
    } else if (!specialty && waterMargin > 20 && totalWaterInv > 0) {
      const share = (agent.waterProductionInvestment || 0) / totalWaterInv;
      if (share < equalShare * 0.8) {
        actions[agent.roditId] = buildInvestAction("water", 5);
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
    console.log(`  ${agent.displayName.padEnd(4)} DEAD (turn ${agent.diedAtTurn})`);
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
  const role = profileFor(agent.roditId)?.role || "?";
  console.log(
    `  ${agent.displayName.padEnd(4)} [${role.padEnd(7)}] ` +
      `inv E${fmt(inv.energy)} W${fmt(inv.water)} C${fmt(inv.compute)} | ` +
      `dev E${dev.energy.toFixed(2)} W${dev.water.toFixed(2)} C${dev.compute.toFixed(2)} | ` +
      `waterInv ${fmt(agent.waterProductionInvestment)} | ` +
      `nextSurv W${fmt(survival.water)}`
  );
}

const QUIET = process.argv.includes("--quiet");
const ALL_WATER = process.argv.includes("--all-water");
const RUN_UNTIL_FINISH = process.argv[2] === "finish" || process.argv[2] === "0";
const ACTIVE_TURN_PLANS = ALL_WATER ? WATER_TURN_PLANS : TURN_PLANS;

async function runTurn(gameId, agents, turnNumber, plan) {
  const living = agents.filter((a) => a.status === "alive");
  const game = await repo.getGameById(gameId);
  const livingBefore = living.length;

  if (!QUIET) {
    console.log(`\n${"═".repeat(76)}`);
    console.log(`TURN ${turnNumber}  (growth pool: ${JSON.stringify(game.turnGrowth)})`);
    console.log(`${"═".repeat(76)}`);
    console.log(`  Negotiation: ${(plan.messages || []).length} public messages`);
  }

  for (const msg of plan.messages || []) {
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
    console.log(
      `  Living: ${livingAfter.length}/${PLAYER_COUNT} | aggregate water consumed: ${fmt(state.game.aggregateWaterConsumed)}`
    );
    for (const agent of state.agents) {
      printAgentRow(agent, gameAfter, livingAfter);
    }
  }

  return state;
}

async function main() {
  const maxTurns = RUN_UNTIL_FINISH ? 10_000 : Number(process.argv[2]) || 25;

  await repo.initializeDatabase();

  console.log("Synthetics' Last Cradle — 10-player simulation");
  console.log(`Database: ${DB_PATH}`);
  console.log(
    `Players: ${PROFILES.map((p) => `${p.displayName}(${p.role})`).join(", ")}`
  );
  console.log(
    `Mode: ${RUN_UNTIL_FINISH ? "run until ≤2 survivors" : `max ${maxTurns} turns`}${QUIET ? " (quiet)" : ""}${ALL_WATER ? " | ALL WATER focus" : ""}\n`
  );

  const game = await engine.createGame({});
  const gameId = game.id;

  const agents = [];
  for (const profile of PROFILES) {
    const agent = await engine.joinGame(gameId, profile);
    agents.push(agent);
    const inv = agent.inventory;
    const cap = agent.capacity;
    console.log(
      `  ${profile.displayName.padEnd(4)} [${profile.role.padEnd(7)}] start E${inv.energy} W${inv.water} C${inv.compute} | cap E${cap.energy} W${cap.water} C${cap.compute}`
    );
  }

  await engine.startGame(gameId);
  if (!QUIET) {
    console.log("\n=== After turn-1 production (negotiation turn 1 begins) ===");
    const state = await engine.getPublicState(gameId);
    const gameRow = await repo.getGameById(gameId);
    const livingStart = state.agents.filter((a) => a.status === "alive");
    for (const agent of state.agents) {
      printAgentRow(agent, gameRow, livingStart);
    }
  }

  let state = null;
  let gameRow = await repo.getGameById(gameId);

  for (let turn = 1; turn <= maxTurns; turn++) {
    const basePlan = ACTIVE_TURN_PLANS[turn - 1];
    const plan = basePlan || {
      messages: buildNegotiation(turn, ALL_WATER ? "water-only survival review" : "survival review"),
      actions: (currentAgents) =>
        ALL_WATER ? waterSurvivalActions(currentAgents, gameRow) : survivalActions(currentAgents, gameRow)
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
  console.log(
    `Status: ${state.game.status} | turn ${state.game.currentTurn} | living ${state.livingAgentCount}/${PLAYER_COUNT}`
  );
  const survivors = state.agents.filter((a) => a.status === "alive");
  const fallen = state.agents.filter((a) => a.status !== "alive");
  if (survivors.length) {
    console.log(`Survivors: ${survivors.map((a) => a.displayName).join(", ")}`);
  }
  if (fallen.length) {
    console.log(
      `Eliminated: ${fallen.map((a) => `${a.displayName} (turn ${a.diedAtTurn})`).join(", ")}`
    );
  }

  await repo.closeDatabase();
}

main().catch((err) => {
  console.error("Simulation failed:", err.message);
  if (err.details) console.error(err.details);
  process.exit(1);
});
