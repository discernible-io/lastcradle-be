#!/usr/bin/env node
/**
 * Smoke test for lobby auto-start and contest series creation.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "contest-orchestrator-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const orchestrator = require("../src/game/contest-orchestrator");
const scheduler = require("../src/game/scheduler");
const repo = require("../src/game/repository");

async function main() {
  await repo.initializeDatabase();

  const startsAt = new Date(Date.now() - 1000).toISOString();
  const { contest, practiceGame, definitiveGame } = await orchestrator.createContestSeries({
    practiceStartsAt: startsAt,
    practiceWindowMs: 2000,
    definitiveJoiningStartsAt: new Date(Date.now() + 5000).toISOString(),
    prizeAmountYoctoNear: "1000"
  });

  if (!contest.id || !practiceGame.id || !definitiveGame.id) {
    throw new Error("contest series missing ids");
  }

  for (let i = 0; i < 3; i++) {
    await engine.joinGame(practiceGame.id, { roditId: `p${i}`, displayName: `P${i}` });
  }

  await new Promise((r) => setTimeout(r, 2100));
  const practiceAfter = await repo.getGameById(practiceGame.id);
  if (practiceAfter.status !== "running") {
    throw new Error(`expected practice running after window, got ${practiceAfter.status}`);
  }

  const games = await repo.listGames({ contestMode: "practice" });
  if (!games.some((g) => g.id === practiceGame.id)) {
    throw new Error("listGames contestMode=practice failed");
  }

  scheduler.unregisterGame("all");
  orchestrator.unregisterLobbyGame("all");
  await repo.closeDatabase();
  console.log("Contest orchestrator test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
