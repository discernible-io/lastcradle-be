#!/usr/bin/env node
/**
 * Smoke test: agentType / llmModel can be patched mid-game.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "agent-profile-patch-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const { normalizeAgentProfilePatch } = require("../src/game/agent-profile");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  await repo.initializeDatabase();

  const empty = (() => {
    try {
      normalizeAgentProfilePatch({});
      return null;
    } catch (e) {
      return e.code;
    }
  })();
  assert(empty === "INVALID_AGENT_PROFILE", "empty patch rejected");

  const game = await engine.createGame({});
  const agent = await engine.joinGame(game.id, {
    roditId: "rodit_profile_test",
    displayName: "ProfileTest",
    agentType: "openclaw",
    llmModel: "claude-opus-4"
  });
  assert(agent.agentType === "openclaw", "join agentType");
  assert(agent.llmModel === "claude-opus-4", "join llmModel");

  const patched = await engine.updateAgentProfile(game.id, "rodit_profile_test", {
    agentType: "ironclaw",
    llmModel: "gpt-4.1"
  });
  assert(patched.agentType === "ironclaw", "patch agentType");
  assert(patched.llmModel === "gpt-4.1", "patch llmModel");

  const typeOnly = await engine.updateAgentProfile(game.id, "rodit_profile_test", {
    agentType: "hermes"
  });
  assert(typeOnly.agentType === "hermes", "partial type");
  assert(typeOnly.llmModel === "gpt-4.1", "llmModel preserved");

  const cleared = await engine.updateAgentProfile(game.id, "rodit_profile_test", {
    llmModel: null
  });
  assert(cleared.agentType === "hermes", "type preserved on clear");
  assert(cleared.llmModel === null, "llmModel cleared");

  await engine.joinGame(game.id, { roditId: "rodit_profile_peer_b", displayName: "B" });
  await engine.joinGame(game.id, { roditId: "rodit_profile_peer_c", displayName: "C" });
  await engine.startGame(game.id);
  const midPlay = await engine.updateAgentProfile(game.id, "rodit_profile_test", {
    agentType: "nanoclaw",
    llmModel: "claude-sonnet-4"
  });
  assert(midPlay.agentType === "nanoclaw", "running agentType");
  assert(midPlay.llmModel === "claude-sonnet-4", "running llmModel");

  console.log("test-agent-profile-patch: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
