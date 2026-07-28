#!/usr/bin/env node
/**
 * Calibrate energy survival knobs for target average game length.
 * Water budget pressure is disabled so eliminations reflect energy tuning, not water exhaustion.
 * Usage: node scripts/calibrate-energy-survival.js [players] [targetTurns] [trialsPerPoint]
 */

const fs = require("fs");
const path = require("path");

const PLAYER_COUNT = Number(process.argv[2]) || 20;
const TARGET_TURNS = Number(process.argv[3]) || 30;
const TRIALS_PER_POINT = Number(process.argv[4]) || 8;
const MAX_TURNS = 200;
const MSGS_PER_PLAYER = PLAYER_COUNT > 25 ? 1 : 3;

process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");

const { buildInvestAction } = require("../src/game/defaults");
const { computeSurvivalCost, buildSurvivalContext } = require("../src/game/survival-cost");

/** Isolate energy pressure: flat water survival, no global water budget. */
const ENERGY_CALIBRATION_CONFIG = {
  waterSurvivalBudgetEnabled: false
};

const SPECIALTY_CYCLE = ["energy", "water", "compute", null];

function buildProfiles(count) {
  return Array.from({ length: count }, (_, i) => {
    const specialty = SPECIALTY_CYCLE[i % SPECIALTY_CYCLE.length];
    return {
      roditId: `t-p${i}`,
      displayName: `P${i}`,
      specialty
    };
  });
}

function buildNegotiation(profiles, turnNumber, topic) {
  const kinds = MSGS_PER_PLAYER === 1 ? ["Proposal"] : ["Proposal", "Counter", "Accept"];
  const messages = [];
  for (const profile of profiles) {
    for (const kind of kinds) {
      messages.push({
        from: profile.roditId,
        body: `[T${turnNumber}] ${kind} (${topic}): ${profile.displayName}.`
      });
    }
  }
  return messages;
}

function profileFor(profiles, roditId) {
  return profiles.find((p) => p.roditId === roditId);
}

function specialtyAction(specialty, amount) {
  if (!specialty) return { type: "none" };
  if (specialty === "energy") return buildInvestAction("energy", amount);
  if (specialty === "water") return buildInvestAction("water", amount);
  return buildInvestAction("compute", amount);
}

function allActions(profiles, fn) {
  return Object.fromEntries(profiles.map((p) => [p.roditId, fn(p.roditId)]));
}

function firstAliveWithSpecialty(profiles, agents, specialty) {
  return agents.find((a) => a.status === "alive" && profileFor(profiles, a.roditId)?.specialty === specialty);
}

function buildTurnPlans(profiles) {
  return [
    {
      messages: buildNegotiation(profiles, 1, "specialty allocation"),
      actions: allActions(profiles, (id) => {
        const s = profileFor(profiles, id).specialty;
        if (s === "energy") return specialtyAction(s, 14);
        if (s === "water") return specialtyAction(s, 12);
        if (s === "compute") return specialtyAction(s, 10);
        return buildInvestAction("water", 4);
      })
    },
    {
      messages: buildNegotiation(profiles, 2, "sustain investment"),
      actions: allActions(profiles, (id) => {
        const s = profileFor(profiles, id).specialty;
        if (s === "energy") return specialtyAction(s, 10);
        if (s === "water") return specialtyAction(s, 10);
        if (s === "compute") return specialtyAction(s, 8);
        return { type: "none" };
      })
    },
    {
      messages: buildNegotiation(profiles, 3, "bilateral deals"),
      actions: (agents) => {
        const waterLead = firstAliveWithSpecialty(profiles, agents, "water");
        const computeLead = firstAliveWithSpecialty(profiles, agents, "compute");
        const actions = allActions(profiles, () => ({ type: "none" }));
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
        return actions;
      }
    },
    {
      messages: buildNegotiation(profiles, 4, "survival push"),
      actions: allActions(profiles, (id) => {
        const s = profileFor(profiles, id).specialty;
        if (s === "water") return specialtyAction(s, 14);
        if (s === "energy") return specialtyAction(s, 15);
        return { type: "none" };
      })
    },
    {
      messages: buildNegotiation(profiles, 5, "consolidate"),
      actions: allActions(profiles, (id) => {
        const s = profileFor(profiles, id).specialty;
        if (s === "water") return specialtyAction(s, 8);
        if (s === "compute") return specialtyAction(s, 5);
        return { type: "none" };
      })
    }
  ];
}

