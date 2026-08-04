#!/usr/bin/env node
/**
 * Unit checks for game webhook URL resolution and /hooks/wake + /hooks/agent delivery wiring.
 */

const {
  resolveRecipientWebhookUrl,
  lookupWebhookUrlFromChain,
  clearWebhookUrlCacheForTests,
  sendGameWebhook,
  sendGameAgentHook,
  notifyActionSubmitted,
  setRoditClient
} = require("../src/game/webhooks");
const { resolveRoditId } = require("../src/game/route-helpers");
const {
  extractPassportTokenId,
  isNearAccountId,
  canonicalRoditId,
  roditIdFromUser
} = require("../src/game/rodit-id");
const { blockchainService } = require("@rodit/rodit-auth-be");

const ORIGINAL_TOKEN_LOOKUP = blockchainService.nearorg_rpc_tokenfromroditid;
const ORIGINAL_ACCOUNT_LOOKUP = blockchainService.nearorg_rpc_tokensfromaccountid;

const COMPOUND_SUB =
  "bc=near.org;sc=genaaaa-identyclaw-com.near;id=lkcjcjbhzfbn;id=bdsflnlfcfzn;sub=lflvlnbrsfcq";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function testJwtWebhookUrlPassthrough() {
  const url = await resolveRecipientWebhookUrl({
    user: { rodit_id: "TestTokenId1", rodit_webhookurl: "agent-a.identyclaw.com:9443" }
  });
  assert(url === "agent-a.identyclaw.com:9443", "JWT rodit_webhookurl should be used when present");
}

async function testChainLookupByTokenId() {
  blockchainService.nearorg_rpc_tokenfromroditid = async (tokenId) => {
    assert(tokenId === "TestTokenId1", "expected passport token_id lookup");
    return { metadata: { webhook_url: "agent-c.identyclaw.com:9443" } };
  };

  const url = await lookupWebhookUrlFromChain("TestTokenId1");
  assert(url === "agent-c.identyclaw.com:9443", "chain lookup should return metadata.webhook_url");
}

async function testCompoundSubjectUsesTokenLookupNotAccount() {
  let accountLookupCalled = false;
  let tokenLookupId = null;

  blockchainService.nearorg_rpc_tokensfromaccountid = async () => {
    accountLookupCalled = true;
    throw new Error("account lookup must not run for compound JWT subjects");
  };
  blockchainService.nearorg_rpc_tokenfromroditid = async (tokenId) => {
    tokenLookupId = tokenId;
    return { metadata: { webhook_url: "agent-compound.identyclaw.com:9443" } };
  };

  assert(extractPassportTokenId(COMPOUND_SUB) === "lflvlnbrsfcq", "should parse sub= passport id");
  assert(isNearAccountId(COMPOUND_SUB) === false, "compound subject must not be a NEAR account id");
  assert(canonicalRoditId(COMPOUND_SUB) === "lflvlnbrsfcq", "canonical id is passport token");

  const url = await lookupWebhookUrlFromChain(COMPOUND_SUB);
  assert(accountLookupCalled === false, "must not call tokensfromaccountid for compound subjects");
  assert(tokenLookupId === "lflvlnbrsfcq", "must look up by passport token id from sub=");
  assert(url === "agent-compound.identyclaw.com:9443", "compound subject chain lookup should succeed");
}

async function testResolveRoditIdPrefersClientPassportFromSub() {
  // Real login JWTs share server rodit_id; peer identity is in sub=…
  assert(
    resolveRoditId({
      user: { rodit_id: "bjchsfcfskln", sub: COMPOUND_SUB }
    }) === "lflvlnbrsfcq",
    "resolveRoditId should prefer client passport in sub over server rodit_id"
  );
  assert(
    resolveRoditId({ user: { sub: COMPOUND_SUB } }) === "lflvlnbrsfcq",
    "resolveRoditId should canonicalize compound sub"
  );
  assert(
    resolveRoditId({ user: { rodit_id: "AbcdEfghij12" } }) === "AbcdEfghij12",
    "resolveRoditId should fall back to rodit_id when sub has no peer passport"
  );
  assert(
    roditIdFromUser({ roditId: COMPOUND_SUB }) === "lflvlnbrsfcq",
    "roditIdFromUser should canonicalize camelCase compound values"
  );
}

