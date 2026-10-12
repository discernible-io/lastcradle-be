#!/usr/bin/env node
/**
 * Hall of fame honors and objective metrics for finished casual games.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "hall-of-fame-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const express = require("express");
const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const ranking = require("../src/game/ranking");
const spectatorRoutes = require("../src/game/spectator-routes");
const { buildGameHonors } = require("../src/game/hall-of-fame");

async function requestJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function main() {
  await repo.initializeDatabase();

  const game = await engine.createGame({
    config: {
      minAgents: 2,
      maxAgents: 10,
      joiningWindowDurationMs: 3_600_000
    },
    allowParallelLobbies: true
  });
  const gameId = game.id;

  await engine.joinGame(gameId, { roditId: "hof-alpha", displayName: "Alpha" });
  const beta = await engine.joinGame(gameId, { roditId: "hof-beta", displayName: "Beta" });
  await engine.joinGame(gameId, { roditId: "hof-gamma", displayName: "Gamma" });
  await engine.startGame(gameId);

  const agents = await repo.listAgents(gameId);
  const alpha = agents.find((a) => a.roditId === "hof-alpha");

  await engine.beginExecutionPhase(gameId);

  await engine.submitAction(gameId, alpha.id, {
    type: "transfer",
    toAgentId: beta.id,
    energy: 8,
    rationale: "Alliance seed",
    privateDealSnippets: [{ taskType: "TRADE_OFFER", excerpt: "8E now" }]
  });
  await engine.submitAction(gameId, beta.id, { type: "none" });
  await engine.submitAction(gameId, agents.find((a) => a.roditId === "hof-gamma").id, { type: "none" });

  let finished = await repo.getGameById(gameId);
  if (!finished.winnerIds?.length) {
    const survivors = (await repo.listAgents(gameId)).filter((a) => a.status === "alive").map((a) => a.id);
    await repo.updateGame(gameId, {
      status: "finished",
      finished_at: new Date().toISOString(),
      phase: null,
      winner_ids_json: JSON.stringify(survivors)
    });
    finished = await repo.getGameById(gameId);
  } else if (finished.status !== "finished") {
    await repo.updateGame(gameId, { status: "finished", finished_at: new Date().toISOString(), phase: null });
    finished = await repo.getGameById(gameId);
  }

  const honors = await buildGameHonors(finished);
  if (!honors || !honors.standings?.length) {
    throw new Error("expected honors standings");
  }

  const ranked = await ranking.recordFinishedGame(finished);
  if (!ranked.recorded) {
    throw new Error(`expected ranking to record, got ${ranked.reason}`);
  }
  const ladder = await ranking.listRanking({ limit: 10 });
  if (!ladder.length) {
    throw new Error("expected ranking entries after finish");
  }

  const app = express();
  app.use("/api/game", spectatorRoutes);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = server.address().port;

  try {
    const list = await requestJson(port, "/api/game/hall-of-fame");
    if (list.status !== 200 || !list.body.entries?.length) {
      throw new Error("hall-of-fame list failed");
    }
    const gameHonors = await requestJson(port, `/api/game/games/${gameId}/honors`);
    if (gameHonors.status !== 200 || !gameHonors.body.honors) {
      throw new Error("game honors failed");
    }
    const rankingRes = await requestJson(port, "/api/game/ranking");
    if (rankingRes.status !== 200 || !rankingRes.body.entries?.length) {
      throw new Error("ranking list failed");
    }
    const weekly = await requestJson(port, "/api/game/ranking/weekly");
    if (weekly.status !== 200) {
      throw new Error("weekly ranking failed");
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await repo.closeDatabase();
  }

  console.log("hall-of-fame + ranking tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
