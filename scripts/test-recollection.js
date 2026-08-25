#!/usr/bin/env node
/**
 * Regression: agent recollections after death/success reports + public list.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");

const DB_PATH = path.join(__dirname, "..", "data", "recollection-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const spectatorRoutes = require("../src/game/spectator-routes");
const { listTasksForRodit, TASK_TYPES } = require("../src/game/agent-tasks");
const {
  normalizeRecollectionBody,
  submitRecollection,
  listPublicRecollections
} = require("../src/game/recollection");
const { buildGameSkillMarkdown } = require("../src/game/skill-content");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertThrows(fn, code) {
  try {
    fn();
    throw new Error(`expected ${code}`);
  } catch (err) {
    if (err.code !== code) throw err;
  }
}

async function requestJson(port, pathName) {
  const response = await fetch(`http://127.0.0.1:${port}${pathName}`);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function main() {
  assertThrows(() => normalizeRecollectionBody({}), "INVALID_RECOLLECTION");
  assertThrows(() => normalizeRecollectionBody({ relationships: 1 }), "INVALID_RECOLLECTION");

  const normalized = normalizeRecollectionBody({
    relationships: "  trusted Nova  ",
    trade: "honored the water swap",
    overview: ""
  });
  assert(normalized.relationships === "trusted Nova", "trim relationships");
  assert(normalized.trade === "honored the water swap", "trade kept");
  assert(normalized.overview === null, "empty overview null");
  assert(normalized.espionage === null, "missing espionage null");

  await repo.initializeDatabase();

  const skill = buildGameSkillMarkdown({
    protocol: "https",
    get: (h) => (h === "host" ? "api.example.test" : null)
  });
  assert(skill.includes("submit_recollection"), "skill documents task");
  assert(skill.includes("/recollection"), "skill documents endpoint");
  assert(skill.includes("Name your stack"), "skill asks recollections to name agentType + llmModel");
  assert(skill.includes("agentType") && skill.includes("llmModel"), "skill mentions agentType and llmModel");

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
  const survivorA = agents.find((a) => a.displayName === "SurvivorA");
  assert(doomed && survivorA, "agents present");

  // Alive mid-game cannot submit
  let rejected = false;
  try {
    await submitRecollection(game.id, survivorA.id, { overview: "too early" });
  } catch (err) {
    rejected = err.code === "RECOLLECTION_NOT_ALLOWED";
  }
  assert(rejected, "alive mid-game blocked");

  // Force-kill doomed via killAgent + death reason shape
  const deathReason = engine.buildDeathReason({
    turnNumber: 1,
    inventoryBeforeStorageTax: { energy: 5, water: 80, compute: 80 },
    inventoryAfterStorageTax: { energy: 0, water: 80, compute: 80 },
    survivalCost: { energy: 50, water: 50, compute: 50 },
    storageEnergyTax: 16,
    submittedActionType: "none",
    actionStatus: "executed"
  });
  await repo.killAgent(doomed.id, 1, deathReason);
  doomed.status = "dead";
  doomed.deathReason = deathReason;
  doomed.diedAtTurn = 1;

  const runningGame = await repo.getGameById(game.id);
  const deadTasks = await listTasksForRodit(doomed.roditId);
  assert(
    deadTasks.some((t) => t.taskType === TASK_TYPES.SUBMIT_RECOLLECTION && t.context === "elimination"),
    "dead agent gets submit_recollection while game running"
  );

  const created = await submitRecollection(game.id, doomed.id, {
    relationships: "Allied briefly with SurvivorA",
    espionage: "Never found SurvivorB behind fog",
    investment: "Over-invested compute",
    trade: "Water deal fell through",
    incidents: "Storage tax finished me"
  });
  assert(created.created === true, "first submit creates");
  assert(created.recollection.context === "elimination", "context elimination");
  assert(created.recollection.relationships.includes("SurvivorA"), "relationships saved");

  const updated = await submitRecollection(game.id, doomed.id, {
    overview: "Should have transferred water earlier."
  });
  assert(updated.created === false, "second submit updates");
  assert(updated.recollection.overview.includes("water"), "overview updated");
  assert(
    updated.recollection.relationships.includes("SurvivorA"),
    "merge keeps prior relationships"
  );

  const listed = await listPublicRecollections(game.id);
  assert(listed.length === 1, "one public recollection");
  assert(listed[0].displayName === "Doomed", "display name on list");

  const app = express();
  app.use("/api/game", spectatorRoutes);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const { status, body } = await requestJson(port, `/api/game/games/${game.id}/recollections`);
  assert(status === 200, "GET recollections 200");
  assert(body.recollections?.length === 1, "spectator list length");
  assert(body.recollections[0].relationships.includes("SurvivorA"), "spectator sees merged topics");
  assert(body.recollections[0].overview.includes("water"), "spectator sees overview");

  server.close();
  await repo.closeDatabase();
  console.log("test-recollection: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
