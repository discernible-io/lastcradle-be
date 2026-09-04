#!/usr/bin/env node
/**
 * Regression: informative insufficient-resource errors + lastActionOutcome surfacing.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "insufficient-resources-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const { lastActionOutcomeFromRow } = require("../src/game/trade-disclosure");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  await repo.initializeDatabase();

  const game = await engine.createGame({
    config: {
      useRandomStartingInventory: false,
      startingInventory: { energy: 100, water: 100, compute: 100 },
      cradleCapacityMin: 120,
      cradleCapacityMax: 120,
      useSpecializedCradles: false,
      minAgents: 2,
      maxAgents: 2,
      joiningWindowDurationMs: 0,
      storageEnergyCostRate: 0.1,
      survivalCost: { energy: 10, water: 10, compute: 10 },
      survivalCostTurnIncrement: 0,
      negotiationDurationMs: 60_000,
      executionDurationMs: 60_000,
      finishSurvivorCount: 1
    }
  });

  await engine.joinGame(game.id, { roditId: "donor", displayName: "Donor" });
  await engine.joinGame(game.id, { roditId: "donee", displayName: "Donee" });
  await engine.startGame(game.id);

  const agents = await repo.listAgents(game.id);
  const donor = agents.find((a) => a.roditId === "donor");
  const donee = agents.find((a) => a.roditId === "donee");
  assert(donor && donee, "both agents joined");

  // Hold inventory below a storage-cap-sized gift (Hermes-style mistake).
  await repo.updateAgentInventory(donor.id, { energy: 80, water: 70, compute: 60 });
  await repo.updateAgentCapacities(
    donor.id,
    { energy: 40, water: 40, compute: 40 },
    { energy: 131.9, water: 160, compute: 60 }
  );

  const refreshed = await repo.getAgentById(donor.id);
  const oversized = {
    type: "transfer",
    toAgentId: donee.id,
    energy: 131.9,
    water: 103.42,
    compute: 58.8
  };

  const proj = engine.projectActionOutcome(refreshed, oversized, game.config, {
    energy: 10,
    water: 10,
    compute: 10
  });
  assert(proj.ok === false, "oversized transfer projection must be ok:false");
  assert(/held E80\/W70\/C60/.test(proj.error), `error should include held triple: ${proj.error}`);
  assert(/requested E131\.9\/W103\.42\/C58\.8/.test(proj.error), `error should include requested: ${proj.error}`);
  assert(/not a survival-floor/.test(proj.error), `error should deny survival-floor myth: ${proj.error}`);
  assert(proj.details?.reason === "insufficient_resources", "details.reason");
  assert(proj.details?.shortfalls?.energy > 0, "energy shortfall in details");
  assert(proj.details?.shortfalls?.water > 0, "water shortfall in details");

  // Force execution and resolve with oversized gift + peer none.
  let g = await repo.getGameById(game.id);
  if (g.phase !== "execution") {
    await engine.beginExecutionPhase(game.id);
  }
  g = await repo.getGameById(game.id);
  assert(g.phase === "execution", `expected execution, got ${g.phase}`);

  const submitted = await engine.submitAction(game.id, donor.id, oversized);
  assert(submitted.projection?.ok === false, "submit projection should still flag ok:false");
  await engine.submitAction(game.id, donee.id, { type: "none" });

  // tryCompleteTurn may have already run on last submit
  g = await repo.getGameById(game.id);
  if (g.phase === "execution" || g.phase === "resolving") {
    await engine.executeTurn(game.id);
  }

  const actionRow = await repo.getAction(game.id, 1, donor.id);
  assert(actionRow.status === "failed", `expected failed, got ${actionRow.status}`);
  assert(
    /Insufficient resources for transfer/.test(actionRow.error_message),
    `resolve error: ${actionRow.error_message}`
  );
  assert(/held /.test(actionRow.error_message), "resolve error should include held");

  g = await repo.getGameById(game.id);
  const state = await engine.getPublicState(game.id, { viewerAgentId: donor.id });
  assert(state.you.lastActionOutcome, "state should expose lastActionOutcome");
  assert(state.you.lastActionOutcome.status === "failed", "lastActionOutcome.status failed");
  assert(
    /not a survival-floor/.test(state.you.lastActionOutcome.error || ""),
    "lastActionOutcome.error should clarify inventory-only"
  );

  const tick = await engine.getTickState(game.id, { viewerAgentId: donor.id });
  assert(tick.you.lastActionOutcome?.status === "failed", "tick-context should carry lastActionOutcome");

  const outcome = lastActionOutcomeFromRow(actionRow, 1);
  assert(outcome.status === "failed" && outcome.error, "helper maps row");

  const trades = await repo.listPublicTrades(game.id, 1);
  const failed = trades.find((t) => t.fromAgentId === donor.id);
  assert(failed?.status === "failed", "public trade status failed");
  assert(failed?.errorMessage, "public trade should include errorMessage");

  console.log("Insufficient-resources error regression passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
