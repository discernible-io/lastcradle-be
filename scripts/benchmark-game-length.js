#!/usr/bin/env node
/**
 * Benchmark average game length with N players using current engine defaults.
 * Each turn targets floor(players / 2) transfers plus specialty investment.
 * Usage: node scripts/benchmark-game-length.js [players] [trials]
 *        node scripts/benchmark-game-length.js sweep [trials]
 */

const { cleanupSimulationArtifacts, prepareSimulationRun, disposeSimulationRun } = require("./sim-db");
const { DEFAULT_GAME_CONFIG } = require("../src/game/defaults");
const { buildHeavyTradeActions, tradesTargetFor } = require("./sim-trading");

const SWEEP_MODE = process.argv[2] === "sweep";
const PLAYER_COUNT = SWEEP_MODE ? null : Number(process.argv[2]) || 8;
const TRIALS = Number(SWEEP_MODE ? process.argv[3] : process.argv[3]) || 10;
const MAX_TURNS = 500;
const SWEEP_COUNTS = [4, 8, 16, 32];

function formatElapsed(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildRunPlan(counts, trials) {
  const sorted = [...counts].sort((a, b) => a - b);
  const segments = sorted.map((n) => `${n}p×${trials}`);
  return {
    counts: sorted,
    totalSims: sorted.length * trials,
    label: segments.join(", ")
  };
}

process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = require("path").join(__dirname, "..", "config");

const SPECIALTY_CYCLE = ["energy", "water", "compute", null];

function profilesFor(playerCount) {
  return Array.from({ length: playerCount }, (_, i) => {
    const specialty = SPECIALTY_CYCLE[i % SPECIALTY_CYCLE.length];
    return {
      roditId: `player-${i}`,
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
}

async function runTrial(playerCount, trialIndex) {
  const { engine, repo } = await prepareSimulationRun();
  const profiles = profilesFor(playerCount);

  const game = await engine.createGame({
    config: { minAgents: 3, maxAgents: playerCount }
  });
  const gameId = game.id;

  let agents = [];
  for (const profile of profiles) {
    agents.push(await engine.joinGame(gameId, profile));
  }
  await engine.startGame(gameId);

  let tradesExecuted = 0;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    agents = await repo.listAgents(gameId);
    const living = agents.filter((a) => a.status === "alive");

    await engine.beginMessageReportPhase(gameId);
    for (const agent of living) {
      const counts = await repo.getActualMessageCounts(gameId, turn, agent.id);
      await engine.submitMessageReport(gameId, agent.id, counts);
    }

    await engine.beginExecutionPhase(gameId);
    const actionMap = buildHeavyTradeActions(agents, profiles, playerCount, turn);

    for (const agent of living) {
      const fresh = await repo.getAgentById(agent.id);
      if (fresh.status !== "alive") continue;
      let action = actionMap[agent.roditId] || { type: "none" };
      if (action.type === "transfer") {
        const recip = await repo.getAgentById(action.toAgentId);
        if (!recip || recip.status !== "alive" || recip.id === agent.id) {
          action = { type: "none" };
        }
      }
      await engine.submitAction(gameId, agent.id, action);
    }

    const turnActions = await repo.listTurnActions(gameId, turn);
    tradesExecuted += turnActions.filter(
      (row) => row.action_type === "transfer" && row.status === "executed"
    ).length;

    const game = await repo.getGameById(gameId);
    if (game.status === "finished") {
      await disposeSimulationRun(repo);
      return { turns: turn, tradesExecuted, finished: true };
    }
  }

  await disposeSimulationRun(repo);
  return { turns: MAX_TURNS, tradesExecuted, finished: false };
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
    median
  };
}

async function benchmarkPlayerCount(playerCount, trials, progress) {
  const tradeTarget = tradesTargetFor(playerCount);
  console.log(`\n${"─".repeat(60)}`);
  console.log(`${playerCount} players | ${trials} trials | ${tradeTarget} trades/turn target`);
  console.log(`${"─".repeat(60)}`);

  const results = [];
  let totalTrades = 0;

  for (let i = 0; i < trials; i++) {
    progress.current += 1;
    const globalLabel = `[${progress.current}/${progress.total}]`;
    const trialLabel = `${playerCount}p trial ${i + 1}/${trials}`;
    console.log(`  ${globalLabel} starting ${trialLabel}...`);
    const startedAt = Date.now();

    const result = await runTrial(playerCount, i);
    results.push(result);
    totalTrades += result.tradesExecuted;

    const finishLabel = result.finished ? `finished turn ${result.turns}` : `cap @ ${MAX_TURNS}`;
    console.log(
      `  ${globalLabel} done ${trialLabel}: ${finishLabel} | ${result.tradesExecuted} trades | ${formatElapsed(Date.now() - startedAt)}`
    );
  }

  const finished = results.filter((r) => r.finished);
  if (finished.length === 0) {
    console.log(`  No games finished within ${MAX_TURNS} turns.`);
    return { playerCount, tradeTarget, finished: 0, trials };
  }

  const turns = finished.map((r) => r.turns);
  const s = stats(turns);
  const avgTrades = totalTrades / trials;
  console.log(`  Block summary (${playerCount}p): ${finished.length}/${trials} finished`);
  console.log(`  Average turns: ${s.avg.toFixed(1)}`);
  console.log(`  Median turns:  ${s.median.toFixed(1)}`);
  console.log(`  Range:         ${s.min} – ${s.max}`);
  console.log(`  Avg trades/game: ${avgTrades.toFixed(0)} (${tradeTarget}/turn target)`);
  if (finished.length < trials) {
    console.log(`  Unfinished:    ${trials - finished.length} trial(s) hit ${MAX_TURNS}-turn cap`);
  }

  return {
    playerCount,
    tradeTarget,
    finished: finished.length,
    trials,
    avgTurns: s.avg,
    medianTurns: s.median,
    minTurns: s.min,
    maxTurns: s.max,
    avgTrades
  };
}

(async () => {
  cleanupSimulationArtifacts();

  const cfg = DEFAULT_GAME_CONFIG;
  console.log("Synthetics' Last Cradle — length benchmark");
  console.log(
    `Config: survival base ${cfg.survivalCost.energy}/${cfg.survivalCost.water}/${cfg.survivalCost.compute}, ` +
      `increment ${cfg.survivalCostTurnIncrement}, prod energy rate ${cfg.productionEnergyCostRate}, ` +
      `storage water rate ${cfg.storageWaterCostRate}, storage cap ${cfg.maxStorageCapacity.energy}`
  );
  console.log(`Trials per count: ${TRIALS} | max turns: ${MAX_TURNS}`);

  const plan = buildRunPlan(SWEEP_MODE ? SWEEP_COUNTS : [PLAYER_COUNT], TRIALS);
  console.log(
    `Run plan (${plan.totalSims} simulations, shortest first): ${plan.label}`
  );

  const progress = { current: 0, total: plan.totalSims };
  const summary = [];
  const sweepStartedAt = Date.now();

  for (const n of plan.counts) {
    summary.push(await benchmarkPlayerCount(n, TRIALS, progress));
  }

  console.log(`\nTotal benchmark time: ${formatElapsed(Date.now() - sweepStartedAt)}`);

  if (summary.length > 1) {
    console.log(`\n${"=".repeat(60)}`);
    console.log("SUMMARY");
    console.log(`${"=".repeat(60)}`);
    console.log("Players | Trades/t | Avg turns | Median | Range");
    console.log("--------|----------|-----------|--------|------");
    for (const row of summary) {
      if (!row.avgTurns) {
        console.log(`${String(row.playerCount).padStart(7)} | ${String(row.tradeTarget).padStart(8)} | — unfinished —`);
        continue;
      }
      console.log(
        `${String(row.playerCount).padStart(7)} | ${String(row.tradeTarget).padStart(8)} | ` +
          `${row.avgTurns.toFixed(1).padStart(9)} | ${row.medianTurns.toFixed(1).padStart(6)} | ` +
          `${row.minTurns}–${row.maxTurns}`
      );
    }
  }

  cleanupSimulationArtifacts();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
