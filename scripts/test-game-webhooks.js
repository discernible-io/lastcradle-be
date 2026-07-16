#!/usr/bin/env node
/**
 * Unit checks for game webhook URL resolution and /hooks/wake delivery wiring.
 */

const {
  resolveRecipientWebhookUrl,
  lookupWebhookUrlFromChain,
  clearWebhookUrlCacheForTests,
  sendGameWebhook,
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

async function testResolveRoditIdPrefersSnakeCaseAndCanonicalizes() {
  assert(
    resolveRoditId({
      user: { rodit_id: "AbcdEfghij12", sub: COMPOUND_SUB }
    }) === "AbcdEfghij12",
    "resolveRoditId should prefer JWT rodit_id"
  );
  assert(
    resolveRoditId({ user: { sub: COMPOUND_SUB } }) === "lflvlnbrsfcq",
    "resolveRoditId should canonicalize compound sub"
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

async function testMissingWebhookUrl() {
  blockchainService.nearorg_rpc_tokenfromroditid = async () => ({ metadata: {} });

  setRoditClient({
    sendWakeHook: async () => {
      throw new Error("sendWakeHook should not run when webhook_url is missing");
    }
  });

  const result = await sendGameWebhook(
    { event: "your_turn", data: { roditId: "MissingUrl12", gameId: "01TEST" } },
    "MissingUrl12"
  );
  assert(result.success === false, "missing webhook_url should return success=false");
  assert(result.error === "WEBHOOK_URL_MISSING", "missing webhook_url should report WEBHOOK_URL_MISSING");
}

async function main() {
  clearWebhookUrlCacheForTests();
  await testJwtWebhookUrlPassthrough();
  clearWebhookUrlCacheForTests();
  await testChainLookupByTokenId();
  clearWebhookUrlCacheForTests();
  await testCompoundSubjectUsesTokenLookupNotAccount();
  clearWebhookUrlCacheForTests();
  await testResolveRoditIdPrefersSnakeCaseAndCanonicalizes();
  clearWebhookUrlCacheForTests();
  await testSendWakeHookEndpoint();
  clearWebhookUrlCacheForTests();
  await testMissingWebhookUrl();
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
