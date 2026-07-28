#!/usr/bin/env node
/**
 * Smoke test for agent task inbox and skill document helpers.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "agent-tasks-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const { listTasksForRodit, listActiveGamesForRodit, TASK_TYPES } = require("../src/game/agent-tasks");
const { buildGameSkillMarkdown, resolveApiBase } = require("../src/game/skill-content");

async function main() {
  await repo.initializeDatabase();

  const skill = buildGameSkillMarkdown({ protocol: "https", get: (h) => (h === "host" ? "api.example.test" : null) });
  if (!skill.includes("GET https://api.example.test/api/game/tasks")) {
    throw new Error("skill.md should include tasks endpoint");
  }
  if (!skill.includes("phase_change")) {
    throw new Error("skill.md should document webhook events");
  }
  if (!skill.includes("identyclaw_ensure_session")) {
    throw new Error("skill.md should document OpenClaw plugin login path");
  }
  if (!skill.includes("identyclaw_request")) {
    throw new Error("skill.md should document generic identyclaw_request play path");
  }
  if (!skill.includes("waitingOn")) {
    throw new Error("skill.md should document waitingOn on empty tasks");
  }
  if (!skill.includes("version: 1.6.1")) {
    throw new Error("skill.md should be version 1.6.1");
  }
  if (!skill.includes("slc_create")) {
    throw new Error("skill.md should document MCP slc_create");
  }
  if (skill.includes("Use the returned JWT")) {
    throw new Error("skill.md must not claim ensure_session returns a JWT");
  }
  if (!skill.includes("curl -sk")) {
    throw new Error("skill.md should use curl -sk for self-signed TLS");
  }

  const slcBase = resolveApiBase({ protocol: "https", get: (h) => (h === "host" ? "slc.discernible.io" : null) });
  if (slcBase !== "https://slc.discernible.io:8443") {
    throw new Error(`resolveApiBase should append :8443 for SLC host, got ${slcBase}`);
  }

  const game = await engine.createGame({
    config: { minAgents: 2, maxAgents: 5, joiningWindowDurationMs: 0 }
  });

  await engine.joinGame(game.id, { roditId: "agent-alpha", displayName: "Alpha" });
  await engine.joinGame(game.id, { roditId: "agent-beta", displayName: "Beta" });

  let tasks = await listTasksForRodit("agent-alpha");
  if (tasks.length !== 1 || tasks[0].taskType !== TASK_TYPES.WAIT_FOR_START) {
    throw new Error(`Expected wait_for_start task in lobby, got ${JSON.stringify(tasks)}`);
  }

  const active = await listActiveGamesForRodit("agent-alpha");
  if (active.length !== 1 || active[0].id !== game.id) {
    throw new Error("Expected one active game for agent-alpha");
  }

  await engine.startGame(game.id);

  tasks = await listTasksForRodit("agent-alpha");
  const negotiation = tasks.find((t) => t.taskType === TASK_TYPES.NEGOTIATION_OPEN);
  if (!negotiation) {
    throw new Error(`Expected negotiation_open task after start, got ${JSON.stringify(tasks)}`);
  }

  const alpha = await repo.getAgentByRoditId(game.id, "agent-alpha");
  await engine.publishPublicMessage(game.id, alpha.id, { body: "Public offer." });

  await engine.beginExecutionPhase(game.id);
  tasks = await listTasksForRodit("agent-alpha");
  const actionTask = tasks.find((t) => t.taskType === TASK_TYPES.SUBMIT_EXECUTION_ACTION);
  if (!actionTask || !actionTask.required) {
    throw new Error(`Expected required submit_execution_action task, got ${JSON.stringify(tasks)}`);
  }

  const { listTasksInboxForRodit } = require("../src/game/agent-tasks");
  await engine.submitAction(game.id, alpha.id, { type: "none" });
  const inbox = await listTasksInboxForRodit("agent-alpha");
  if (inbox.tasks.some((t) => t.taskType === TASK_TYPES.SUBMIT_EXECUTION_ACTION)) {
    throw new Error("Alpha should have no execution-action task after submit");
  }
  if (!inbox.waitingOn.some((w) => w.displayName === "Beta" && w.needed === TASK_TYPES.SUBMIT_EXECUTION_ACTION)) {
    throw new Error(`Expected waitingOn Beta after Alpha submitted, got ${JSON.stringify(inbox.waitingOn)}`);
  }

  console.log("Agent tasks and skill smoke test passed.");
  await repo.closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
