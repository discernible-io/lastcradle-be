#!/usr/bin/env node
/**
 * Probe whether 100-player games can produce winners under different strategies.
 * Usage: node scripts/probe-100p-strategies.js
 */

const fs = require("fs");
const path = require("path");

process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");

const { buildInvestAction, DEFAULT_GAME_CONFIG } = require("../src/game/defaults");
const { computeSurvivalCost } = require("../src/game/survival-cost");

const PLAYER_COUNT = 100;
const SPECIALTY_CYCLE = ["energy", "water", "compute", null];

function buildProfiles() {
  return Array.from({ length: PLAYER_COUNT }, (_, i) => {
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

function makeActions(profiles, fn) {
  return Object.fromEntries(profiles.map((p) => [p.roditId, fn(p)]));
}

const STRATEGIES = {
  default: {
    label: "Default specialty (aggressive invest)",
    msgsPerPlayer: 1,
    turnActions(turn, agents, profiles, game) {
      if (turn === 1) {
        return makeActions(profiles, (p) => {
          if (p.specialty === "energy") return buildInvestAction("energy", 14);
          if (p.specialty === "water") return buildInvestAction("water", 12);
          if (p.specialty === "compute") return buildInvestAction("compute", 10);
          return buildInvestAction("water", 4);
        });
      }
      if (turn <= 5) {
        return makeActions(profiles, (p) => {
          if (p.specialty === "water") return buildInvestAction("water", 10);
          if (p.specialty === "energy" && turn <= 2) return buildInvestAction("energy", 10);
          return { type: "none" };
        });
      }
      return adaptiveSurvival(agents, profiles, game, { waterOnlyLeads: false });
    }
  },

  water_leads: {
    label: "Water specialists invest; all others hold",
    msgsPerPlayer: 1,
    turnActions(turn, agents, profiles, game) {
      return makeActions(profiles, (p) => {
        if (p.specialty !== "water") return { type: "none" };
        const agent = agents.find((a) => a.roditId === p.roditId && a.status === "alive");
        if (!agent) return { type: "none" };
        return canAffordWaterInvest(agent, game, agents, profiles, 8)
          ? buildInvestAction("water", 8)
          : { type: "none" };
      });
    }
  },

  minimal_footprint: {
    label: "Universal hold — no investment, no messages",
    msgsPerPlayer: 0,
    turnActions() {
      return makeActions(buildProfiles(), () => ({ type: "none" }));
    }
  },

  coordinated_throttle: {
    label: "Hold until A/K knee, then water leads invest lightly",
    msgsPerPlayer: 0,
    turnActions(turn, agents, profiles, game) {
      const A = game.aggregateWaterConsumed || 0;
      const K = game.config.waterSurvivalGlobalConsumptionK ?? 3000;
      if (A < K * 0.5) {
        return makeActions(profiles, () => ({ type: "none" }));
      }
      return makeActions(profiles, (p) => {
        if (p.specialty !== "water") return { type: "none" };
        const agent = agents.find((a) => a.roditId === p.roditId && a.status === "alive");
        if (!agent) return { type: "none" };
        return canAffordWaterInvest(agent, game, agents, profiles, 5)
          ? buildInvestAction("water", 5)
          : { type: "none" };
      });
    }
  },

  scaled_k_default: {
    label: "Default specialty with K scaled for 100 players",
    msgsPerPlayer: 1,
    configOverride: {
      waterSurvivalGlobalConsumptionK: Math.round(
        DEFAULT_GAME_CONFIG.waterSurvivalGlobalConsumptionK * (PLAYER_COUNT / 12)
      )
    },
    turnActions(turn, agents, profiles, game) {
      return STRATEGIES.default.turnActions(turn, agents, profiles, game);
    }
  }
};

function canAffordWaterInvest(agent, game, agents, profiles, amount) {
  const living = agents.filter((a) => a.status === "alive");
  const totalWaterInv = living.reduce((s, a) => s + (a.waterProductionInvestment || 0), 0);
  const survival = computeSurvivalCost(game.config, {
    aggregateWaterConsumed: game.aggregateWaterConsumed || 0,
    agentWaterInvestment: agent.waterProductionInvestment || 0,
    totalWaterInvestment: totalWaterInv,
    livingCount: living.length,
    energyPenalty: 0
  });
  const inv = agent.inventory;
  const margins = [inv.water - survival.water, inv.energy - survival.energy, inv.compute - survival.compute];
  return Math.min(...margins) > amount + 8;
}

function adaptiveSurvival(agents, profiles, game, { waterOnlyLeads }) {
  const living = agents.filter((a) => a.status === "alive");
  const totalWaterInv = living.reduce((s, a) => s + (a.waterProductionInvestment || 0), 0);
  const equalShare = 1 / Math.max(living.length, 1);
  return makeActions(profiles, (p) => {
    const agent = living.find((a) => a.roditId === p.roditId);
    if (!agent) return { type: "none" };
    if (waterOnlyLeads && p.specialty !== "water") return { type: "none" };

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

    if (p.specialty === "water" && waterMargin > 20 && energyMargin > 15 && computeMargin > 15) {
      return buildInvestAction("water", 6);
    }
    if (p.specialty === "energy" && energyMargin > 25) return buildInvestAction("energy", 6);
    if (p.specialty === "compute" && computeMargin > 20) return buildInvestAction("compute", 5);
    if (!p.specialty && waterMargin > 20 && totalWaterInv > 0) {
      const share = (agent.waterProductionInvestment || 0) / totalWaterInv;
      if (share < equalShare * 0.8 && energyMargin > 12 && computeMargin > 12) {
        return buildInvestAction("water", 4);
      }
    }
    return { type: "none" };
  });
}

async function runStrategy(strategyKey) {
  const strategy = STRATEGIES[strategyKey];
  const DB_PATH = path.join(__dirname, "..", "data", `probe-100p-${strategyKey}.sqlite`);
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

  delete require.cache[require.resolve("../src/game/engine")];
  delete require.cache[require.resolve("../src/game/repository")];
  const engine = require("../src/game/engine");
  const repo = require("../src/game/repository");

  const profiles = buildProfiles();
  await repo.initializeDatabase();

  const game = await engine.createGame({
    config: { maxAgents: PLAYER_COUNT, minAgents: 3, ...(strategy.configOverride || {}) }
  });
  const gameId = game.id;

  let agents = [];
  for (const profile of profiles) {
    agents.push(await engine.joinGame(gameId, profile));
  }
  await engine.startGame(gameId);

  let state = null;
  let gameRow = await repo.getGameById(gameId);
  const maxTurns = 200;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const living = agents.filter((a) => a.status === "alive");

    for (let i = 0; i < strategy.msgsPerPlayer; i++) {
      for (const agent of living) {
        await engine.publishPublicMessage(gameId, agent.id, {
          body: `[T${turn}] msg ${i + 1} from ${agent.displayName}`
        });
      }
    }

    await engine.beginMessageReportPhase(gameId);
    for (const agent of living) {
      const fresh = await repo.getAgentById(agent.id);
      if (fresh.status !== "alive") continue;
      const counts = await repo.getActualMessageCounts(gameId, turn, agent.id);
      await engine.submitMessageReport(gameId, agent.id, counts);
    }

    await engine.beginExecutionPhase(gameId);
    const actionMap = strategy.turnActions(turn, agents, profiles, gameRow);
    for (const agent of living) {
      const fresh = await repo.getAgentById(agent.id);
      if (fresh.status !== "alive") continue;
      await engine.submitAction(gameId, agent.id, actionMap[agent.roditId] || { type: "none" });
    }

    state = await engine.getPublicState(gameId);
    gameRow = await repo.getGameById(gameId);
    agents = await repo.listAgents(gameId);

    if (state.game.status === "finished") {
      await repo.closeDatabase();
      try {
        fs.unlinkSync(DB_PATH);
      } catch {}
      const winners = state.agents.filter((a) => state.game.winnerIds.includes(a.id));
      return {
        strategyKey,
        label: strategy.label,
        turn,
        living: state.livingAgentCount,
        winners: winners.map((a) => a.displayName),
        winnerRoles: winners.map((a) => profileFor(profiles, a.roditId)?.role),
        aggregateWater: gameRow.aggregateWaterConsumed,
        K: gameRow.config.waterSurvivalGlobalConsumptionK
      };
    }
  }

  await repo.closeDatabase();
  try {
    fs.unlinkSync(DB_PATH);
  } catch {}
  return {
    strategyKey,
    label: strategy.label,
    turn: maxTurns,
    living: state?.livingAgentCount ?? 0,
    winners: [],
    winnerRoles: [],
    aggregateWater: gameRow.aggregateWaterConsumed,
    K: gameRow.config.waterSurvivalGlobalConsumptionK,
    note: "no finish within 200 turns"
  };
}

(async () => {
  console.log("100-player strategy probe (environmental collapse model)\n");
  const results = [];
  for (const key of Object.keys(STRATEGIES)) {
    process.stdout.write(`  Running ${key}...`);
    const result = await runStrategy(key);
    results.push(result);
    console.log(` done (turn ${result.turn}, ${result.living} living, ${result.winners.length} winners)`);
  }

  console.log("\n--- Results ---\n");
  for (const r of results) {
    console.log(`${r.label}`);
    console.log(`  K=${r.K} | finished turn ${r.turn} | living=${r.living} | A=${r.aggregateWater?.toFixed(0)}`);
    if (r.winners.length) {
      console.log(`  Winners: ${r.winners.join(", ")} (${r.winnerRoles.join(", ")})`);
    } else if (r.living === 0) {
      console.log(`  Outcome: total extinction`);
    } else {
      console.log(`  Outcome: ${r.note || `${r.living} survivors — stalemate past turn limit`}`);
    }
    console.log();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
