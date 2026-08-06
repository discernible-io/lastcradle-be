#!/usr/bin/env node
/**
 * Regression: winReport for co-survivors + you_won task without includeFinished.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "win-report-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const { listTasksInboxForRodit, TASK_TYPES } = require("../src/game/agent-tasks");
const { buildGameSkillMarkdown } = require("../src/game/skill-content");
const { buildActionSchemaMarkdown } = require("../src/game/action-schema-content");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function testBuildWinReportUnit() {
  const game = {
    status: "finished",
    current_turn: 12,
    finished_at: "2026-08-06T10:00:00.000Z",
    winnerIds: ["a1", "a2"],
    config: { finishSurvivorCount: 2, maxTurns: 55 }
  };
  const agents = [
    {
      id: "a1",
      roditId: "RodAAAA",
      displayName: "Anchor",
      status: "alive",
      inventory: { energy: 90, water: 80, compute: 70 }
    },
    {
      id: "a2",
      roditId: "RodBBBB",
      displayName: "CoCradle",
      status: "alive",
      inventory: { energy: 40, water: 40, compute: 40 }
    },
    {
      id: "a3",
      roditId: "RodCCCC",
      displayName: "Fallen",
      status: "dead",
      diedAtTurn: 8,
      inventory: null
    }
  ];

  const win = engine.buildWinReport({ game, agent: agents[0], agents });
  assert(win?.outcome === "won", "outcome won");
  assert(win.rank === 1, "rank 1");
  assert(win.title === "White Hole Anchor", "anchor title");
  assert(win.summary.startsWith("You won!"), "summary You won");
  assert(win.finishReason === "natural_finish", "natural finish");
  assert(win.coWinners.length === 2, "two co-winners");
  assert(win.prizeShareCount === 2, "prize share 2");

  const co = engine.buildWinReport({ game, agent: agents[1], agents });
  assert(co?.rank === 2, "rank 2");
  assert(co.title === "Co-Cradle of the Restart", "co-cradle title");

  assert(engine.buildWinReport({ game, agent: agents[2], agents }) === null, "dead non-winner null");

  const over = engine.buildGameOverReport({ game, agent: agents[2], agents });
  assert(over?.outcome === "eliminated", "eliminated outcome");
  assert(over.summary.includes("Game over"), "game over summary");
  assert(!over.summary.includes("You won!"), "no you won for loser");
}

async function testWinReportOnFinishedState() {
  await repo.initializeDatabase();

  const game = await engine.createGame({
    config: {
      minAgents: 3,
      maxAgents: 3,
      finishSurvivorCount: 2,
      negotiationDurationMs: 60_000,
      executionDurationMs: 60_000,
      useSpecializedCradles: false,
      useRandomStartingInventory: false,
      startingInventory: { energy: 200, water: 200, compute: 200 },
      cradleCapacityMin: 300,
      cradleCapacityMax: 300,
      survivalCost: { energy: 50, water: 50, compute: 50 },
      survivalCostTurnIncrement: 0,
      storageEnergyCostRate: 0.1
    }
  });

  const profiles = [
    { roditId: "WinTokAAAAA1", displayName: "Wealthy" },
    { roditId: "WinTokBBBBB2", displayName: "Modest" },
    { roditId: "WinTokCCCCC3", displayName: "Doomed" }
  ];

  for (const p of profiles) {
    await engine.joinGame(game.id, p);
  }
  await engine.startGame(game.id);

  let agents = await repo.listAgents(game.id);
  const doomed = agents.find((a) => a.displayName === "Doomed");
  const wealthy = agents.find((a) => a.displayName === "Wealthy");
  const modest = agents.find((a) => a.displayName === "Modest");
  assert(doomed && wealthy && modest, "agents present");

  for (const a of agents) {
    if (a.id === doomed.id) {
      await repo.updateAgentInventory(a.id, { energy: 8, water: 40, compute: 40 });
    } else if (a.id === wealthy.id) {
      await repo.updateAgentInventory(a.id, { energy: 250, water: 250, compute: 250 });
    } else {
      await repo.updateAgentInventory(a.id, { energy: 120, water: 120, compute: 120 });
    }
  }

  await engine.beginExecutionPhase(game.id);
  agents = await repo.listAgents(game.id);
  for (const a of agents.filter((x) => x.status === "alive")) {
    await engine.submitAction(game.id, a.id, { type: "none" });
  }

  const finished = await repo.getGameById(game.id);
  assert(finished.status === "finished", "game finished");
  assert((finished.winnerIds || []).includes(wealthy.id), "wealthy wins");
  assert((finished.winnerIds || []).includes(modest.id), "modest wins");
  assert(!(finished.winnerIds || []).includes(doomed.id), "doomed not winner");

  const winnerState = await engine.getPublicState(game.id, { viewerAgentId: wealthy.id });
  assert(winnerState.you.winReport, "winner has winReport");
  assert(winnerState.you.winReport.summary.startsWith("You won!"), "You won summary");
  assert(winnerState.you.winReport.rank === 1, "wealthy is rank 1");
  assert(winnerState.you.winReport.title === "White Hole Anchor", "anchor title on state");

  const modestState = await engine.getPublicState(game.id, { viewerAgentId: modest.id });
  assert(modestState.you.winReport?.rank === 2, "modest rank 2");

  const deadState = await engine.getPublicState(game.id, { viewerAgentId: doomed.id });
  assert(!deadState.you.winReport, "loser has no winReport");
  assert(deadState.you.deathReason, "loser still has deathReason");

  const winnerInbox = await listTasksInboxForRodit(wealthy.roditId, { includeFinished: false });
  const youWon = winnerInbox.tasks.find((t) => t.taskType === TASK_TYPES.YOU_WON);
  assert(youWon, "you_won task without includeFinished");
  assert(youWon.won === true, "won flag");
  assert(youWon.winReport?.summary, "task embeds winReport");

  const loserInbox = await listTasksInboxForRodit(doomed.roditId, { includeFinished: false });
  assert(
    !loserInbox.tasks.some((t) => t.gameId === game.id),
    "loser finished tasks hidden without includeFinished"
  );
  const loserFinished = await listTasksInboxForRodit(doomed.roditId, { includeFinished: true });
  assert(
    loserFinished.tasks.some((t) => t.taskType === TASK_TYPES.VIEW_HONORS && t.won === false),
    "loser view_honors with includeFinished"
  );

  await repo.closeDatabase();
}

function testDocs() {
  const skill = buildGameSkillMarkdown({
    protocol: "https",
    get: (h) => (h === "host" ? "api.example.test" : null)
  });
  assert(skill.includes("winReport"), "skill winReport");
  assert(skill.includes("you_won"), "skill you_won");
  assert(skill.includes("gameOverReport"), "skill gameOverReport");

  const md = buildActionSchemaMarkdown({
    protocol: "https",
    get: (h) => (h === "host" ? "api.example.test" : null)
  });
  assert(md.includes("winReport") || md.includes("You won"), "action-schema winners");
}

async function main() {
  testBuildWinReportUnit();
  testDocs();
  await testWinReportOnFinishedState();
  console.log("test-win-report: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
