#!/usr/bin/env node
/**
 * Regression: dry-run calculator (projectAgentActionDryRun / POST .../project).
 * Covers lethal none shortfalls, assumeInbound save, and no action mutation.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "project-dry-run.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  await repo.initializeDatabase();

  const game = await engine.createGame({
    config: {
      useRandomStartingInventory: false,
      startingInventory: { energy: 101, water: 33.92, compute: 175 },
      cradleCapacityMin: 101,
      cradleCapacityMax: 175,
      useSpecializedCradles: false,
      minAgents: 2,
      maxAgents: 2,
      joiningWindowDurationMs: 0,
      storageEnergyCostRate: 0.1,
      survivalCost: { energy: 34.04, water: 34.04, compute: 34.04 },
      survivalCostTurnIncrement: 0,
      negotiationDurationMs: 60_000,
      executionDurationMs: 60_000
    }
  });

  const a = await engine.joinGame(game.id, { roditId: "dry-run-a", displayName: "John" });
  const b = await engine.joinGame(game.id, { roditId: "dry-run-b", displayName: "Peer" });
  await engine.startGame(game.id);

  // Force exact inventory / storage from the transcript scenario.
  await repo.updateAgentInventory(a.id, { energy: 101, water: 33.92, compute: 175 });
  await repo.updateAgentCapacities(
    a.id,
    { energy: 150, water: 40, compute: 66 },
    { energy: 101, water: 101.5, compute: 175 }
  );

  const living = await repo.listAgents(game.id, { status: "alive" });
  assert(living.length === 2, "expected 2 living agents");

  const noneDry = await engine.projectAgentActionDryRun(game.id, a.id, { type: "none" });
  assert(noneDry.dryRun === true, "dryRun flag required");
  assert(noneDry.baseline.survives === false, "baseline must be lethal on none");
  assert(
    noneDry.baseline.shortfalls?.water > 0,
    `expected water shortfall, got ${JSON.stringify(noneDry.baseline.shortfalls)}`
  );
  assert(
    Math.abs(noneDry.baseline.shortfalls.water - 0.12) < 1e-6,
    `water shortfall expected ~0.12, got ${noneDry.baseline.shortfalls.water}`
  );
  assert(
    noneDry.projection.ok === true && noneDry.projection.afterStorageAndSurvival.survives === false,
    "none projection must also be lethal"
  );
  assert(
    noneDry.projection.afterStorageAndSurvival.shortfalls?.water > 0,
    "projection shortfalls.water required"
  );

  const saved = await engine.projectAgentActionDryRun(
    game.id,
    a.id,
    { type: "none" },
    { assumeInbound: { water: 1 } }
  );
  assert(saved.assumeInbound?.water === 1, "assumeInbound echoed");
  assert(saved.baseline.survives === true, "1 water inbound must save baseline");
  assert(saved.baseline.shortfalls == null, "no shortfalls after inbound water");
  assert(
    saved.projection.afterStorageAndSurvival.survives === true,
    "none + inbound water must survive"
  );

  const actionsBefore = await repo.listTurnActions(game.id, noneDry.turnNumber);
  assert(actionsBefore.length === 0, "dry-run must not write turn actions");

  const transferDry = await engine.projectAgentActionDryRun(game.id, a.id, {
    type: "transfer",
    toAgentId: b.id,
    energy: 10,
    water: 0,
    compute: 0
  });
  assert(transferDry.projection.ok === true, "transfer dry-run should project");
  assert(
    transferDry.projection.afterAction.inventory.energy === 91,
    `transfer out 10E → 91, got ${transferDry.projection.afterAction.inventory.energy}`
  );

  const agentAfter = await repo.getAgentById(a.id);
  assert(agentAfter.inventory.energy === 101, "dry-run must not mutate inventory");
  assert(agentAfter.inventory.water === 33.92, "dry-run must not mutate water");

  const actionsAfter = await repo.listTurnActions(game.id, noneDry.turnNumber);
  assert(actionsAfter.length === 0, "transfer dry-run must not write actions");

  // Pure helper coverage
  assert(engine.normalizeAssumeInbound(null) == null, "null inbound → null");
  assert(engine.normalizeAssumeInbound({ water: 0, energy: 0 }) == null, "zero inbound → null");
  assert(engine.normalizeAssumeInbound({ water: 2 }).water === 2, "water inbound kept");
  let threw = false;
  try {
    engine.normalizeAssumeInbound({ water: -1 });
  } catch (err) {
    threw = err.code === "INVALID_ASSUME_INBOUND";
  }
  assert(threw, "negative assumeInbound must throw");

  console.log("project dry-run tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
