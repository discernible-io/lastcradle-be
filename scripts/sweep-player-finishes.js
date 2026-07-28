#!/usr/bin/env node
/**
 * Measure turns to finish by starting player count.
 * Usage: node scripts/sweep-player-finishes.js [4 8 16 ...]
 */

const path = require("path");
const { cleanupSimulationArtifacts, prepareSimulationRun, disposeSimulationRun } = require("./sim-db");
const { DEFAULT_GAME_CONFIG } = require("../src/game/defaults");

const PLAYER_COUNTS = process.argv
  .slice(2)
  .filter((a) => /^\d+$/.test(a))
  .map(Number);
const COUNTS = PLAYER_COUNTS.length ? PLAYER_COUNTS : [4, 8, 16, 32, 64, 128, 256];

const MAX_TURNS = Number(process.argv.find((a) => a.startsWith("--max-turns="))?.split("=")[1]) || 200;
const INCREMENT =
  Number(process.argv.find((a) => a.startsWith("--increment="))?.split("=")[1]) ||
  DEFAULT_GAME_CONFIG.survivalCostTurnIncrement;

process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");

const SIM_CONFIG = {
  cradleCapacityMin: 20,
  cradleCapacityMax: 50,
  maxProductionCapacity: { energy: 50, water: 50, compute: 50 },
  maxStorageCapacity: { energy: 50, water: 50, compute: 50 },
  survivalCost: { energy: 10, water: 10, compute: 10 },
  survivalCostTurnIncrement: INCREMENT,
  survivalCostPlayerReference: DEFAULT_GAME_CONFIG.survivalCostPlayerReference,
  finishSurvivorCount: 2,
  useRandomStartingInventory: true,
  startingInventoryMin: 40,
  startingInventoryMax: 80,
  startingInventoryFloor: 40,
  startingInventoryBalanceMin: 45
};

async function runOnce(playerCount) {
  const { engine, repo } = await prepareSimulationRun();

  const game = await engine.createGame({
    config: {
      ...SIM_CONFIG,
      minAgents: 3,
      maxAgents: playerCount
    }
  });

  for (let i = 0; i < playerCount; i++) {
    await engine.joinGame(game.id, { roditId: `s-${playerCount}-p${i}`, displayName: `P${i}` });
  }
  await engine.startGame(game.id);

  let agents = await repo.listAgents(game.id);
  let finishTurn = null;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const living = agents.filter((a) => a.status === "alive");
    if (living.length <= SIM_CONFIG.finishSurvivorCount) {
      finishTurn = turn - 1 || 1;
      break;
    }

    await engine.beginExecutionPhase(game.id);
    for (const agent of living) {
      await engine.submitAction(game.id, agent.id, { type: "none" });
    }

    const gameRow = await repo.getGameById(game.id);
    if (gameRow.status === "finished") {
      finishTurn = turn;
      break;
    }

    agents = await repo.listAgents(game.id);
  }

  const finalGame = await repo.getGameById(game.id);
  const survivors = (await repo.listAgents(game.id)).filter((a) => a.status === "alive").length;

  await disposeSimulationRun(repo);

  return {
    playerCount,
    finishTurn: finishTurn ?? MAX_TURNS,
    finished: finalGame?.status === "finished",
    survivors,
    hitCap: finalGame?.status !== "finished"
  };
}

async function main() {
  cleanupSimulationArtifacts();

  console.log(`Turns to finish (≤${SIM_CONFIG.finishSurvivorCount} survivors)`);
  console.log(
    `increment=${INCREMENT}, reference=${SIM_CONFIG.survivalCostPlayerReference}, maxTurns=${MAX_TURNS}\n`
  );
  console.log("Players | Turns | Status");
  console.log("--------|-------|--------");

  const results = [];
  for (const n of COUNTS) {
    const start = Date.now();
    process.stdout.write(`  running ${n}p...`);
    const r = await runOnce(n);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(`\r`);
    const status = r.finished ? "finished" : `cap @ ${MAX_TURNS} (${r.survivors} alive)`;
    console.log(
      `${String(n).padStart(7)} | ${String(r.finishTurn).padStart(5)} | ${status} (${elapsed}s)`
    );
    results.push(r);
  }

  cleanupSimulationArtifacts();
  return results;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
