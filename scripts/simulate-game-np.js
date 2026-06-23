#!/usr/bin/env node
/**
 * N-player simulation: active negotiation and survival-focused investment.
 * Usage: node scripts/simulate-game-np.js <players> [finish] [--quiet] [--all-water]
 */

const fs = require("fs");
const path = require("path");

const PLAYER_COUNT = Math.max(3, Number(process.argv.find((a) => /^\d+$/.test(a))) || 10);
const QUIET = process.argv.includes("--quiet");
const ALL_WATER = process.argv.includes("--all-water");
const RUN_UNTIL_FINISH = process.argv.includes("finish");
const MSGS_PER_PLAYER = PLAYER_COUNT > 25 ? 1 : 3;

const DB_PATH = path.join(
  __dirname,
  "..",
  "data",
  `game-simulation-${PLAYER_COUNT}p${ALL_WATER ? "-all-water" : ""}.sqlite`
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
  const kinds =
    MSGS_PER_PLAYER === 1
      ? ["Proposal"]
      : ["Proposal", "Counter", "Accept"];
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
    const minMargin = Math.min(
      inv.water - survival.water,
      inv.energy - survival.energy,
      inv.compute - survival.compute
    );
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

const ACTIVE_TURN_PLANS = ALL_WATER ? WATER_TURN_PLANS : TURN_PLANS;

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

function formatNameList(names, max = 12) {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} … +${names.length - max} more`;
}

async function runTurn(gameId, agents, turnNumber, plan) {
  const living = agents.filter((a) => a.status === "alive");
  const livingBefore = living.length;

  for (const msg of plan.messages || []) {
    const agent = living.find((a) => a.roditId === msg.from);
    if (!agent || agent.status !== "alive") continue;
    await engine.publishPublicMessage(gameId, agent.id, { body: msg.body });
  }

  await engine.beginMessageReportPhase(gameId);
  for (const agent of living) {
    const fresh = await repo.getAgentById(agent.id);
    if (fresh.status !== "alive") continue;
    const counts = await repo.getActualMessageCounts(gameId, turnNumber, agent.id);
    await engine.submitMessageReport(gameId, agent.id, counts);
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
  const livingAfter = state.agents.filter((a) => a.status === "alive");

  if (livingAfter.length < livingBefore) {
    const deadThisTurn = state.agents.filter(
      (a) => a.status !== "alive" && a.diedAtTurn === turnNumber
    );
    console.log(
      `Turn ${turnNumber}: ${livingAfter.length} living — eliminated ${deadThisTurn.length} (${formatNameList(deadThisTurn.map((a) => a.displayName))})`
    );
  } else if (turnNumber % 25 === 0) {
    console.log(
      `Turn ${turnNumber}: ${livingAfter.length} living | aggregate water ${fmt(state.game.aggregateWaterConsumed)}`
    );
  }

  return state;
}

async function main() {
  const maxTurns = RUN_UNTIL_FINISH ? 10_000 : 25;
  const roleCounts = PROFILES.reduce((acc, p) => {
    acc[p.role] = (acc[p.role] || 0) + 1;
    return acc;
  }, {});

  await repo.initializeDatabase();

  console.log(`Bargain Against Entropy — ${PLAYER_COUNT}-player simulation`);
  console.log(`Database: ${DB_PATH}`);
  console.log(
    `Roster: ${Object.entries(roleCounts)
      .map(([r, n]) => `${n} ${r}`)
      .join(", ")}`
  );
  console.log(
    `Messages/turn: ${MSGS_PER_PLAYER * PLAYER_COUNT} (${MSGS_PER_PLAYER} per player)`
  );
  console.log(`Trade target: ${tradesTargetFor(PLAYER_COUNT)}/turn (floor(players / 2))`);
  console.log(
    `Mode: ${RUN_UNTIL_FINISH ? "run until ≤2 survivors" : `max ${maxTurns} turns`}${ALL_WATER ? " | ALL WATER" : ""}\n`
  );

  const game = await engine.createGame({
    config: { maxAgents: PLAYER_COUNT, minAgents: 3 }
  });
  const gameId = game.id;

  const agents = [];
  for (const profile of PROFILES) {
    agents.push(await engine.joinGame(gameId, profile));
  }
  console.log(`Joined ${agents.length} cradles.`);

  await engine.startGame(gameId);
  console.log("Turn 1 production applied.\n");

  let state = null;
  let gameRow = await repo.getGameById(gameId);

  for (let turn = 1; turn <= maxTurns; turn++) {
    const plan = ALL_WATER
      ? ACTIVE_TURN_PLANS[turn - 1] || {
          messages: buildNegotiation(turn, "water-only survival review"),
          actions: (currentAgents) => waterSurvivalActions(currentAgents, gameRow)
        }
      : {
          messages: buildNegotiation(turn, turn <= 3 ? "bilateral trade pact" : "survival review"),
          actions: (currentAgents) =>
            buildHeavyTradeActions(currentAgents, PROFILES, PLAYER_COUNT, turn)
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
      console.log(`Winners (${winners.length}): ${formatNameList(winners, 20) || "—"}`);
      break;
    }
  }

  console.log(`\n${"═".repeat(76)}`);
  console.log("FINAL SUMMARY");
  console.log(`${"═".repeat(76)}`);
  console.log(
    `Status: ${state.game.status} | turn ${state.game.currentTurn} | living ${state.livingAgentCount}/${PLAYER_COUNT}`
  );
  console.log(`Aggregate water consumed: ${fmt(state.game.aggregateWaterConsumed)}`);

  const survivors = state.agents.filter((a) => a.status === "alive");
  const fallen = state.agents.filter((a) => a.status !== "alive");
  if (survivors.length) {
    console.log(`Survivors (${survivors.length}): ${formatNameList(survivors.map((a) => a.displayName), 20)}`);
  }
  if (fallen.length) {
    const byTurn = fallen.reduce((acc, a) => {
      const t = a.diedAtTurn ?? "?";
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {});
    console.log(
      `Eliminated: ${fallen.length} total — by turn: ${Object.entries(byTurn)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([t, n]) => `T${t}:${n}`)
        .join(", ")}`
    );
  }

  await repo.closeDatabase();
}

main().catch((err) => {
  console.error("Simulation failed:", err.message);
  if (err.details) console.error(err.details);
  process.exit(1);
});