function survivalActions(profiles, agents, game) {
  const living = agents.filter((a) => a.status === "alive");
  const actions = allActions(profiles, () => ({ type: "none" }));
  const survivalContext = buildSurvivalContext({
    config: game.config,
    game,
    livingAgents: living,
    turnNumber: game.current_turn
  });

  for (const agent of living) {
    const survival = computeSurvivalCost(game.config, survivalContext);
    const inv = agent.inventory;
    const specialty = profileFor(profiles, agent.roditId)?.specialty;
    const energyMargin = inv.energy - survival.energy;
    const computeMargin = inv.compute - survival.compute;
    const waterMargin = inv.water - survival.water;

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

function classifyElimination(inventory, survivalCost) {
  const shortfalls = [
    { leg: "energy", gap: survivalCost.energy - inventory.energy },
    { leg: "water", gap: survivalCost.water - inventory.water },
    { leg: "compute", gap: survivalCost.compute - inventory.compute }
  ].filter((s) => s.gap > 0);

  if (shortfalls.length === 0) {
    return "unknown";
  }
  shortfalls.sort((a, b) => b.gap - a.gap);
  return shortfalls[0].leg;
}

async function runTrial(energyConfig, trialIndex, profiles, turnPlans) {
  const DB_PATH = path.join(__dirname, "..", "data", `cale-${trialIndex}-${Date.now()}.sqlite`);
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

  delete require.cache[require.resolve("../src/game/engine")];
  delete require.cache[require.resolve("../src/game/repository")];
  const trialEngine = require("../src/game/engine");
  const trialRepo = require("../src/game/repository");

  const deathCauses = { energy: 0, water: 0, compute: 0, unknown: 0 };

  await trialRepo.initializeDatabase();
  const game = await trialEngine.createGame({
    config: {
      minAgents: 3,
      maxAgents: PLAYER_COUNT,
      ...ENERGY_CALIBRATION_CONFIG,
      ...energyConfig
    }
  });
  const gameId = game.id;

  for (const profile of profiles) {
    await trialEngine.joinGame(gameId, profile);
  }
  await trialEngine.startGame(gameId);

  let agents = await trialRepo.listAgents(gameId);
  let gameRow = await trialRepo.getGameById(gameId);

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const living = agents.filter((a) => a.status === "alive");
    const basePlan = turnPlans[turn - 1];
    const plan = basePlan || {
      messages: buildNegotiation(profiles, turn, "survival review"),
      actions: (currentAgents) => survivalActions(profiles, currentAgents, gameRow)
    };

    for (const msg of plan.messages || []) {
      const agent = living.find((a) => a.roditId === msg.from);
      if (!agent || agent.status !== "alive") continue;
      await trialEngine.publishPublicMessage(gameId, agent.id, { body: msg.body });
    }

    await trialEngine.beginExecutionPhase(gameId);
    const preExecution = new Map();
    for (const agent of living) {
      const fresh = await trialRepo.getAgentById(agent.id);
      if (fresh.status !== "alive") continue;
      preExecution.set(agent.id, { ...fresh.inventory });
    }

    const actionMap = typeof plan.actions === "function" ? plan.actions(agents) : plan.actions;
    for (const agent of living) {
      const fresh = await trialRepo.getAgentById(agent.id);
      if (fresh.status !== "alive") continue;
      let action = actionMap[agent.roditId] || { type: "none" };
      if (action.type === "transfer") {
        const recipient = agents.find((a) => a.id === action.toAgentId);
        if (!recipient || recipient.status !== "alive") action = { type: "none" };
      }
      await trialEngine.submitAction(gameId, agent.id, action);
    }

    gameRow = await trialRepo.getGameById(gameId);
    agents = await trialRepo.listAgents(gameId);

    const survivalContext = buildSurvivalContext({
      config: gameRow.config,
      game: gameRow,
      livingAgents: living,
      turnNumber: turn
    });

    for (const agent of living) {
      const after = agents.find((a) => a.id === agent.id);
      if (!after || after.status === "alive") continue;
      if (after.diedAtTurn !== turn) continue;
      const inventory = preExecution.get(agent.id);
      if (!inventory) continue;
      const survival = computeSurvivalCost(gameRow.config, survivalContext);
      const cause = classifyElimination(inventory, survival);
      deathCauses[cause] = (deathCauses[cause] || 0) + 1;
    }

    const state = await trialEngine.getPublicState(gameId);
    if (state.game.status === "finished") {
      await trialRepo.closeDatabase();
      try {
        fs.unlinkSync(DB_PATH);
      } catch {}
      return { turn, deathCauses };
    }
  }

  await trialRepo.closeDatabase();
  try {
    fs.unlinkSync(DB_PATH);
  } catch {}
  return { turn: null, deathCauses };
}

function avg(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function mergeDeathCauses(totals, row) {
  for (const [leg, count] of Object.entries(row)) {
    totals[leg] = (totals[leg] || 0) + count;
  }
}

async function scoreConfig(energyConfig, profiles, turnPlans) {
  const trials = Number(process.env.CALIB_TRIALS) || TRIALS_PER_POINT;
  const turns = [];
  const deathCauses = { energy: 0, water: 0, compute: 0, unknown: 0 };
  for (let i = 0; i < trials; i++) {
    const result = await runTrial(energyConfig, i, profiles, turnPlans);
    if (result.turn != null) turns.push(result.turn);
    mergeDeathCauses(deathCauses, result.deathCauses);
  }
  if (turns.length === 0) {
    return { avg: MAX_TURNS + 1, finished: 0, turns, deathCauses };
  }
  return {
    avg: avg(turns),
    finished: turns.length,
    turns,
    min: Math.min(...turns),
    max: Math.max(...turns),
    deathCauses
  };
}

async function main() {
  const profiles = buildProfiles(PLAYER_COUNT);
  const turnPlans = buildTurnPlans(profiles);

  console.log(
    `Calibrating energy survival for ${PLAYER_COUNT} players, target ~${TARGET_TURNS} turns (${TRIALS_PER_POINT} trials/point)`
  );
  console.log(
    "Water budget disabled for calibration (flat water survival only — no global water exhaustion).\n"
  );

  const candidates = [];
  for (const base of [5, 8, 10]) {
    for (const lead of [-0.2, -0.15, -0.1, -0.05, 0]) {
      for (const inc of [0.02, 0.03, 0.04, 0.05, 0.06, 0.08]) {
        candidates.push({
          energySurvivalProductionLead: lead,
          energySurvivalTurnIncrement: inc,
          survivalCost: { energy: base, water: 10, compute: 10 }
        });
      }
    }
  }

  let best = null;
  for (const cfg of candidates) {
    const result = await scoreConfig(cfg, profiles, turnPlans);
    const err = Math.abs(result.avg - TARGET_TURNS);
    const dc = result.deathCauses;
    const row = { ...cfg, ...result, err };
    console.log(
      `base=${cfg.survivalCost.energy} lead=${cfg.energySurvivalProductionLead.toFixed(2)} inc=${cfg.energySurvivalTurnIncrement.toFixed(2)} → ` +
        `avg=${result.avg.toFixed(1)} (${result.finished}/${TRIALS_PER_POINT}, ${result.min ?? "—"}–${result.max ?? "—"}) ` +
        `deaths E${dc.energy}/W${dc.water}/C${dc.compute}`
    );
    if (!best || err < best.err || (err === best.err && dc.water < best.deathCauses.water)) {
      best = row;
    }
  }

  console.log(`\nBest match (target ${TARGET_TURNS}):`);
  console.log(`  survivalCost.energy:          ${best.survivalCost.energy}`);
  console.log(`  energySurvivalProductionLead: ${best.energySurvivalProductionLead}`);
  console.log(`  energySurvivalTurnIncrement:  ${best.energySurvivalTurnIncrement}`);
  console.log(`  average turns: ${best.avg.toFixed(1)} (err ${best.err.toFixed(1)})`);
  console.log(`  range: ${best.min} – ${best.max} over ${best.finished} trials`);
  console.log(
    `  elimination causes: energy=${best.deathCauses.energy} water=${best.deathCauses.water} compute=${best.deathCauses.compute} unknown=${best.deathCauses.unknown}`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  PLAYER_COUNT,
  TRIALS_PER_POINT,
  ENERGY_CALIBRATION_CONFIG,
  buildProfiles,
  buildTurnPlans,
  scoreConfig
};
