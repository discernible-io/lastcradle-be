#!/usr/bin/env node
/**
 * Local verification: capacity-relative starting inventory + fill-ratio scout for 15 players.
 *
 * Usage:
 *   node scripts/test-capacity-relative-15p.js
 */

const path = require("path");
const {
  cleanupSimulationArtifacts,
  prepareSimulationRun,
  disposeSimulationRun
} = require("./sim-db");

process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");

const { CONTEST_GAME_CONFIG, mergeGameConfig } = require("../src/game/defaults");

const PLAYER_COUNT = 15;
const RESOURCE_KEYS = ["energy", "water", "compute"];

function fmtTriple(t) {
  return `E${t.energy} W${t.water} C${t.compute}`;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  cleanupSimulationArtifacts();
  const dbPath = path.join(__dirname, "..", "data", "capacity-relative-15p.sqlite");
  const { engine, repo } = await prepareSimulationRun({ dbPath });

  const config = mergeGameConfig({
    ...CONTEST_GAME_CONFIG,
    minAgents: PLAYER_COUNT,
    maxAgents: PLAYER_COUNT,
    joiningWindowDurationMs: 0,
    negotiationDurationMs: 0,
    executionDurationMs: 0,
    maxTurns: null,
    maxGameDurationMs: null
  });

  const game = await engine.createGame({ config });

  for (let i = 0; i < PLAYER_COUNT; i++) {
    await engine.joinGame(game.id, {
      roditId: `cap15-${i}`,
      displayName: `P${i}`
    });
  }

  const beforeStart = await repo.listAgents(game.id);
  assert(beforeStart.length === PLAYER_COUNT, `expected ${PLAYER_COUNT} agents`);

  console.log("Opening cradles (pre-production):");
  let overCapacity = 0;
  let minFill = Infinity;
  let maxFill = -Infinity;
  let expectedScout = beforeStart[0];
  let expectedScoutFill = engine.inventoryFillRatio(expectedScout);

  for (const agent of beforeStart) {
    const fill = engine.inventoryFillRatio(agent);
    minFill = Math.min(minFill, fill);
    maxFill = Math.max(maxFill, fill);
    if (fill < expectedScoutFill) {
      expectedScout = agent;
      expectedScoutFill = fill;
    }

    for (const key of RESOURCE_KEYS) {
      if (agent.inventory[key] > agent.storageCapacity[key]) {
        overCapacity += 1;
      }
      assert(
        agent.inventory[key] <= agent.storageCapacity[key],
        `${agent.displayName} ${key} inventory ${agent.inventory[key]} exceeds storage ${agent.storageCapacity[key]}`
      );
      const ratio = agent.storageCapacity[key]
        ? agent.inventory[key] / agent.storageCapacity[key]
        : 0;
      assert(
        ratio <= (config.startingInventoryFillMax ?? 1) + 1e-9,
        `${agent.displayName} ${key} fill ${ratio.toFixed(3)} above max ${config.startingInventoryFillMax}`
      );
    }

    console.log(
      `  ${agent.displayName.padEnd(4)} cap ${fmtTriple(agent.storageCapacity)} | ` +
        `inv ${fmtTriple(agent.inventory)} | fill ${(fill * 100).toFixed(1)}%`
    );
  }

  assert(overCapacity === 0, "no cradle should start over storage capacity");
  assert(minFill >= (config.startingInventoryFillMin ?? 0) - 0.05, "fills should be near configured min");
  assert(maxFill <= (config.startingInventoryFillMax ?? 1) + 0.02, "fills should be near configured max");

  await engine.startGame(game.id);

  const scoutView = await engine.getPublicState(game.id, {
    viewerAgentId: expectedScout.id
  });
  assert(scoutView.openingInventoryReport, "lowest-fill cradle should receive scout report");
  assert(
    scoutView.openingInventoryReport.scoutAgentId === expectedScout.id,
    `scout should be ${expectedScout.displayName}`
  );
  assert(
    scoutView.openingInventoryReport.agents.length === PLAYER_COUNT,
    "scout report should list all 15 cradles"
  );
  assert(
    scoutView.openingInventoryReport.agents.every((row) => typeof row.fillRatio === "number"),
    "scout report rows should include fillRatio"
  );

  const other = beforeStart.find((a) => a.id !== expectedScout.id);
  const otherView = await engine.getPublicState(game.id, { viewerAgentId: other.id });
  assert(!otherView.openingInventoryReport, "non-scout must not receive opening inventory report");

  const afterProduction = await repo.listAgents(game.id);
  let stillOver = 0;
  console.log("\nAfter turn-1 production clamp:");
  for (const agent of afterProduction) {
    for (const key of RESOURCE_KEYS) {
      if (agent.inventory[key] > agent.storageCapacity[key]) stillOver += 1;
    }
    console.log(
      `  ${agent.displayName.padEnd(4)} inv ${fmtTriple(agent.inventory)} | ` +
        `storage ${fmtTriple(agent.storageCapacity)}`
    );
  }
  assert(stillOver === 0, "post-production inventory must remain within storage");

  console.log(
    `\nOK — 15-player capacity-relative start verified. Scout=${expectedScout.displayName} ` +
      `fill=${(expectedScoutFill * 100).toFixed(1)}% (range ${(minFill * 100).toFixed(1)}–${(maxFill * 100).toFixed(1)}%).`
  );

  await disposeSimulationRun(repo, dbPath);
}

main().catch(async (err) => {
  console.error(err);
  try {
    const repo = require("../src/game/repository");
    await disposeSimulationRun(
      repo,
      path.join(__dirname, "..", "data", "capacity-relative-15p.sqlite")
    );
  } catch {
    /* ignore */
  }
  process.exit(1);
});