async function testSendWakeHookEndpoint() {
  let capturedEndpoint = null;
  let capturedUser = null;

  setRoditClient({
    sendWakeHook: async (payload, req, options) => {
      capturedUser = req.user;
      capturedEndpoint = "sendWakeHook";
      assert(payload.event === "phase_change", "payload event preserved");
      assert(options.sessionRoditId === "TestTokenId1", "sessionRoditId passed");
      return { isValid: true, requestId: "test-req" };
    }
  });

  blockchainService.nearorg_rpc_tokenfromroditid = async () => ({
    metadata: { webhook_url: "agent-e.identyclaw.com:9443" }
  });

  const result = await sendGameWebhook(
    { event: "phase_change", data: { roditId: "TestTokenId1", gameId: "01TEST" } },
    "TestTokenId1"
  );

  assert(capturedEndpoint === "sendWakeHook", "delivery should use sendWakeHook");
  assert(
    capturedUser?.rodit_webhookurl === "agent-e.identyclaw.com:9443",
    "delivery request should include resolved rodit_webhookurl"
  );
  assert(result.success === true, "successful delivery should normalize success=true");
}

async function testSendAgentHookDeadlineWarning() {
  let capturedEndpoint = null;
  let capturedPayload = null;
  let wakeCalled = false;

  setRoditClient({
    sendWakeHook: async () => {
      wakeCalled = true;
      throw new Error("deadline_warning must not use sendWakeHook");
    },
    sendAgentHook: async (payload, req, options) => {
      capturedEndpoint = "sendAgentHook";
      capturedPayload = payload;
      assert(payload.event === "deadline_warning", "payload event preserved");
      assert(payload.data?.urgency === "deadline", "urgency field preserved");
      assert(options.sessionRoditId === "DeadlineTok1", "sessionRoditId passed");
      assert(
        req.user?.rodit_webhookurl === "agent-deadline.identyclaw.com:9443",
        "delivery request should include resolved rodit_webhookurl"
      );
      return { isValid: true, requestId: "test-agent-req" };
    }
  });

  blockchainService.nearorg_rpc_tokenfromroditid = async () => ({
    metadata: { webhook_url: "agent-deadline.identyclaw.com:9443" }
  });

  const result = await sendGameAgentHook(
    {
      event: "deadline_warning",
      data: {
        roditId: "DeadlineTok1",
        gameId: "01DEADLINE",
        urgency: "deadline",
        taskType: "submit_execution_action",
        message: "SLC deadline warning: required submit_execution_action pending"
      }
    },
    "DeadlineTok1"
  );

  assert(wakeCalled === false, "deadline_warning must not call sendWakeHook");
  assert(capturedEndpoint === "sendAgentHook", "delivery should use sendAgentHook");
  assert(capturedPayload?.event === "deadline_warning", "event must be deadline_warning");
  assert(result.success === true, "successful agent-hook delivery should normalize success=true");

  const viaChannel = await sendGameWebhook(
    {
      event: "deadline_warning",
      data: { roditId: "DeadlineTok1", gameId: "01DEADLINE", urgency: "deadline" }
    },
    "DeadlineTok1",
    { channel: "agent" }
  );
  assert(viaChannel.success === true, "channel:agent should also use sendAgentHook");
}

async function testMissingWebhookUrl() {
  blockchainService.nearorg_rpc_tokenfromroditid = async () => ({ metadata: {} });

  setRoditClient({
    sendWakeHook: async () => {
      throw new Error("sendWakeHook should not run when webhook_url is missing");
    },
    sendAgentHook: async () => {
      throw new Error("sendAgentHook should not run when webhook_url is missing");
    }
  });

  const result = await sendGameWebhook(
    { event: "your_turn", data: { roditId: "MissingUrl12", gameId: "01TEST" } },
    "MissingUrl12"
  );
  assert(result.success === false, "missing webhook_url should return success=false");
  assert(result.error === "WEBHOOK_URL_MISSING", "missing webhook_url should report WEBHOOK_URL_MISSING");

  const agentResult = await sendGameAgentHook(
    { event: "deadline_warning", data: { roditId: "MissingUrl12", gameId: "01TEST" } },
    "MissingUrl12"
  );
  assert(agentResult.success === false, "agent hook missing webhook_url should return success=false");
  assert(
    agentResult.error === "WEBHOOK_URL_MISSING",
    "agent hook missing webhook_url should report WEBHOOK_URL_MISSING"
  );
}

