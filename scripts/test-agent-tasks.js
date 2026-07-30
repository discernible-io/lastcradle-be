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
  if (!skill.includes("version: 1.8.12")) {
    throw new Error("skill.md should be version 1.8.12");
  }
  if (!skill.includes("peer-auth.md")) {
    throw new Error("skill.md should link peer-auth.md");
  }
  if (!skill.includes("Peer finding")) {
    throw new Error("skill.md should document Peer finding");
  }
  if (!skill.includes("intelligenceMemoryTurns")) {
    throw new Error("skill.md should document intelligenceMemoryTurns");
  }
  if (!skill.includes("hiddenRivalCount")) {
    throw new Error("skill.md should document actionHints.hiddenRivalCount");
  }
  if (!skill.includes("Channel timing")) {
    throw new Error("skill.md should document Channel timing");
  }
  if (!skill.includes("Reply duty")) {
    throw new Error("skill.md should document reply duty");
  }
  if (!skill.includes("message-report")) {
    throw new Error("skill.md should tell agents to refuse message-report caches");
  }
  if (!skill.includes("GET .../messages")) {
    throw new Error("skill.md should document reading public messages");
  }
  if (!skill.includes("maxTransferRecipients")) {
    throw new Error("skill.md should document maxTransferRecipients");
  }
  if (!skill.includes("INVALID_TRANSFER")) {
    throw new Error("skill.md should document INVALID_TRANSFER for bad toAgentId");
  }
  if (!skill.includes("Fact-level execution constraints")) {
    throw new Error("skill.md should document fact-level execution constraints");
  }
  if (!skill.includes("maxInvestAmountAfterSurvival")) {
    throw new Error("skill.md should reference maxInvestAmountAfterSurvival for invest caps");
  }
  if (!skill.includes("storageWaterCostIfNoSpend")) {
    throw new Error("skill.md should document storageWaterCostIfNoSpend on actionHints");
  }
  if (!skill.includes("GET .../action") && !skill.includes("GET `/api/game/games/{gameId}/action`")) {
    throw new Error("skill.md should call out that GET .../action is not a route");
  }
  if (!skill.includes("How the game works")) {
    throw new Error("skill.md should include How the game works");
  }
  if (!skill.includes("How to play a turn")) {
    throw new Error("skill.md should include How to play a turn");
  }
  if (!skill.includes("action_required")) {
    throw new Error("skill.md should document action_required for empty ticks");
  }
  if (skill.includes("By default cradles are **specialized**") || skill.includes("By default cradles are specialized")) {
    throw new Error("skill.md must not treat cradle specialty as common knowledge");
  }
  if (!skill.includes("not** common knowledge") && !skill.includes("not common knowledge")) {
    throw new Error("skill.md should state specialty/capacities are not common knowledge");
  }
  if (!skill.includes("surplusByResource")) {
    throw new Error("skill.md should document surplusByResource state field");
  }
  if (!skill.includes("wasteIfNotExportedByNextProduction")) {
    throw new Error("skill.md should document wasteIfNotExportedByNextProduction");
  }
  if (!skill.includes("storageHeadroom")) {
    throw new Error("skill.md should document actionHints.storageHeadroom");
  }
  if (!skill.includes("projection")) {
    throw new Error("skill.md should document action/tick projection responses");
  }
  if (
    /prefer export|mandate to export|auto-export|export instead of invest|shrink waste without transferring/i.test(
      skill
    )
  ) {
    throw new Error("skill.md must not nudge export-vs-invest strategy");
  }
  if (skill.includes("Default action: `none`") || skill.includes("Default action: none")) {
    throw new Error("skill.md must not tell agents Default action: none for conscious ticks");
  }
  if (skill.includes("preferred when exporting specialty surplus")) {
    throw new Error("skill.md should not push win-strategy wording for transfer_and_invest");
  }
  if (
    skill.includes("worsens overflow") ||
    skill.includes("do not invest into specialty") ||
    skill.includes("Do not `invest` into `specialty`") ||
    skill.includes("export/transfer that surplus")
  ) {
    throw new Error("skill.md should not give specialty invest/export strategy advice");
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

  const { buildPeerAuthMarkdown } = require("../src/game/peer-auth-content");
  const peerAuth = buildPeerAuthMarkdown({
    protocol: "https",
    get: (h) => (h === "host" ? "api.example.test" : null)
  });
  if (!peerAuth.includes("https://api.example.test/api/game/peer-auth.md")) {
    throw new Error("peer-auth.md should pin absolute API URL");
  }
  if (!peerAuth.includes("TRADE_OFFER")) {
    throw new Error("peer-auth.md should document TRADE_OFFER");
  }
  if (!peerAuth.includes("Reply duty")) {
    throw new Error("peer-auth.md should document reply duty");
  }
  if (peerAuth.includes("message-report") || peerAuth.includes("Message self-reports")) {
    throw new Error("peer-auth.md must not document removed message-report phase");
  }

  const slcBase = resolveApiBase({ protocol: "https", get: (h) => (h === "host" ? "slc.discernible.io" : null) });
  if (slcBase !== "https://slc.discernible.io:8443") {
    throw new Error(`resolveApiBase should append :8443 for SLC host, got ${slcBase}`);
  }

  const {
    DEFAULT_GAME_CONFIG,
    PRIVATE_CRADLE_ASSIGNMENT_KEYS,
    publicGameConfig
  } = require("../src/game/defaults");
  const pubDefaults = publicGameConfig(DEFAULT_GAME_CONFIG);
  for (const key of PRIVATE_CRADLE_ASSIGNMENT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(pubDefaults, key)) {
      throw new Error(`publicGameConfig must omit ${key}`);
    }
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_GAME_CONFIG, key)) {
      throw new Error(`DEFAULT_GAME_CONFIG should still define ${key} for engine use`);
    }
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

  const state = await engine.getPublicState(game.id, { viewerAgentId: alpha.id });
  if (!state.you || state.you.id !== alpha.id) {
    throw new Error("state.you should be the viewer agent");
  }
  if (!state.you.specialty || !state.you.surplusByResource || !state.you.thisTurnSurvivalCost) {
    throw new Error(`Expected specialty/surplus/survival on you view, got ${JSON.stringify(state.you)}`);
  }
  const rival = state.agents.find((a) => a.id !== alpha.id);
  if (!rival?.intelligenceHidden || rival.specialty != null || rival.productionCapacity != null) {
    throw new Error(`Rival specialty/capacities must stay hidden at start, got ${JSON.stringify(rival)}`);
  }
  if (!state.you.actionHints || typeof state.you.actionHints.maxInvestAmount !== "number") {
    throw new Error(`Expected actionHints on you view, got ${JSON.stringify(state.you.actionHints)}`);
  }

  const { runAgentTick } = require("../src/game/tick");
  const emptyTick = await runAgentTick("agent-alpha", {});
  if (emptyTick.submitted || emptyTick.reason !== "action_required") {
    throw new Error(`Empty tick should return action_required, got ${JSON.stringify(emptyTick)}`);
  }

  const explicitNone = await runAgentTick("agent-alpha", { type: "none" });
  if (!explicitNone.submitted) {
    throw new Error(`Explicit none tick should submit, got ${JSON.stringify(explicitNone)}`);
  }

  const { listTasksInboxForRodit } = require("../src/game/agent-tasks");
  const inbox = await listTasksInboxForRodit("agent-alpha");
  if (inbox.tasks.some((t) => t.taskType === TASK_TYPES.SUBMIT_EXECUTION_ACTION)) {
    throw new Error("Alpha should have no execution-action task after submit");
  }
  if (inbox.waitingOn.some((w) => w.displayName === "Beta" && w.needed === TASK_TYPES.SUBMIT_EXECUTION_ACTION)) {
    // ok
  } else {
    throw new Error(`Expected waitingOn Beta after Alpha submitted, got ${JSON.stringify(inbox.waitingOn)}`);
  }

  const identityAgent = await repo.getAgentByRoditId(game.id, "agent-beta");
  if (!identityAgent?.roditId) {
    throw new Error("expected beta roditId for identity smoke");
  }
  // Identity payload shape (route handler logic mirrored for smoke without HTTP):
  const identity = {
    agentId: identityAgent.id,
    displayName: identityAgent.displayName,
    roditId: identityAgent.roditId,
    status: identityAgent.status
  };
  if (identity.roditId !== "agent-beta" || identity.agentId !== identityAgent.id) {
    throw new Error(`identity fields mismatch: ${JSON.stringify(identity)}`);
  }

  console.log("Agent tasks and skill smoke test passed.");
  await repo.closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
