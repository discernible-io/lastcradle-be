/**
 * Smoke checks for Last Cradle funnel helpers (no Express / Loki required).
 * Run: npm run funnel:smoke
 */
const assert = require("assert");
const funnel = require("../src/lib/funnel");

function fakeReq({ query = {}, body = {}, headers = {} } = {}) {
  return {
    query,
    body,
    get(name) {
      const key = String(name).toLowerCase();
      for (const [h, v] of Object.entries(headers)) {
        if (h.toLowerCase() === key) {
          return v;
        }
      }
      return undefined;
    }
  };
}

assert.strictEqual(funnel.STEPS.PLAY, "play");
assert.strictEqual(funnel.STEPS.COMPLETE, "complete");
assert.strictEqual(funnel.STEPS.LAND, "land");
assert.strictEqual(funnel.EVENTS.PLAY, "funnel.play");
assert.strictEqual(funnel.EVENTS.COMPLETE, "funnel.complete");
assert.strictEqual(funnel.EVENTS.DISCOVERY, "funnel.discovery");
assert.strictEqual(funnel.DEFAULT_DOMAIN, "api.lastcradle.io");

const fromQuery = funnel.extractAttribution(
  fakeReq({
    query: {
      utm_source: "discord",
      utm_campaign: "wave_a",
      funnel_id: "fid-1"
    }
  })
);
assert.strictEqual(fromQuery.utm_source, "discord");
assert.strictEqual(fromQuery.utm_campaign, "wave_a");
assert.strictEqual(fromQuery.funnel_id, "fid-1");

const fromVid = funnel.extractAttribution(fakeReq({ query: { vid: "vid-alias" } }));
assert.strictEqual(fromVid.funnel_id, "vid-alias");

const fromHeaders = funnel.extractAttribution(
  fakeReq({
    headers: {
      "X-Campaign-Source": "telegram",
      "X-Funnel-Id": "fid-2"
    }
  })
);
assert.strictEqual(fromHeaders.utm_source, "telegram");
assert.strictEqual(fromHeaders.funnel_id, "fid-2");

const accountId = funnel.resolveAccountId(
  fakeReq({ body: { owneraccount_id: "abc123.near" } })
);
assert.strictEqual(accountId, "abc123.near");

assert.strictEqual(
  funnel.accountIdFromRoditId("bc=near.org;sc=alice.near;sub=AbCdEfGhIjKl"),
  "alice.near"
);
assert.strictEqual(funnel.accountIdFromRoditId("AbCdEfGhIjKl"), null);

const hash = funnel.hashTokenId("AbCdEfGhIjKl");
assert.ok(typeof hash === "string" && hash.length === 16);
assert.notStrictEqual(hash, "AbCdEfGhIjKl");

assert.strictEqual(funnel.joinMethodFromTokenId("guest_01HZYXABCDEFGHJKLMNPQRSTUV"), "guest");
assert.strictEqual(funnel.joinMethodFromTokenId("AbCdEfGhIjKl"), "passport");

const tagged = funnel.appendAttribution("https://purchase.identyclaw.com", {
  utm_source: "x",
  utm_medium: "social",
  utm_campaign: "wave_a",
  utm_content: "purchase-cta",
  funnel_id: "fid-3"
});
assert.ok(tagged.includes("utm_source=x"));
assert.ok(tagged.includes("funnel_id=fid-3"));
assert.ok(!tagged.includes("cookie"), "attribution helper must not mention cookies");

assert.ok(typeof funnel.appendAttribution === "function");
assert.ok(Array.isArray(funnel.UTM_KEYS));
assert.ok(funnel.FUNNEL_ID_KEYS.includes("funnel_id"));
assert.ok(funnel.FUNNEL_ID_KEYS.includes("vid"));

console.log("funnel-smoke: ok");
