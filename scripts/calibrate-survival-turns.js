#!/usr/bin/env node
/**
 * Calibrate survivalCostTurnIncrement so low-player games end near a target turn count.
 * Runs hold-still simulations (no invest/transfer) until one survivor remains.
 *
 * Usage:
 *   node scripts/calibrate-survival-turns.js              # calibrate then sweep 3,6,12,24,48
 *   node scripts/calibrate-survival-turns.js --increment 0.65
 *   node scripts/calibrate-survival-turns.js --target 30 --trials 5
 */

const path = require("path");
const {
  cleanupSimulationArtifacts,
  prepareSimulationRun,
  disposeSimulationRun
} = require("./sim-db");

const TARGET_TURNS = Number(process.argv.find((a) => a.startsWith("--target="))?.split("=")[1]) || 30;
const TRIALS = Number(process.argv.find((a) => a.startsWith("--trials="))?.split("=")[1]) || 5;
const MAX_SIM_TURNS = Number(process.argv.find((a) => a.startsWith("--max-turns="))?.split("=")[1]) || 31;
const FIXED_INCREMENT = process.argv.find((a) => a.startsWith("--increment="))?.split("=")[1];
const SWEEP = process.argv.includes("--sweep")
  ? process.argv
      .slice(process.argv.indexOf("--sweep") + 1)
      .filter((a) => /^\d+$/.test(a))
      .map(Number)
  : [3, 6, 12, 24, 48];

process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");

const SIM_CONFIG = {
  cradleCapacityMin: 20,
  cradleCapacityMax: 50,
  maxProductionCapacity: { energy: 50, water: 50, compute: 50 },
  maxStorageCapacity: { energy: 50, water: 50, compute: 50 },
  survivalCost: { energy: 10, water: 10, compute: 10 },
  finishSurvivorCount: 1,
  useRandomStartingInventory: true,
  startingInventoryMin: 40,
  startingInventoryMax: 80,
  startingInventoryFloor: 40,
  startingInventoryBalanceMin: 45
};

async function runGame(playerCount, increment, trialSeed) {
  const { engine, repo } = await prepareSimulationRun();

  const game = await engine.createGame({
    config: {
      ...SIM_CONFIG,
      survivalCostTurnIncrement: increment,
      minAgents: 3,
      maxAgents: playerCount
    }
  });

  for (let i = 0; i < playerCount; i++) {
    await engine.joinGame(game.id, {
      roditId: `p-${trialSeed}-${i}`,
      displayName: `P${i}`
    });
  }
  await engine.startGame(game.id);

  let agents = await repo.listAgents(game.id);
  let finishTurn = null;
  let finished = false;

  for (let turn = 1; turn <= MAX_SIM_TURNS; turn++) {
    const living = agents.filter((a) => a.status === "alive");
    if (living.length <= 1) {
      finishTurn = turn;
      finished = true;
      break;
    }

    await engine.beginExecutionPhase(game.id);
    for (const agent of living) {
      await engine.submitAction(game.id, agent.id, { type: "none" });
    }

    const gameRow = await repo.getGameById(game.id);
    if (gameRow.status === "finished") {
      finishTurn = turn;
      finished = true;
      break;
    }

    agents = await repo.listAgents(game.id);
    const aliveNow = agents.filter((a) => a.status === "alive").length;
    if (aliveNow <= 1) {
      finishTurn = turn;
      finished = true;
      break;
    }
  }

  const finalGame = await repo.getGameById(game.id);
  const finalAgents = await repo.listAgents(game.id);
  const survivors = finalAgents.filter((a) => a.status === "alive").length;

  await disposeSimulationRun(repo);

  return {
    finishTurn: finishTurn ?? MAX_SIM_TURNS,
    survivors,
    finished: finished || finalGame?.status === "finished",
    hitCap: !finished && survivors > 1
  };
}

async function averageTurnsFor(playerCount, increment, trials) {
  const results = [];
  for (let t = 0; t < trials; t++) {
    results.push(await runGame(playerCount, increment, t));
  }
  const turns = results.map((r) => r.finishTurn);
  const avg = turns.reduce((a, b) => a + b, 0) / turns.length;
  const capped = results.filter((r) => r.hitCap).length;
  return { avg, turns, capped, results };
}

async function calibrateIncrement() {
  let lo = 0.05;
  let hi = 1.5;
  let best = { increment: 0.65, error: Infinity, avg: 0, turns: [] };

  console.log(`Calibrating survivalCostTurnIncrement for ~${TARGET_TURNS} turns (${TRIALS} trials @ 3 players, max ${MAX_SIM_TURNS} turns)...\n`);

  for (let step = 0; step < 12; step++) {
    const mid = (lo + hi) / 2;
    const { avg, turns, capped } = await averageTurnsFor(3, mid, TRIALS);
    const allCapped = capped === TRIALS;
    const effectiveAvg = allCapped ? TARGET_TURNS + 1 : avg;
    const error = Math.abs(effectiveAvg - TARGET_TURNS);
    console.log(
      `  inc=${mid.toFixed(3)} → avg ${avg.toFixed(1)} turns (samples: ${turns.join(", ")}${capped ? `, ${capped}/${TRIALS} hit cap` : ""})`
    );
    if (!allCapped && error < best.error) {
      best = { increment: mid, error, avg, turns };
    }
    if (allCapped || avg > TARGET_TURNS) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  console.log(
    `\nChosen increment: ${best.increment.toFixed(3)} (avg ${best.avg.toFixed(1)} turns at 3p)\n`
  );
  return best.increment;
}

async function sweepCounts(increment, counts) {
  console.log(`${"─".repeat(72)}`);
  console.log(`Player sweep @ survivalCostTurnIncrement=${increment.toFixed(3)}`);
  console.log(`${"─".repeat(72)}`);
  console.log("Players | Avg turns to 1 survivor | Sample turns");
  console.log("--------|-------------------------|-------------");

  const summary = [];
  for (const n of counts) {
    const trials = n <= 12 ? TRIALS : Math.min(TRIALS, 3);
    const { avg, turns, capped } = await averageTurnsFor(n, increment, trials);
    summary.push({ players: n, avg, turns, trials, capped });
    const capNote = capped ? ` (${capped}/${trials} hit ${MAX_SIM_TURNS}-turn cap)` : "";
    console.log(
      `${String(n).padStart(7)} | ${avg.toFixed(1).padStart(23)} | ${turns.join(", ")}${capNote}`
    );
  }

  return summary;
}

async function main() {
  const cleaned = cleanupSimulationArtifacts();
  if (cleaned.removed > 0) {
    console.log(
      `Cleaned ${cleaned.removed} old simulation DB file(s) (${(cleaned.bytesFreed / 1024 / 1024).toFixed(1)} MB freed)\n`
    );
  }

  const increment = FIXED_INCREMENT ? Number(FIXED_INCREMENT) : await calibrateIncrement();
  const summary = await sweepCounts(increment, SWEEP);

  console.log(`\n${"═".repeat(72)}`);
  console.log("RECOMMENDED CONFIG");
  console.log(`${"═".repeat(72)}`);
  console.log(`  survivalCostTurnIncrement: ${increment.toFixed(3)}`);
  console.log(`  survivalCost: { energy: 10, water: 10, compute: 10 }`);
  console.log(`  (turn N cost per resource ≈ 10 + (N-1) × ${increment.toFixed(3)})`);
  console.log(`\nAt turn 30: ~${(10 + 29 * increment).toFixed(1)} E/W/C each`);

  cleanupSimulationArtifacts();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
