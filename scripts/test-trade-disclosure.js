#!/usr/bin/env node
/**
 * Trade rationale / privateDealSnippets validation and public trades route.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "trade-disclosure-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const express = require("express");
const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const spectatorRoutes = require("../src/game/spectator-routes");
const {
  normalizeTransferDisclosure,
  lastResolvedTurnNumber,
  inboundTradesForRecipient,
  transfersReceivedLastTurn
} = require("../src/game/trade-disclosure");
const {
  notifyPhaseChange,
  setRoditClient,
  clearWebhookUrlCacheForTests
} = require("../src/game/webhooks");
const { blockchainService } = require("@rodit/rodit-auth-be");

function assertThrows(fn, code) {
  try {
    fn();
    throw new Error(`expected ${code}`);
  } catch (err) {
    if (err.code !== code) throw err;
  }
}

async function requestJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function main() {
  if (lastResolvedTurnNumber(1) !== null) throw new Error("turn 1 has no resolved prior turn");
  if (lastResolvedTurnNumber(2) !== 1) throw new Error("turn 2 resolves receipts from turn 1");
  if (
    inboundTradesForRecipient(
      [
        { toAgentId: "a", energy: 1 },
        { toAgentId: "b", energy: 2 }
      ],
      "b"
    ).length !== 1
  ) {
    throw new Error("inbound filter failed");
  }
  const emptyReceipt = transfersReceivedLastTurn(null, [], "x");
  if (emptyReceipt.turnNumber !== null || emptyReceipt.transfers.length !== 0) {
    throw new Error("null turn receipt should be empty");
  }

  assertThrows(
    () =>
      normalizeTransferDisclosure({
        type: "transfer",
        privateDealSnippets: [{ excerpt: "" }]
      }),
    "INVALID_TRADE_SNIPPETS"
  );

  const normalized = normalizeTransferDisclosure({
    type: "transfer",
    toAgentId: "x",
    rationale: "  pact honor  ",
    privateDealSnippets: [
      {
        taskType: "TRADE_ACCEPT",
        channel: "a2a",
        excerpt: "Agreed terms",
        holaVerified: true
      }
    ]
  });
  if (normalized.rationale !== "pact honor") throw new Error("rationale trim failed");
  if (normalized.privateDealSnippets.length !== 1) throw new Error("snippet normalize failed");

  await repo.initializeDatabase();

  const game = await engine.createGame({
    config: {
      minAgents: 2,
      maxAgents: 4,
      finishSurvivorCount: 1,
      maxTurns: 2,
      joiningWindowDurationMs: 0
    }
  });
  await engine.joinGame(game.id, { roditId: "TraderToknA1", displayName: "Cradle A" });
  const agentB = await engine.joinGame(game.id, { roditId: "TraderToknB1", displayName: "Cradle B" });
  await engine.startGame(game.id);

  const agents = await repo.listAgents(game.id);
  const agentA = agents.find((a) => a.roditId === "TraderToknA1");

  await engine.beginExecutionPhase(game.id);

  const gameState = await repo.getGameById(game.id);
  if (gameState.phase !== "execution") {
    throw new Error(`expected execution phase, got ${gameState.phase}`);
  }

  await engine.submitAction(game.id, agentA.id, {
    type: "transfer",
    toAgentId: agentB.id,
    energy: 5,
    rationale: "Water alliance installment",
    privateDealSnippets: [
      {
        taskType: "TRADE_OFFER",
        channel: "email",
        peerTokenId: "trader-b.rodit.near",
        excerpt: "Send 5E now; I send 5W next cycle.",
        holaVerified: true
      }
    ]
  });
  const turnNumber = gameState.current_turn;
  await engine.submitAction(game.id, agentB.id, { type: "none" });

  const trades = await repo.listPublicTrades(game.id, turnNumber);
  if (!trades.length || trades[0].rationale !== "Water alliance installment") {
    throw new Error("expected public trade with rationale");
  }

  const after = await repo.getGameById(game.id);
  if (after.current_turn !== turnNumber + 1 || after.phase !== "negotiation") {
    throw new Error(`expected post-resolve negotiation turn ${turnNumber + 1}, got ${after.phase}/${after.current_turn}`);
  }

  const recipientState = await engine.getPublicState(game.id, { viewerAgentId: agentB.id });
  const inbound = recipientState.you?.transfersReceivedLastTurn;
  if (!inbound || inbound.turnNumber !== turnNumber) {
    throw new Error("recipient state missing transfersReceivedLastTurn for resolved turn");
  }
  if (!inbound.transfers?.length || inbound.transfers[0].fromAgentId !== agentA.id) {
    throw new Error("recipient should see inbound transfer from sender");
  }
  if (inbound.transfers[0].energy !== 5) {
    throw new Error("recipient inbound energy mismatch");
  }
  if (inbound.transfers[0].fromDisplayName !== agentA.displayName) {
    throw new Error("recipient inbound should include fromDisplayName");
  }

  const history = recipientState.you?.transfersReceived;
  if (!history || history.throughTurn !== turnNumber) {
    throw new Error("recipient state missing transfersReceived history through resolved turn");
  }
  if (!history.transfers?.length || history.transfers[0].fromAgentId !== agentA.id) {
    throw new Error("recipient history should include inbound transfer from sender");
  }
  if (history.transfers[0].fromDisplayName !== agentA.displayName) {
    throw new Error("recipient history should include fromDisplayName");
  }

  const senderState = await engine.getPublicState(game.id, { viewerAgentId: agentA.id });
  const senderInbound = senderState.you?.transfersReceivedLastTurn;
  if (!senderInbound || senderInbound.turnNumber !== turnNumber) {
    throw new Error("sender state should still expose transfersReceivedLastTurn block");
  }
  if (senderInbound.transfers?.length) {
    throw new Error("sender should not see own outbound as transfersReceived");
  }
  if (!senderState.you?.transfersReceived || senderState.you.transfersReceived.transfers?.length) {
    throw new Error("sender transfersReceived history should be empty");
  }

  const wakePayloads = [];
  clearWebhookUrlCacheForTests();
  setRoditClient({
    sendWakeHook: async (payload) => {
      wakePayloads.push(payload);
      return { isValid: true, requestId: "trade-wake" };
    }
  });
  blockchainService.nearorg_rpc_tokenfromroditid = async () => ({
    metadata: { webhook_url: "agent-trade.identyclaw.com:9443" }
  });

  await notifyPhaseChange(game.id, {
    status: after.status,
    phase: after.phase,
    currentTurn: after.current_turn,
    negotiationEndsAt: after.negotiation_ends_at,
    executionEndsAt: after.execution_ends_at
  });

  const recipientWake = wakePayloads.find((p) => p.data?.agentId === agentB.id);
  if (!recipientWake || recipientWake.event !== "phase_change") {
    throw new Error("expected phase_change wake for recipient");
  }
  if (recipientWake.data.resolvedTurn !== turnNumber) {
    throw new Error("phase_change should include resolvedTurn");
  }
  if (!recipientWake.data.transfersReceived?.length) {
    throw new Error("phase_change should include transfersReceived for recipient");
  }
  if (recipientWake.data.transfersReceived[0].fromAgentId !== agentA.id) {
    throw new Error("phase_change transfersReceived fromAgentId mismatch");
  }

  const senderWake = wakePayloads.find((p) => p.data?.agentId === agentA.id);
  if (!senderWake || !Array.isArray(senderWake.data.transfersReceived)) {
    throw new Error("phase_change should include transfersReceived array for sender");
  }
  if (senderWake.data.transfersReceived.length !== 0) {
    throw new Error("sender phase_change transfersReceived should be empty");
  }

  setRoditClient(null);
  clearWebhookUrlCacheForTests();

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
    const res = await requestJson(port, `/api/game/games/${game.id}/trades?turn=${turnNumber}`);
    if (res.status !== 200 || !res.body.trades?.[0]?.privateDealSnippets?.length) {
      throw new Error("spectator trades route failed");
    }
    if (res.body.trades[0].fromDisplayName !== agentA.displayName) {
      throw new Error("spectator trades should include fromDisplayName");
    }

    const historyRes = await requestJson(
      port,
      `/api/game/games/${game.id}/trades?history=1&toAgentId=${agentB.id}`
    );
    if (historyRes.status !== 200 || historyRes.body.history !== true) {
      throw new Error("trades?history=1 should set history=true");
    }
    if (historyRes.body.toAgentId !== agentB.id) {
      throw new Error("trades?history=1&toAgentId should echo toAgentId");
    }
    if (
      !historyRes.body.trades?.length ||
      historyRes.body.trades[0].fromAgentId !== agentA.id ||
      historyRes.body.trades[0].fromDisplayName !== agentA.displayName
    ) {
      throw new Error("trades?history=1&toAgentId should return inbound legs with sender name");
    }
    console.log("✓ Trade disclosure validation and public trades route work");
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }

  await repo.closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
