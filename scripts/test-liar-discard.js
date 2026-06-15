#!/usr/bin/env node
/** Verify a sole dishonest message reporter is discarded and others avoid penalty. */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "test-liar-discard.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");

(async () => {
  await repo.initializeDatabase();
  const game = await engine.createGame({ config: { maxAgents: 5, minAgents: 3 } });
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push((await engine.joinGame(game.id, { roditId: `t${i}`, displayName: `T${i}` })).id);
  }
  await engine.startGame(game.id);

  await engine.publishPublicMessage(game.id, ids[0], { body: "hello" });
  await engine.publishPublicMessage(game.id, ids[1], { body: "hi" });
  await engine.publishPublicMessage(game.id, ids[2], { body: "hey" });

  await engine.beginMessageReportPhase(game.id);

  await engine.submitMessageReport(game.id, ids[0], { sent: 1, received: 2 });
  await engine.submitMessageReport(game.id, ids[1], { sent: 1, received: 2 });
  await engine.submitMessageReport(game.id, ids[3], { sent: 0, received: 2 });
  await engine.submitMessageReport(game.id, ids[4], { sent: 0, received: 2 });
  // Liar last: heavily misreports received count
  const result = await engine.submitMessageReport(game.id, ids[2], { sent: 1, received: 99 });

  const mr = result.messageReportResults;
  const liar = await repo.getAgentById(ids[2]);
  const honest = await repo.getAgentById(ids[0]);

  console.log("Outlier identified:", mr?.outlierAgentId === ids[2] ? "T2 yes" : "FAIL");
  console.log("Liar still alive:", liar.status === "alive" ? "yes" : "FAIL");
  console.log("Baseline mismatch:", mr?.baselineMismatch);
  console.log("Shared mismatch (honest):", mr?.globalReportMismatch);
  console.log("Energy penalty honest T0:", mr?.agents.find((a) => a.agentId === ids[0])?.energySurvivalPenalty);
  console.log("Energy penalty liar T2:", mr?.agents.find((a) => a.agentId === ids[2])?.energySurvivalPenalty);

  await repo.closeDatabase();
  fs.unlinkSync(DB_PATH);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
