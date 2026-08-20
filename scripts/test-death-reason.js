#!/usr/bin/env node
/**
 * Regression: deathReason autopsy on kill + action-schema cheat sheet wiring.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "death-reason-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const { buildGameSkillMarkdown } = require("../src/game/skill-content");
const { buildActionSchemaMarkdown, ACTION_SCHEMA_VERSION } = require("../src/game/action-schema-content");
const { buildDeathReason } = engine;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function testBuildDeathReasonUnit() {
  const reason = buildDeathReason({
    turnNumber: 8,
    inventoryBeforeStorageTax: { energy: 20, water: 100, compute: 100 },
    inventoryAfterStorageTax: { energy: 0, water: 100, compute: 100 },
    survivalCost: { energy: 11, water: 11, compute: 11 },
    storageEnergyTax: 20,
    submittedActionType: "invest",
    actionStatus: "executed"
  });
  assert(reason.cause === "insufficient_survival", "cause");
  assert(reason.primaryShortfall === "energy", "primary shortfall energy");
  assert(reason.shortfalls.energy > 0, "energy shortfall");
  assert(reason.submittedActionType === "invest", "action type");
  assert(reason.summary.includes("storage energy tax"), "summary mentions tax");
  assert(reason.summary.includes("invest"), "summary mentions action");
}

async function testDeathPersistsOnKill() {
  await repo.initializeDatabase();

  const game = await engine.createGame({
    config: {
      minAgents: 3,
      maxAgents: 3,
      finishSurvivorCount: 1,
      negotiationDurationMs: 60_000,
      executionDurationMs: 60_000,
      useSpecializedCradles: false,
      useRandomStartingInventory: false,
      startingInventory: { energy: 80, water: 80, compute: 80 },
      cradleCapacityMin: 200,
      cradleCapacityMax: 200,
      survivalCost: { energy: 50, water: 50, compute: 50 },
      survivalCostTurnIncrement: 0,
      storageEnergyCostRate: 0.1
    }
  });

  const profiles = [
    { roditId: "DeadTokAAAAA1", displayName: "Doomed" },
    { roditId: "LiveTokBBBBB2", displayName: "SurvivorA" },
    { roditId: "LiveTokCCCCC3", displayName: "SurvivorB" }
  ];

  for (const p of profiles) {
    await engine.joinGame(game.id, p);
  }
  await engine.startGame(game.id);

  let agents = await repo.listAgents(game.id);
  const doomed = agents.find((a) => a.displayName === "Doomed");
  assert(doomed, "doomed agent");

  // Doomed: storage tax on water+compute drains energy below survival.
  for (const a of agents) {
    if (a.id === doomed.id) {
      await repo.updateAgentInventory(a.id, { energy: 8, water: 40, compute: 40 });
    } else {
      await repo.updateAgentInventory(a.id, { energy: 200, water: 200, compute: 200 });
    }
  }

  await engine.beginExecutionPhase(game.id);
  agents = await repo.listAgents(game.id);
  for (const a of agents.filter((x) => x.status === "alive")) {
    await engine.submitAction(game.id, a.id, { type: "none" });
  }

  agents = await repo.listAgents(game.id);
  const dead = agents.find((a) => a.id === doomed.id);
  assert(dead.status === "dead", "doomed should be dead");
  assert(dead.diedAtTurn === 1, "died at turn 1");
  assert(dead.deathReason, "deathReason persisted");
  assert(dead.deathReason.cause === "insufficient_survival", "cause persisted");
  assert(dead.deathReason.primaryShortfall, "primaryShortfall set");
  assert(dead.deathReason.submittedActionType === "none", "last action none");
  assert(typeof dead.deathReason.summary === "string", "summary string");

  const state = await engine.getPublicState(game.id, { viewerAgentId: dead.id });
  assert(state.you.status === "dead", "you is dead");
  assert(state.you.deathReason?.summary, "you.deathReason on state");
  const publicDead = state.agents.find((p) => p.id === dead.id);
  assert(publicDead.deathReason?.cause === "insufficient_survival", "public dead row has deathReason");

  await repo.closeDatabase();
}

function testActionSchemaDocs() {
  const md = buildActionSchemaMarkdown({
    protocol: "https",
    get: (h) => (h === "host" ? "api.example.test" : null)
  });
  assert(md.includes(`version: ${ACTION_SCHEMA_VERSION}`), "action schema version");
  assert(md.includes("Equal invest is triple-cost") || md.includes("triple-cost"), "triple-cost");
  assert(md.includes('"type": "invest"'), "invest example");
  assert(md.includes("reduceStorage"), "reduceStorage");
  assert(md.includes("/project") || md.includes("slc_project"), "dry-run project");
  assert(md.includes("assumeInbound"), "assumeInbound");
  assert(md.includes("deathReason"), "deathReason mention");
  assert(md.includes("winReport") || md.includes("You won"), "win report mention");
  assert(md.includes("https://api.example.test/api/game/games"), "host-aware base");

  const skill = buildGameSkillMarkdown({
    protocol: "https",
    get: (h) => (h === "host" ? "api.example.test" : null)
  });
  assert(skill.includes("version: 1.20.3"), "skill version 1.20.3");
  assert(skill.includes("fractional") || skill.includes("4 decimal"), "fractional invest in skill");
  assert(md.includes("fraction") || md.includes("4 decimal"), "fractional invest in action schema");
  assert(
    skill.includes("remove all related heartbeats and crons"),
    "skill requires removing all related heartbeats and crons at end of game"
  );
  assert(skill.includes("action-schema.md"), "skill links action-schema");
  assert(skill.includes("doc:action-schema"), "skill links MCP action-schema");
  assert(skill.includes("slc_project") || skill.includes("/project"), "skill documents dry-run");
  assert(skill.includes("deathReason"), "skill documents deathReason");
  assert(skill.includes("winReport"), "skill documents winReport");
}

async function main() {
  testBuildDeathReasonUnit();
  testActionSchemaDocs();
  await testDeathPersistsOnKill();
  console.log("test-death-reason: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
