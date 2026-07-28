#!/usr/bin/env node
/**
 * N-player simulation with capacity cap — runs until ≤2 survivors.
 * Tracks transfers and turn count.
 *
 * Usage:
 *   node scripts/simulate-cap50-np.js 10
 *   node scripts/simulate-cap50-np.js 100
 *   node scripts/simulate-cap50-np.js 10 100
 */

const path = require("path");
const {
  cleanupSimulationArtifacts,
  prepareSimulationRun,
  disposeSimulationRun
} = require("./sim-db");

const CAP = 50;
const CAP_CONFIG = {
  maxProductionCapacity: { energy: CAP, water: CAP, compute: CAP },
  maxStorageCapacity: { energy: CAP, water: CAP, compute: CAP },
  cradleCapacityMin: 20,
  cradleCapacityMax: CAP,
  minAgents: 3
};

const PLAYER_COUNTS = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
if (!PLAYER_COUNTS.length) PLAYER_COUNTS.push(10, 100);
const MAX_SIM_TURNS = Number(process.argv.find((a) => a.startsWith("--max-turns="))?.split("=")[1]) || 31;

process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");

const { buildInvestAction } = require("../src/game/defaults");
const { computeSurvivalCost } = require("../src/game/survival-cost");

const SPECIALTY_CYCLE = ["energy", "water", "compute", null];

function buildProfiles(playerCount) {
  return Array.from({ length: playerCount }, (_, i) => {
    const specialty = SPECIALTY_CYCLE[i % SPECIALTY_CYCLE.length];
    return {
      roditId: `t-p${i}`,
      displayName: `P${i}`,
      specialty,
      role: specialty || "reserve"
    };
  });
}

function profileFor(profiles, roditId) {
  return profiles.find((p) => p.roditId === roditId);
}

function specialtyAction(specialty, amount) {
  if (!specialty) return { type: "none" };
  return buildInvestAction(specialty, amount);
}

function buildNegotiation(profiles, turnNumber, topic) {
  const messages = [];
  for (const profile of profiles) {
    messages.push({
      from: profile.roditId,
      body: `[T${turnNumber}] Proposal (${topic}): ${profile.displayName}.`
    });
  }
  return messages;
}

function allActions(profiles, fn) {
  return Object.fromEntries(profiles.map((p) => [p.roditId, fn(p.roditId)]));
}

function firstAliveWithSpecialty(agents, profiles, specialty) {
  return agents.find(
    (a) => a.status === "alive" && profileFor(profiles, a.roditId)?.specialty === specialty
  );
}

function survivalMargin(agent, config) {
  const survival = computeSurvivalCost(config, {});
  const inv = agent.inventory;
  return Math.min(
    inv.energy - survival.energy,
    inv.water - survival.water,
    inv.compute - survival.compute
  );
}

function buildTurnPlans(profiles) {
  const roditIds = profiles.map((p) => p.roditId);

  return [
    {
      messages: buildNegotiation(profiles, 1, "specialty allocation"),
      actions: allActions(profiles, (id) => {
        const s = profileFor(profiles, id).specialty;
        if (s === "energy") return specialtyAction(s, 8);
        if (s === "water") return specialtyAction(s, 8);
        if (s === "compute") return specialtyAction(s, 6);
        return buildInvestAction("water", 3);
      })
    },
    {
      messages: buildNegotiation(profiles, 2, "sustain investment"),
      actions: allActions(profiles, (id) => {
        const s = profileFor(profiles, id).specialty;
        if (s === "energy") return specialtyAction(s, 6);
        if (s === "water") return specialtyAction(s, 6);
        if (s === "compute") return specialtyAction(s, 5);
        return { type: "none" };
      })
    },
    {
      messages: buildNegotiation(profiles, 3, "water-for-compute bilateral"),
      actions: (agents) => {
        const waterLead = firstAliveWithSpecialty(agents, profiles, "water");
        const computeLead = firstAliveWithSpecialty(agents, profiles, "compute");
        const actions = Object.fromEntries(roditIds.map((id) => [id, { type: "none" }]));
        if (waterLead && computeLead) {
          actions[waterLead.roditId] = {
            type: "transfer",
            toAgentId: computeLead.id,
            energy: 0,
            water: 10,
            compute: 0
          };
          actions[computeLead.roditId] = buildInvestAction("compute", 6);
        }
        for (const agent of agents) {
          if (agent.status !== "alive") continue;
          const s = profileFor(profiles, agent.roditId)?.specialty;
          if (s === "water" && actions[agent.roditId]?.type === "none") {
            actions[agent.roditId] = buildInvestAction("water", 5);
          }
        }
        return actions;
      }
    },
    {
      messages: buildNegotiation(profiles, 4, "survival push"),
      actions: allActions(profiles, (id) => {
        const s = profileFor(profiles, id).specialty;
        if (s === "water") return specialtyAction(s, 8);
        if (s === "energy") return specialtyAction(s, 8);
        return { type: "none" };
      })
    },
    {
      messages: buildNegotiation(profiles, 5, "consolidate"),
      actions: allActions(profiles, (id) => {
        const s = profileFor(profiles, id).specialty;
        if (s === "water") return specialtyAction(s, 5);
        if (s === "compute") return specialtyAction(s, 4);
        return { type: "none" };
      })
    }
  ];
}

