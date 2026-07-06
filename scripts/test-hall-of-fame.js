#!/usr/bin/env node
/**
 * Hall of fame honors and objective metrics.
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
const orchestrator = require("../src/game/contest-orchestrator");
const spectatorRoutes = require("../src/game/spectator-routes");
const { buildGameHonors } = require("../src/game/hall-of-fame");

async function requestJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function main() {
  await repo.initializeDatabase();

  const { contest, definitiveGame } = await orchestrator.createContestSeries({
    practiceStartsAt: new Date(Date.now() - 120_000).toISOString(),
    practiceWindowMs: 60_000,
    definitiveJoiningStartsAt: new Date(Date.now() - 60_000).toISOString(),
    prizeAmountYoctoNear: null,
    configOverrides: {
      minAgents: 2,
      maxAgents: 10,
      joiningWindowDurationMs: 3_600_000
    }
  });
  const gameId = definitiveGame.id;

  await engine.joinGame(gameId, { roditId: "hof-alpha", displayName: "Alpha" });
  const beta = await engine.joinGame(gameId, { roditId: "hof-beta", displayName: "Beta" });
  await engine.joinGame(gameId, { roditId: "hof-gamma", displayName: "Gamma" });
  await engine.startGame(gameId);

  const agents = await repo.listAgents(gameId);
  const alpha = agents.find((a) => a.roditId === "hof-alpha");

  await engine.beginMessageReportPhase(gameId);
  for (const agent of agents) {
    await engine.submitMessageReport(gameId, agent.id, { sent: 0, received: 0 });
  }

  await engine.submitAction(gameId, alpha.id, {
    type: "transfer",
    toAgentId: beta.id,
    energy: 8,
    rationale: "Alliance seed",
    privateDealSnippets: [{ taskType: "TRADE_OFFER", excerpt: "8E now" }]
  });
  await engine.submitAction(gameId, beta.id, { type: "none" });
  await engine.submitAction(gameId, agents.find((a) => a.roditId === "hof-gamma").id, { type: "none" });

  let game = await repo.getGameById(gameId);
  if (!game.winnerIds?.length) {
    const survivors = (await repo.listAgents(gameId)).filter((a) => a.status === "alive").map((a) => a.id);
    await repo.updateGame(gameId, {
      status: "finished",
      finished_at: new Date().toISOString(),
      phase: null,
      winner_ids_json: JSON.stringify(survivors)
    });
    game = await repo.getGameById(gameId);
  } else if (game.status !== "finished") {
    await repo.updateGame(gameId, { status: "finished", finished_at: new Date().toISOString(), phase: null });
    game = await repo.getGameById(gameId);
  }

  await repo.updateContest(contest.id, { status: "finished" });

  const honors = await buildGameHonors(game, { contest });
  if (!honors || !honors.honorees.length) {
    throw new Error("expected honorees");
  }
  if (!honors.superlatives.mostPublicMessages && !honors.superlatives.highestTransferVolumeSent) {
    throw new Error("expected superlatives");
  }
  if (honors.gameMetrics.transfersExecuted < 1) {
    throw new Error("expected transfer metrics");
  }

  const app = express();
  app.use((req, _res, next) => {
    req.requestId = "test-request";
    next();
  });
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

    const byContest = await requestJson(port, `/api/game/hall-of-fame/${contest.id}`);
    if (byContest.status !== 200 || !byContest.body.honors) {
      throw new Error("contest honors failed");
    }

    const byGame = await requestJson(port, `/api/game/games/${gameId}/honors`);
    if (byGame.status !== 200 || !byGame.body.honors?.standings?.length) {
      throw new Error("game honors failed");
    }

    console.log("✓ Hall of fame honors and public routes work");
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }

  await repo.closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
