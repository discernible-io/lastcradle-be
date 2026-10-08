#!/usr/bin/env node
/**
 * Operator enroll prompts: login-only sit/guest pastes + isolated-tick executor.
 */

const {
  ENROLL_PROMPTS_VERSION,
  buildEnrollPromptsPayload
} = require("../src/game/enroll-prompt-content");
const { SKILL_VERSION } = require("../src/game/skill-content");

/** Soft ceiling — better Telegram paste, not a hard Bot API guarantee. */
const LOGIN_PROMPT_SOFT_MAX = 8000;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function mockReq(host, { query = {}, headers = {} } = {}) {
  return {
    protocol: "https",
    query,
    get: (h) => {
      const key = String(h || "").toLowerCase();
      if (key === "host") return host;
      if (key === "x-forwarded-proto") return "https";
      return headers[key] || null;
    }
  };
}

function main() {
  const prod = buildEnrollPromptsPayload(mockReq("api.lastcradle.io"));
  assert(prod.version === ENROLL_PROMPTS_VERSION, "bundle version");
  assert(prod.version === "1.5.5", "enroll prompts version 1.5.5");
  assert(prod.skillVersion === SKILL_VERSION, `skill pin ${SKILL_VERSION}`);
  assert(prod.apiBase === "https://api.lastcradle.io", `prod apiBase ${prod.apiBase}`);
  assert(prod.prompts.length === 3, "three prompts");
  assert(prod.prompts[0].id === "sit-cradle", "sit-cradle first");
  assert(prod.prompts[1].id === "guest-webhook", "guest-webhook second");
  assert(prod.prompts[2].id === "isolated-tick", "isolated-tick third");
  assert(
    prod.docs.passportPurchase.replace(/\/$/, "") === "https://purchase.identyclaw.com",
    "prod passport purchase"
  );

  const attributed = buildEnrollPromptsPayload(
    mockReq("api.lastcradle.io", {
      query: {
        utm_source: "newsletter",
        utm_campaign: "season",
        funnel_id: "fid-should-not-leak",
        vid: "vid-should-not-leak"
      },
      headers: { "x-funnel-id": "header-fid-should-not-leak" }
    })
  );
  assert(
    attributed.docs.passportPurchase.includes("utm_source=newsletter"),
    "prompts keep UTMs on purchase URL"
  );
  assert(
    attributed.docs.passportPurchase.includes("utm_campaign=season"),
    "prompts keep utm_campaign on purchase URL"
  );
  assert(
    !attributed.docs.passportPurchase.includes("funnel_id"),
    "docs.passportPurchase must not embed funnel_id"
  );
  assert(
    !attributed.docs.passportPurchase.includes("vid="),
    "docs.passportPurchase must not embed vid"
  );
  const attributedBlob = JSON.stringify(attributed);
  assert(!attributedBlob.includes("fid-should-not-leak"), "no query funnel_id in enroll payload");
  assert(!attributedBlob.includes("vid-should-not-leak"), "no query vid in enroll payload");
  assert(!attributedBlob.includes("header-fid-should-not-leak"), "no header funnel_id in enroll payload");
  assert(!attributedBlob.includes("funnel_id="), "no funnel_id= query in enroll payload");

  const sit = prod.prompts[0].markdown;
  const guest = prod.prompts[1].markdown;
  for (const [name, md] of [
    ["sit", sit],
    ["guest", guest]
  ]) {
    assert(md.includes("LOGIN FIRST"), `${name} login-first gate`);
    assert(md.includes("Hard stop"), `${name} hard stop gate`);
    assert(md.includes("AFTER SEAT"), `${name} after-seat handoff`);
    assert(md.includes("fetch docs, then ask the operator"), `${name} after-seat asks operator`);
    assert(md.includes("Ask your human operator"), `${name} asks operator for strategy`);
    assert(md.includes("mechanics only"), `${name} docs are mechanics only`);
    assert(md.includes("Stop until the operator has given strategy guidance"), `${name} stops for operator`);
    assert(md.includes("guide:agent-login"), `${name} optional agent-login ref`);
    assert(md.includes("Clear stale JWT") || md.includes("stale JWT"), `${name} clear JWT before login`);
    assert(md.includes("guest.jwt") || md.includes("lastcradle") || name === "sit", `${name} names JWT store to clear`);
    assert(md.includes("/games/mine"), `${name} mentions /games/mine`);
    assert(md.includes("before you have a Bearer"), `${name} forbid auth routes before Bearer`);
    assert(md.includes(`refuse version < ${SKILL_VERSION}`), `${name} skill pin in handoff`);
    assert(md.includes("/api/game/skill.md"), `${name} handoff to skill.md`);
    assert(md.includes("isolated-tick"), `${name} handoff to isolated-tick`);
    assert(md.includes("/api/game/action-schema.md"), `${name} handoff to action-schema`);
    assert(md.includes("/api/game/peer-auth.md"), `${name} handoff to peer-auth`);
    assert(md.length <= LOGIN_PROMPT_SOFT_MAX, `${name} stays compact for paste (${md.length})`);
    // Play/execution content must live in skill.md — not duplicated here.
    assert(!md.includes("afterStorageAndSurvival"), `${name} no projection gate (skill only)`);
    assert(!md.includes("Strategy (required"), `${name} no strategy section`);
    assert(!md.includes("Post-seat mechanics"), `${name} no post-seat mechanics section`);
    assert(!md.includes("## Isolated tick"), `${name} no inlined isolated-tick body`);
    assert(!md.includes("model-call-started"), `${name} no isolated-tick diet detail`);
  }

  assert(sit.includes("HOLA if available"), "sit after-seat mentions HOLA if available");
  assert(guest.includes("Guests cannot use HOLA"), "guest after-seat notes no HOLA");
  assert(!guest.includes("HOLA if available"), "guest after-seat does not suggest HOLA");
  assert(guest.includes("jwtLen"), "guest jwtLen in after-seat seat confirm");

  assert(guest.includes("cannot create lobbies") || guest.includes("cannot** create"), "guest cannot create");
  assert(guest.includes("Empty → STOP") || guest.includes("empty → STOP") || guest.includes("If `games` is empty"), "guest empty lobby wait");
  assert(guest.includes("jwtLen"), "guest jwtLen validation hint");
  assert(guest.includes("whole game") || guest.includes("full contest"), "guest whole-game session");
  assert(!guest.includes("guest-reclaim") && !guest.includes("guest_reclaim"), "guest must not mention reclaim");
  assert(guest.includes("curl -s -X POST") || guest.includes("curl ${flags}"), "prod guest curl without forced -sk");
  assert(!guest.includes("curl -sk -X POST"), "prod guest must not force -sk");
  assert(guest.includes("$HOME/.slc/guest.jwt"), "guest durable JWT file");
  assert(guest.includes("never** copy") || guest.includes("never copy"), "guest forbid copying JWT from chat");
  assert(guest.includes("filter") && guest.includes("mask"), "guest JWT filter failure mode");
  assert(guest.includes("storeAuth"), "guest OpenClaw storeAuth optional path");
  assert(guest.includes("OpenClaw bearer-http") || guest.includes("bearer-http"), "guest bearer-http is optional");
  assert(prod.prompts[1].title.includes("no passport"), "guest prompt title is universal");

  assert(guest.includes("never bare") || guest.includes("ENDPOINT_NOT_FOUND") || guest.includes("bare GET"), "guest bare-GET /games/{id} warning");
  assert(guest.includes("contexts") && (guest.includes("auth/storage") || guest.includes("lobby quiet")), "guest lobby tick-context empty warning");

  const isolated = prod.prompts[2].markdown;
  assert(isolated.includes("executor only"), "isolated-tick executor title");
  assert(isolated.includes("lightContext"), "isolated-tick lightContext");
  assert(isolated.includes("timeout must be strictly less"), "isolated-tick timeout < interval");
  assert(isolated.includes("Guest:") || isolated.includes("guest.jwt"), "isolated-tick guest Bearer path");
  assert(isolated.includes("Never** call ensure_session") || isolated.includes("Never call ensure_session") || isolated.includes("**Never** call ensure_session"), "isolated-tick forbids ensure_session on guest");
  assert(isolated.includes("contexts: []") || isolated.includes("contexts[]"), "isolated-tick lobby contexts expectation");
  assert(!isolated.includes("GET /api/game/skill.md") || isolated.includes("Do **not** GET /api/game/skill.md"), "isolated-tick must forbid skill.md fetch");
  assert(isolated.includes("afterStorageAndSurvival") || isolated.includes("survives"), "isolated-tick keeps projection gate");
  assert(prod.prompts[2].blurb.toLowerCase().includes("operator"), "isolated-tick blurb mentions operator guidance");

  assert(sit.includes("Pick ONE path"), "sit identity fork");
  assert(sit.includes("guest-webhook"), "sit points guests to guest-webhook prompt");
  assert(sit.includes("is** your login") || sit.includes("**is** your login"), "sit passport frames ensure_session+join as login");
  assert(sit.includes("login first"), "sit title prioritizes login");
  assert(guest.includes("If ensure_session exists"), "guest stop-if-passport");
  assert(!guest.includes("Passport join (most fleet"), "guest prompt omits passport join section");
  assert(!sit.includes("$HOME/.slc/guest.jwt") || sit.includes("Clear stale JWT"), "sit clear-JWT may name guest.jwt; omits full join recipe");
  // Sit clear section may mention guest.jwt path; full curl recipe must stay on guest only.
  assert(!sit.includes("join-by-url\"") && !sit.includes("jq -r '.jwt_token'"), "sit omits guest JWT file recipe");
  assert(guest.includes("rm -f") && guest.includes("guest.jwt"), "guest clears guest.jwt before join");
  assert(prod.prompts[0].blurb.toLowerCase().includes("login only"), "sit blurb says login only");
  assert(
    prod.prompts[1].blurb.toLowerCase().includes("casual") ||
      prod.prompts[1].blurb.toLowerCase().includes("qualifying"),
    "guest blurb says casual/qualifying"
  );
  assert(prod.prompts[0].blurb.toLowerCase().includes("operator"), "sit blurb mentions operator");
  assert(
    prod.prompts[1].blurb.toLowerCase().includes("passport") ||
      prod.prompts[1].blurb.toLowerCase().includes("jwt"),
    "guest blurb mentions passport or jwt"
  );

  const dev = buildEnrollPromptsPayload(mockReq("slcapi.dihola.io"));
  assert(dev.apiBase.includes(":9443"), `dev apiBase should pin :9443, got ${dev.apiBase}`);
  assert(
    dev.docs.passportPurchase.replace(/\/$/, "") === "https://purchase.dihola.io",
    "dev passport purchase"
  );
  assert(dev.prompts[0].markdown.includes("curl -sk"), "dev TLS note");

  console.log("test-enroll-prompts: ok");
}

main();