async function testPhaseChangePayloadCanCarryTransfersReceived() {
  let capturedPayload = null;
  setRoditClient({
    sendWakeHook: async (payload) => {
      capturedPayload = payload;
      return { isValid: true, requestId: "phase-inbound" };
    }
  });
  blockchainService.nearorg_rpc_tokenfromroditid = async () => ({
    metadata: { webhook_url: "agent-inbound.identyclaw.com:9443" }
  });

  const result = await sendGameWebhook(
    {
      event: "phase_change",
      data: {
        roditId: "InboundTok12",
        gameId: "01INBOUND",
        phase: "negotiation",
        currentTurn: 2,
        resolvedTurn: 1,
        transfersReceived: [
          {
            id: "act1",
            turnNumber: 1,
            fromAgentId: "sender",
            toAgentId: "recv",
            energy: 3,
            water: 0,
            compute: 0,
            status: "executed"
          }
        ]
      }
    },
    "InboundTok12"
  );

  assert(result.success === true, "phase_change with transfersReceived should deliver");
  assert(capturedPayload?.event === "phase_change", "event preserved");
  assert(capturedPayload?.data?.resolvedTurn === 1, "resolvedTurn preserved");
  assert(
    Array.isArray(capturedPayload?.data?.transfersReceived) &&
      capturedPayload.data.transfersReceived[0].energy === 3,
    "transfersReceived preserved on wake payload"
  );
}

async function testActionSubmittedConfirmationWebhook() {
  let capturedPayload = null;
  setRoditClient({
    sendWakeHook: async (payload) => {
      capturedPayload = payload;
      return { isValid: true, requestId: "action-confirm" };
    }
  });
  blockchainService.nearorg_rpc_tokenfromroditid = async () => ({
    metadata: { webhook_url: "agent-action.identyclaw.com:9443" }
  });

  const result = await notifyActionSubmitted({
    gameId: "01ACTION",
    agent: { id: "agent1", roditId: "ActionTok123", displayName: "Tester" },
    turnNumber: 2,
    action: {
      id: "act1",
      action_type: "invest",
      status: "pending",
      payload_json: JSON.stringify({
        type: "invest",
        production: { target: "water", amount: 2, energy: 2, water: 2, compute: 2 }
      })
    },
    projection: { ok: true, equalInvestCost: { totalResources: 6 } },
    source: "submit"
  });

  assert(result.success === true, "action_submitted should deliver");
  assert(capturedPayload?.event === "action_submitted", "event must be action_submitted");
  assert(capturedPayload?.data?.source === "submit", "source preserved");
  assert(capturedPayload?.data?.actionType === "invest", "actionType from DB row");
  assert(
    capturedPayload?.data?.projection?.equalInvestCost?.totalResources === 6,
    "projection preserved"
  );
}

async function testSurvivalWarningUsesAgentChannel() {
  let capturedEndpoint = null;
  let capturedPayload = null;
  setRoditClient({
    sendWakeHook: async () => {
      throw new Error("survival_warning must not use sendWakeHook");
    },
    sendAgentHook: async (payload) => {
      capturedEndpoint = "sendAgentHook";
      capturedPayload = payload;
      return { isValid: true, requestId: "surv-warn" };
    }
  });
  blockchainService.nearorg_rpc_tokenfromroditid = async () => ({
    metadata: { webhook_url: "agent-surv.identyclaw.com:9443" }
  });

  const result = await sendGameAgentHook(
    {
      event: "survival_warning",
      data: {
        roditId: "SurvTok12345",
        gameId: "01SURV",
        urgency: "survival",
        message: "Survival risk: current stock cannot pay thisTurnSurvivalCost"
      }
    },
    "SurvTok12345"
  );

  assert(result.success === true, "survival_warning agent hook should deliver");
  assert(capturedEndpoint === "sendAgentHook", "survival_warning uses agent channel");
  assert(capturedPayload?.event === "survival_warning", "event preserved");
  assert(capturedPayload?.data?.urgency === "survival", "urgency preserved");
}

async function main() {
  clearWebhookUrlCacheForTests();
  await testJwtWebhookUrlPassthrough();
  clearWebhookUrlCacheForTests();
  await testChainLookupByTokenId();
  clearWebhookUrlCacheForTests();
  await testCompoundSubjectUsesTokenLookupNotAccount();
  clearWebhookUrlCacheForTests();
  await testResolveRoditIdPrefersClientPassportFromSub();
  clearWebhookUrlCacheForTests();
  await testSendWakeHookEndpoint();
  clearWebhookUrlCacheForTests();
  await testSendAgentHookDeadlineWarning();
  clearWebhookUrlCacheForTests();
  await testMissingWebhookUrl();
  clearWebhookUrlCacheForTests();
  await testPhaseChangePayloadCanCarryTransfersReceived();
  clearWebhookUrlCacheForTests();
  await testActionSubmittedConfirmationWebhook();
  clearWebhookUrlCacheForTests();
  await testSurvivalWarningUsesAgentChannel();
  console.log(JSON.stringify({ ok: true, suite: "test-game-webhooks" }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    blockchainService.nearorg_rpc_tokenfromroditid = ORIGINAL_TOKEN_LOOKUP;
    blockchainService.nearorg_rpc_tokensfromaccountid = ORIGINAL_ACCOUNT_LOOKUP;
    clearWebhookUrlCacheForTests();
    setRoditClient(null);
  });
