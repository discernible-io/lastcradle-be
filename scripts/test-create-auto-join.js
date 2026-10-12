#!/usr/bin/env node
/**
 * REST POST /api/game/games auto-joins the creator (MCP slc_create parity).
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "create-auto-join-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const express = require("express");
const repo = require("../src/game/repository");
const scheduler = require("../src/game/scheduler");
const orchestrator = require("../src/game/lobby-orchestrator");
const gameRoutes = require("../src/game/routes");
const { callGameTool } = require("../src/mcp/game-tools");

async function requestJson(port, method, urlPath, { body, roditId } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (roditId) {
    headers["X-Test-Rodit"] = roditId;
  }
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, body: json };
}

async function cancelLobby(gameId) {
  await repo.updateGame(gameId, { status: "cancelled" });
  orchestrator.unregisterLobbyGame(gameId);
}

async function main() {
  await repo.initializeDatabase();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.requestId = "test-create-auto-join";
    const roditId = req.headers["x-test-rodit"];
    if (roditId) {
      req.user = { roditId };
    }
    next();
  });
  app.use("/api/game", gameRoutes);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = server.address().port;

  try {
    const created = await requestJson(port, "POST", "/api/game/games", {
      roditId: "CreatorAAAAAA",
      body: {
        displayName: "Host",
        config: { minAgents: 2, maxAgents: 4, joiningWindowDurationMs: 60_000 }
      }
    });
    if (created.status !== 201) {
      throw new Error(`create expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
    }
    if (!created.body.agent?.id || created.body.agent.roditId !== "CreatorAAAAAA") {
      throw new Error("create should auto-join creator agent");
    }
    if (created.body.agent.displayName !== "Host") {
      throw new Error("create should apply displayName on auto-join");
    }

    const agents = await repo.listAgents(created.body.game.id);
    if (agents.length !== 1 || agents[0].roditId !== "CreatorAAAAAA") {
      throw new Error("lobby should contain exactly the creator after auto-join");
    }

    const blocked = await requestJson(port, "POST", "/api/game/games", {
      roditId: "OtherPlayerXX",
      body: { config: { minAgents: 2, maxAgents: 4, joiningWindowDurationMs: 60_000 } }
    });
    if (blocked.status !== 409 || blocked.body?.error?.code !== "OPEN_LOBBY_AVAILABLE") {
      throw new Error(
        `expected OPEN_LOBBY_AVAILABLE while first lobby has seats, got ${blocked.status} ${JSON.stringify(blocked.body)}`
      );
    }

    await cancelLobby(created.body.game.id);

    const emptyLobby = await requestJson(port, "POST", "/api/game/games", {
      roditId: "HostOnlyBBBBB",
      body: {
        autoJoin: false,
        config: { minAgents: 2, maxAgents: 4, joiningWindowDurationMs: 60_000 }
      }
    });
    if (emptyLobby.status !== 201) {
      throw new Error(`autoJoin false create expected 201, got ${emptyLobby.status}`);
    }
    if (emptyLobby.body.agent !== null || emptyLobby.body.autoStart !== null) {
      throw new Error("autoJoin false should return agent/autoStart null");
    }
    const emptyAgents = await repo.listAgents(emptyLobby.body.game.id);
    if (emptyAgents.length !== 0) {
      throw new Error("autoJoin false must leave lobby empty");
    }

    await cancelLobby(emptyLobby.body.game.id);

    const mcpCreate = await callGameTool(
      "slc_create",
      {
        displayName: "McpHost",
        config: { minAgents: 2, maxAgents: 4, joiningWindowDurationMs: 60_000 }
      },
      { user: { roditId: "McpCreatorCCC" }, ip: "127.0.0.1" }
    );
    if (!mcpCreate.agent?.id || mcpCreate.agent.roditId !== "McpCreatorCCC") {
      throw new Error("MCP slc_create should auto-join creator");
    }

    await cancelLobby(mcpCreate.game.id);

    console.log("✓ Create lobby auto-joins creator (REST + MCP)");
  } finally {
    scheduler.unregisterGame("all");
    orchestrator.unregisterLobbyGame("all");
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
