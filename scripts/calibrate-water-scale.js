#!/usr/bin/env node
/**
 * Find waterSurvivalGlobalConsumptionScale that yields a target average game length.
 * Usage: node scripts/calibrate-water-scale.js [players] [targetTurns] [trialsPerScale]
 */

const fs = require("fs");
const path = require("path");

const PLAYER_COUNT = Number(process.argv[2]) || 8;
const TARGET_TURNS = Number(process.argv[3]) || 30;
const TRIALS_PER_SCALE = Number(process.argv[4]) || 6;
const MAX_TURNS = 200;

process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");

const SPECIALTIES = ["energy", "water", "compute", null, "energy", "water", "compute", null];

const { buildInvestAction } = require("../src/game/defaults");

function specialtyAction(specialty) {
  if (!specialty) return { type: "none" };
  if (specialty === "energy") return buildInvestAction("energy", 12);
  if (specialty === "water") return buildInvestAction("water", 12);
  return buildInvestAction("compute", 10);
}

function resolveAction(roditId, specialty, agents, turn) {
  const index = Number(roditId.replace("player-", "")) || 0;
  if (turn % 5 === 3 && specialty === "water") {
    const recipient = agents.find((a) => a.roditId === "player-2" && a.status === "alive");
    if (recipient) {
      return { type: "transfer", toAgentId: recipient.id, energy: 0, water: 15, compute: 0 };
    }
  }
  if (turn % 4 === 0 && specialty === null && index % 2 === 0) {
    return { type: "none" };
  }
  return specialtyAction(specialty);
}

async function runTrial(scale, trialIndex) {
  const DB_PATH = path.join(__dirname, "..", "data", `calw-${trialIndex}-${Date.now()}.sqlite`);
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

  delete require.cache[require.resolve("../src/game/engine")];
  delete require.cache[require.resolve("../src/game/repository")];
  const trialEngine = require("../src/game/engine");
  const trialRepo = require("../src/game/repository");

  await trialRepo.initializeDatabase();
  const game = await trialEngine.createGame({
    config: {
      minAgents: 3,
      waterSurvivalGlobalConsumptionScale: scale
    }
  });
  const gameId = game.id;

  const profiles = [];
  for (let i = 0; i < PLAYER_COUNT; i++) {
    profiles.push({
      roditId: `player-${i}`,
      displayName: `P${i}`,
      specialty: SPECIALTIES[i % SPECIALTIES.length]
    });
  }

  let agents = [];
  for (const profile of profiles) {
    agents.push(await trialEngine.joinGame(gameId, profile));
  }
  await trialEngine.startGame(gameId);

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    agents = await trialRepo.listAgents(gameId);
    const living = agents.filter((a) => a.status === "alive");

    await trialEngine.beginExecutionPhase(gameId);
    for (const agent of living) {
      const fresh = await trialRepo.getAgentById(agent.id);
      if (fresh.status !== "alive") continue;
      const profile = profiles.find((p) => p.roditId === agent.roditId);
      let action = resolveAction(agent.roditId, profile?.specialty ?? null, agents, turn);
      if (action.type === "transfer") {
        const recip = await trialRepo.getAgentById(action.toAgentId);
        if (!recip || recip.status !== "alive") action = { type: "none" };
      }
      await trialEngine.submitAction(gameId, agent.id, action);
    }

    if ((await trialEngine.getPublicState(gameId)).game.status === "finished") {
      await trialRepo.closeDatabase();
      try {
        fs.unlinkSync(DB_PATH);
      } catch {}
      return turn;
    }
  }

  await trialRepo.closeDatabase();
  try {
    fs.unlinkSync(DB_PATH);
  } catch {}
  return null;
}

async function averageTurnsForScale(scale) {
  const results = [];
  for (let i = 0; i < TRIALS_PER_SCALE; i++) {
    results.push(await runTrial(scale, i));
  }
  const finished = results.filter((t) => t != null);
  if (finished.length === 0) return { avg: null, results, finishRate: 0 };
  const avg = finished.reduce((a, b) => a + b, 0) / finished.length;
  return { avg, results, finishRate: finished.length / TRIALS_PER_SCALE };
}

(async () => {
  console.log(
    `Calibrating waterSurvivalGlobalConsumptionScale for ${PLAYER_COUNT} players, target ~${TARGET_TURNS} turns (${TRIALS_PER_SCALE} trials/scale)\n`
  );

  let lo = 0.001;
  let hi = 0.02;
  let best = { scale: null, avg: null, diff: Infinity };

  const anchorPoints = [0.003, 0.004, 0.005, 0.006, 0.007, 0.008, 0.01, 0.015];
  console.log("Initial sweep:");
  for (const scale of anchorPoints) {
    const { avg, results, finishRate } = await averageTurnsForScale(scale);
    const label = avg == null ? "no finish" : avg.toFixed(1);
    console.log(`  scale=${scale.toFixed(4)} → avg=${label} turns [${results.join(", ")}] (${finishRate * 100}% finished)`);
    if (avg != null) {
      const diff = Math.abs(avg - TARGET_TURNS);
      if (diff < best.diff) best = { scale, avg, diff, results };
    }
  }

  console.log("\nBinary search refinement:");
  for (let step = 0; step < 8; step++) {
    const mid = (lo + hi) / 2;
    const { avg, results, finishRate } = await averageTurnsForScale(mid);
    if (avg == null) {
      console.log(`  scale=${mid.toFixed(5)} → no finish, raising lo`);
      lo = mid;
      continue;
    }
    console.log(
      `  scale=${mid.toFixed(5)} → avg=${avg.toFixed(1)} [${results.join(", ")}] (target ${TARGET_TURNS})`
    );
    const diff = Math.abs(avg - TARGET_TURNS);
    if (diff < best.diff) best = { scale: mid, avg, diff, results };

    if (avg > TARGET_TURNS) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (diff < 0.8) break;
  }

  console.log("\n--- Result ---");
  if (best.scale == null) {
    console.log("Could not find a scale that finishes games within 200 turns.");
    process.exit(1);
  }
  console.log(`Recommended waterSurvivalGlobalConsumptionScale: ${best.scale.toFixed(5)}`);
  console.log(`Observed average: ${best.avg.toFixed(1)} turns (target ${TARGET_TURNS})`);
  console.log(`Sample trials: [${best.results.join(", ")}]`);

  const confirm = await averageTurnsForScale(best.scale);
  console.log(
    `\nConfirmation run: avg=${confirm.avg?.toFixed(1)} turns [${confirm.results.join(", ")}]`
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
