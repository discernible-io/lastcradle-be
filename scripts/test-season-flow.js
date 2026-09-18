#!/usr/bin/env node
/**
 * Season phases: practice → qualifying eligibility → rostered final.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "season-flow-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const season = require("../src/game/season");
const orchestrator = require("../src/game/contest-orchestrator");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function finishQuick(gameId, winnerRoditIds) {
  const agents = await repo.listAgents(gameId);
  const winners = agents.filter((a) => winnerRoditIds.includes(a.roditId)).map((a) => a.id);
  await repo.updateGame(gameId, {
    status: "finished",
    finished_at: new Date().toISOString(),
    phase: null,
    winner_ids_json: JSON.stringify(winners)
  });
  const game = await repo.getGameById(gameId);
  await season.recordFinishedGame(game);
  return game;
}

async function main() {
  await repo.initializeDatabase();

  const now = Date.now();
  const created = await season.createSeason({
    name: "Season 1 test",
    practiceStartsAt: new Date(now - 60_000).toISOString(),
    practiceEndsAt: new Date(now + 3_600_000).toISOString(),
    qualifyingStartsAt: new Date(now + 3_600_000).toISOString(),
    qualifyingEndsAt: new Date(now + 7_200_000).toISOString(),
    finalJoiningStartsAt: new Date(now + 7_200_000).toISOString()
  });
  assert(created.phase === "practice", `expected practice phase, got ${created.phase}`);

  const practice = await engine.createGame({
    config: { minAgents: 2, maxAgents: 4, joiningWindowDurationMs: 0 }
  });
  assert(practice.config.contestMode === "practice", "practice create should tag contestMode");
  assert(practice.config.contestSeasonId === created.id, "practice should link season");

  await engine.joinGame(practice.id, { roditId: "player-a", displayName: "Alpha" });
  await engine.joinGame(practice.id, { roditId: "player-b", displayName: "Beta" });
  await engine.startGame(practice.id);
  await finishQuick(practice.id, ["player-a", "player-b"]);

  const practicedA = await repo.hasSeasonPracticeFinish(created.id, "player-a");
  assert(practicedA, "player-a should have practice credit");

  // Move into qualifying by rewriting season windows
  await repo.updateSeason(created.id, {
    practiceStartsAt: new Date(now - 7_200_000).toISOString(),
    practiceEndsAt: new Date(now - 3_600_000).toISOString(),
    qualifyingStartsAt: new Date(now - 60_000).toISOString(),
    qualifyingEndsAt: new Date(now + 3_600_000).toISOString(),
    updatedAt: new Date().toISOString()
  });

  let blocked = null;
  try {
    const q = await engine.createGame({ config: { contestMode: "qualifying" } });
    await engine.joinGame(q.id, { roditId: "player-c", displayName: "Charlie" });
  } catch (err) {
    blocked = err;
  }
  assert(blocked?.code === "PRACTICE_REQUIRED", `expected PRACTICE_REQUIRED, got ${blocked?.code}`);

  const qualifying = await engine.createGame({
    config: {
      contestMode: "qualifying",
      minAgents: 2,
      maxAgents: 4,
      joiningWindowDurationMs: 0
    }
  });
  assert(qualifying.config.contestMode === "qualifying", "qualifying tag");
  assert(qualifying.config.minAgents === 2, "qualifying overrides should stick");
  await engine.joinGame(qualifying.id, { roditId: "player-a", displayName: "Alpha" });
  await engine.joinGame(qualifying.id, { roditId: "player-b", displayName: "Beta" });
  await engine.startGame(qualifying.id);
  const agentsQ = await repo.listAgents(qualifying.id);
  await repo.updateGame(qualifying.id, {
    status: "finished",
    finished_at: new Date().toISOString(),
    phase: null,
    winner_ids_json: JSON.stringify(agentsQ.map((a) => a.id))
  });
  await season.recordFinishedGame(await repo.getGameById(qualifying.id));

  const eligible = await repo.listSeasonQualifyingEligible(created.id);
  assert(eligible.length >= 1, "expected qualifying eligible players");

  // Advance to roster phase
  await repo.updateSeason(created.id, {
    qualifyingEndsAt: new Date(now - 1_000).toISOString(),
    updatedAt: new Date().toISOString()
  });

  const rostered = await season.setFinalRoster(
    created.id,
    eligible.map((e) => e.roditId)
  );
  assert(rostered.finalRoster.length >= 1, "roster set");

  const { finalGame } = await season.createSeasonFinal(created.id, {
    joiningWindowStartsAt: new Date().toISOString()
  });
  assert(finalGame.config.contestMode === "definitive", "final is definitive");

  let notOnRoster = null;
  try {
    await engine.joinGame(finalGame.id, { roditId: "player-c", displayName: "Charlie" });
  } catch (err) {
    notOnRoster = err;
  }
  assert(notOnRoster?.code === "NOT_ON_FINAL_ROSTER", `expected NOT_ON_FINAL_ROSTER got ${notOnRoster?.code}`);

  await engine.joinGame(finalGame.id, { roditId: "player-a", displayName: "Alpha" });

  const view = await season.getSeasonPublicView(created.id);
  assert(view?.viability, "public season view should include viability");
  assert(view.viability.thresholds.minActivePassports === 14, "passport threshold");
  assert(view.viability.thresholds.minFilledLobbies === 12, "lobby threshold");
  assert(typeof view.viability.pass === "boolean", "viability.pass");
  assert(view.viability.policy === "continue" || view.viability.policy === "cancel_and_relaunch", "policy");

  console.log("✓ Season practice → qualifying → rostered final gates work");
  console.log("✓ Season viability public fields present");
  orchestrator.unregisterLobbyGame("all");
  await repo.closeDatabase();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