function adaptiveActions(agents, profiles, config) {
  const actions = Object.fromEntries(profiles.map((p) => [p.roditId, { type: "none" }]));
  for (const agent of agents) {
    if (agent.status !== "alive") continue;
    const margin = survivalMargin(agent, config);
    const specialty = profileFor(profiles, agent.roditId)?.specialty;
    if (margin <= 8) continue;
    if (specialty === "water") {
      actions[agent.roditId] = buildInvestAction("water", margin > 20 ? 6 : 4);
    } else if (specialty === "energy" && margin > 15) {
      actions[agent.roditId] = buildInvestAction("energy", 5);
    } else if (specialty === "compute" && margin > 12) {
      actions[agent.roditId] = buildInvestAction("compute", 4);
    }
  }
  return actions;
}

async function countExecutedTransfers(gameId, repo) {
  const database = await repo.getDb();
  const rows = await database.all(
    `SELECT payload_json, status FROM game_actions WHERE game_id = ? AND action_type = 'transfer'`,
    [gameId]
  );
  let attempted = 0;
  let executed = 0;
  let failed = 0;
  const details = [];
  for (const row of rows) {
    attempted++;
    const payload = repo.parseJson(row.payload_json, {});
    if (row.status === "executed") {
      executed++;
      details.push({
        energy: payload.energy || 0,
        water: payload.water || 0,
        compute: payload.compute || 0
      });
    } else if (row.status === "failed") {
      failed++;
    }
  }
  return { attempted, executed, failed, details };
}

