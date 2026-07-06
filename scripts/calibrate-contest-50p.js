#!/usr/bin/env node
/**
 * Calibrate survival pressure for the definitive contest preset (player count from CONTEST_GAME_CONFIG).
 * Run before locking CONTEST_GAME_CONFIG rules (operator sign-off).
 *
 * Usage:
 *   node scripts/calibrate-contest-50p.js
 *   node scripts/calibrate-contest-50p.js --target=192 --trials=3
 *   node scripts/calibrate-contest-50p.js --increment=0.42
 */

const path = require("path");
const {
  cleanupSimulationArtifacts,
  prepareSimulationRun,
  disposeSimulationRun
} = require("./sim-db");

const TARGET_TURNS = Number(process.argv.find((a) => a.startsWith("--target="))?.split("=")[1]) || 192;
const TRIALS = Number(process.argv.find((a) => a.startsWith("--trials="))?.split("=")[1]) || 3;
const MAX_SIM_TURNS = Number(process.argv.find((a) => a.startsWith("--max-turns="))?.split("=")[1]) || TARGET_TURNS + 8;
const FIXED_INCREMENT = process.argv.find((a) => a.startsWith("--increment="))?.split("=")[1];
process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");

const { CONTEST_GAME_CONFIG } = require("../src/game/defaults");
const PLAYER_COUNT = CONTEST_GAME_CONFIG.maxAgents;

const SIM_CONFIG = {
  ...CONTEST_GAME_CONFIG,
  minAgents: PLAYER_COUNT,
  maxAgents: PLAYER_COUNT,
  joiningWindowDurationMs: 0,
  negotiationDurationMs: 0,
  messageReportDurationMs: 0,
  executionDurationMs: 0,
  maxTurns: null,
  maxGameDurationMs: null,
  useRandomStartingInventory: true,
  startingInventoryMin: 111,
  startingInventoryMax: 721,
  startingInventoryFloor: 111,
  startingInventoryBalanceMin: 111
};

async function runHoldStillGame(increment, trialSeed) {
  const { engine, repo } = await prepareSimulationRun();

  const game = await engine.createGame({
    config: { ...SIM_CONFIG, survivalCostTurnIncrement: increment }
  });

  for (let i = 0; i < PLAYER_COUNT; i++) {
    await engine.joinGame(game.id, {
      roditId: `c50-${trialSeed}-${i}`,
      displayName: `P${i}`
    });
  }
  await engine.startGame(game.id);

  let finishTurn = null;
  for (let turn = 1; turn <= MAX_SIM_TURNS; turn++) {
    const living = (await repo.listAgents(game.id)).filter((a) => a.status === "alive");
    if (living.length <= SIM_CONFIG.finishSurvivorCount) {
      finishTurn = turn;
      break;
    }

    await engine.beginMessageReportPhase(game.id);
    for (const agent of living) {
      await engine.submitMessageReport(game.id, agent.id, { sent: 0, received: 0 });
    }
    await engine.tryCompleteMessageReportPhase(game.id);

    for (const agent of living) {
      await engine.submitAction(game.id, agent.id, { type: "none" });
    }
    const result = await engine.tryCompleteTurn(game.id);
    if (result.game?.status === "finished") {
      finishTurn = turn;
      break;
    }
  }

  await disposeSimulationRun(repo);
  return finishTurn;
}

async function averageFinishTurn(increment) {
  const turns = [];
  for (let t = 0; t < TRIALS; t++) {
    turns.push(await runHoldStillGame(increment, t));
  }
  const valid = turns.filter((n) => n != null);
  if (valid.length === 0) return { avg: null, turns };
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  return { avg, turns };
}

async function binarySearchIncrement() {
  let lo = 0.05;
  let hi = 2.5;
  let best = { increment: SIM_CONFIG.survivalCostTurnIncrement, avg: null, delta: Infinity };

  for (let step = 0; step < 14; step++) {
    const mid = (lo + hi) / 2;
    const { avg, turns } = await averageFinishTurn(mid);
    const delta = avg == null ? Infinity : Math.abs(avg - TARGET_TURNS);
    console.log(
      `  increment=${mid.toFixed(4)} avgTurns=${avg?.toFixed(1) ?? "none"} trials=[${turns.join(",")}]`
    );
    if (delta < best.delta) {
      best = { increment: mid, avg, delta };
    }
    if (avg == null || avg > TARGET_TURNS) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

async function main() {
  cleanupSimulationArtifacts();
  console.log(`=== ${PLAYER_COUNT}-player contest survival calibration ===`);
  console.log(`Players: ${PLAYER_COUNT}`);
  console.log(`Reference: survivalCostPlayerReference=${SIM_CONFIG.survivalCostPlayerReference}`);
  console.log(`Target turns (48h @ 15min): ${TARGET_TURNS}`);
  console.log(`Trials per increment: ${TRIALS}\n`);

  if (FIXED_INCREMENT) {
    const increment = Number(FIXED_INCREMENT);
    const { avg, turns } = await averageFinishTurn(increment);
    console.log(`\nFixed increment ${increment}: avg=${avg?.toFixed(1)} turns=${turns.join(",")}`);
    process.exit(avg == null ? 1 : 0);
  }

  const best = await binarySearchIncrement();
  console.log("\n=== Recommended lock-in ===");
  console.log(`survivalCostTurnIncrement: ${best.increment.toFixed(4)}`);
  console.log(`Expected finish ~turn ${best.avg?.toFixed(1)} (target ${TARGET_TURNS})`);
  console.log(
    "\nNext: node scripts/sweep-player-finishes.js " +
      PLAYER_COUNT +
      " --increment=" +
      best.increment.toFixed(4)
  );
  console.log("      node scripts/simulate-cap50-np.js " + PLAYER_COUNT);
  console.log("\nUpdate CONTEST_GAME_CONFIG in src/game/defaults.js after operator sign-off.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