async function runSimulation(playerCount) {
  const { engine, repo } = await prepareSimulationRun();

  const profiles = buildProfiles(playerCount);
  const turnPlans = buildTurnPlans(profiles);

  const game = await engine.createGame({
    config: { ...CAP_CONFIG, maxAgents: playerCount }
  });
  const gameId = game.id;

  for (const profile of profiles) {
    await engine.joinGame(gameId, profile);
  }
  await engine.startGame(gameId);

  let agents = await repo.listAgents(gameId);
  let lastTurn = 0;
  let finishedTurn = null;
  let hitCap = false;

  for (let turn = 1; turn <= MAX_SIM_TURNS; turn++) {
    lastTurn = turn;
    const living = agents.filter((a) => a.status === "alive");
    if (living.length <= 2) break;

    const basePlan = turnPlans[turn - 1];
    const plan = basePlan || {
      messages: buildNegotiation(profiles, turn, "survival review"),
      actions: (current) => adaptiveActions(current, profiles, CAP_CONFIG)
    };

    for (const msg of plan.messages || []) {
      if (playerCount > 25) break;
      const agent = living.find((a) => a.roditId === msg.from);
      if (agent) await engine.publishPublicMessage(gameId, agent.id, { body: msg.body });
    }

    await engine.beginExecutionPhase(gameId);
    const actionMap =
      typeof plan.actions === "function" ? plan.actions(agents) : plan.actions;

    for (const agent of living) {
      let action = actionMap[agent.roditId] || { type: "none" };
      if (action.type === "transfer") {
        const recipient = agents.find((a) => a.id === action.toAgentId);
        if (!recipient || recipient.status !== "alive") action = { type: "none" };
      }
      await engine.submitAction(gameId, agent.id, action);
    }

    const gameRow = await repo.getGameById(gameId);
    if (gameRow.status === "finished") {
      finishedTurn = turn;
      break;
    }

    agents = await repo.listAgents(gameId);

    if (playerCount >= 50 && turn % 50 === 0) {
      const alive = agents.filter((a) => a.status === "alive").length;
      process.stdout.write(`  [${playerCount}p] turn ${turn}: ${alive} living\n`);
    }
  }

  if (!finishedTurn && lastTurn >= MAX_SIM_TURNS) {
    hitCap = true;
  }

  const finalGame = await repo.getGameById(gameId);
  const finalAgents = await repo.listAgents(gameId);
  const transfers = await countExecutedTransfers(gameId, repo);
  const survivors = finalAgents.filter((a) => a.status === "alive");
  const fallen = finalAgents.filter((a) => a.status !== "alive");

  const deathByTurn = fallen.reduce((acc, a) => {
    const t = a.diedAtTurn ?? "?";
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {});

  await disposeSimulationRun(repo);

  return {
    playerCount,
    cap: CAP,
    status: finalGame.status,
    turnsPlayed: finishedTurn ?? lastTurn,
    finished: finalGame.status === "finished",
    hitCap,
    survivors: survivors.length,
    winnerNames: survivors.map((a) => a.displayName),
    eliminated: fallen.length,
    deathByTurn,
    transfers
  };
}

function printResult(result) {
  console.log(`Status:           ${result.status}`);
  console.log(
    `Turns played:     ${result.turnsPlayed}${result.finished ? " (game finished)" : result.hitCap ? ` (stopped at ${MAX_SIM_TURNS}-turn cap)` : ""}`
  );
  console.log(`Survivors:        ${result.survivors} / ${result.playerCount}`);
  if (result.winnerNames.length && result.winnerNames.length <= 10) {
    console.log(`Winners:          ${result.winnerNames.join(", ")}`);
  } else if (result.winnerNames.length) {
    console.log(
      `Winners:          ${result.winnerNames.slice(0, 8).join(", ")} … +${result.winnerNames.length - 8} more`
    );
  }
  console.log(`Eliminated:       ${result.eliminated}`);
  if (Object.keys(result.deathByTurn).length) {
    const peaks = Object.entries(result.deathByTurn)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([t, n]) => `T${t}:${n}`)
      .join(", ");
    console.log(`Deaths by turn:   ${peaks}`);
  }
  console.log(
    `Transfers:        ${result.transfers.executed} executed / ${result.transfers.attempted} attempted (${result.transfers.failed} failed)`
  );
  if (result.transfers.executed > 0) {
    const totalWater = result.transfers.details.reduce((s, t) => s + t.water, 0);
    const totalEnergy = result.transfers.details.reduce((s, t) => s + t.energy, 0);
    const totalCompute = result.transfers.details.reduce((s, t) => s + t.compute, 0);
    console.log(`Trade volume:     E${totalEnergy} W${totalWater} C${totalCompute}`);
  } else {
    console.log("Trade volume:     none");
  }
}

async function main() {
  const cleaned = cleanupSimulationArtifacts();
  if (cleaned.removed > 0) {
    console.log(
      `Cleaned ${cleaned.removed} old simulation DB file(s) (${(cleaned.bytesFreed / 1024 / 1024).toFixed(1)} MB freed)`
    );
  }
  console.log(`Capacity cap: ${CAP} | Sim max turns: ${MAX_SIM_TURNS}\n`);

  for (const count of PLAYER_COUNTS) {
    console.log(`${"═".repeat(60)}`);
    console.log(`${count}-PLAYER SIMULATION`);
    console.log(`${"═".repeat(60)}`);
    const result = await runSimulation(count);
    printResult(result);
    console.log("");
  }

  cleanupSimulationArtifacts();
}

main().catch((err) => {
  console.error("Simulation failed:", err);
  process.exit(1);
});
