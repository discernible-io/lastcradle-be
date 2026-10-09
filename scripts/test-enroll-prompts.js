#!/usr/bin/env node
/**
 * Operator enroll prompts: runtime-split sit/isolated pastes + guest + strategy.
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

function byId(prompts, id) {
  return prompts.find((p) => p.id === id);
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
  assert(prod.version === "1.6.2", "enroll prompts version 1.6.2");
  assert(prod.skillVersion === SKILL_VERSION, `skill pin ${SKILL_VERSION}`);
  assert(prod.apiBase === "https://api.lastcradle.io", `prod apiBase ${prod.apiBase}`);
  assert(prod.prompts.length === 6, "six prompts");
  const expectedIds = [
    "sit-cradle",
    "sit-cradle-hermes",
    "guest-webhook",
    "isolated-tick",
    "isolated-tick-hermes",
    "strategy"
  ];
  assert(
    prod.prompts.map((p) => p.id).join(",") === expectedIds.join(","),
    `prompt ids order: ${prod.prompts.map((p) => p.id).join(",")}`
  );
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
  for (const prompt of attributed.prompts) {
    const text = `${prompt.title}\n${prompt.blurb}\n${prompt.markdown}`;
    assert(!/funnel/i.test(text), `${prompt.id} must not mention funnel ids`);
    assert(!/\bvid\b/i.test(text), `${prompt.id} must not mention vid`);
  }

  const sit = byId(prod.prompts, "sit-cradle").markdown;
  const sitHermes = byId(prod.prompts, "sit-cradle-hermes").markdown;
  const guest = byId(prod.prompts, "guest-webhook").markdown;

  for (const [name, md] of [
    ["sit", sit],
    ["sit-hermes", sitHermes],
    ["guest", guest]
  ]) {
    assert(md.includes("LOGIN FIRST"), `${name} login-first gate`);
    assert(md.includes("Hard stop"), `${name} hard stop gate`);
    assert(md.includes("AFTER SEAT"), `${name} after-seat handoff`);
    assert(md.includes("Clear stale JWT") || md.includes("stale JWT") || md.includes("Clear stale"), `${name} clear JWT before login`);
    assert(md.includes("/games/mine") || md.includes("/tick-context"), `${name} forbids pre-auth routes`);
    assert(md.includes(`refuse`) && md.includes(SKILL_VERSION), `${name} skill pin`);
    assert(md.includes("/api/game/skill.md"), `${name} handoff to skill.md`);
    assert(md.includes("/api/game/action-schema.md"), `${name} handoff to action-schema`);
    assert(md.includes("/api/game/peer-auth.md"), `${name} handoff to peer-auth`);
    assert(md.length <= LOGIN_PROMPT_SOFT_MAX, `${name} stays compact for paste (${md.length})`);
    assert(!md.includes("## Isolated tick"), `${name} no inlined isolated-tick body`);
    assert(!md.includes("model-call-started"), `${name} no isolated-tick diet detail`);
  }

  assert(sit.includes("OpenClaw"), "sit is OpenClaw-branded");
  assert(sit.includes('"agentType": "openclaw"') || sit.includes('"agentType":"openclaw"'), "sit pins agentType openclaw");
  assert(sit.includes("identyclaw_ensure_session"), "sit uses OpenClaw ensure_session");
  assert(sit.includes("Do **not** use join-by-url") || sit.includes("Do **not** use join-by-url") || sit.includes("join-by-url on this prompt"), "sit forbids join-by-url");
  assert(sit.includes("isolated-tick"), "sit handoff names isolated-tick");
  assert(sit.includes("Ask me (operator)") || sit.includes("Ask me"), "sit asks operator for strategy");
  assert(!sit.includes("idcp ensure_session"), "OpenClaw sit does not push Hermes idcp as primary");

  assert(sitHermes.includes("Hermes"), "hermes sit branded");
  assert(sitHermes.includes('"agentType": "hermes"') || sitHermes.includes('"agentType":"hermes"'), "hermes sit pins agentType");
  assert(sitHermes.includes("idcp ensure_session"), "hermes sit uses idcp");
  assert(sitHermes.includes("--base https://api.lastcradle.io"), "hermes sit pins --base");
  assert(sitHermes.includes("isolated-tick-hermes"), "hermes sit handoff to hermes tick");
  assert(sitHermes.includes("--no-agent") || sitHermes.includes("no-agent"), "hermes sit cost: no-agent");
  assert(sitHermes.includes("Do NOT attach skill") || sitHermes.includes("synthetics-last-cradle"), "hermes sit bans skill on cron");
  assert(sitHermes.includes("/tmp/lc_jwt.txt"), "hermes sit JWT file path");

  assert(guest.includes("Guests cannot use HOLA"), "guest after-seat notes no HOLA");
  assert(guest.includes("jwtLen"), "guest jwtLen in after-seat seat confirm");
  assert(guest.includes("cannot create lobbies") || guest.includes("cannot** create"), "guest cannot create");
  assert(guest.includes("Empty → STOP") || guest.includes("empty → STOP"), "guest empty lobby wait");
  assert(guest.includes("full contest") || guest.includes("whole game"), "guest whole-game session");
  assert(!guest.includes("guest-reclaim") && !guest.includes("guest_reclaim"), "guest must not mention reclaim");
  assert(guest.includes("curl -s -X POST") || guest.includes('curl ${flags}'), "prod guest curl without forced -sk");
  assert(!guest.includes("curl -sk -X POST"), "prod guest must not force -sk");
  assert(guest.includes("$HOME/.slc/guest.jwt"), "guest durable JWT file");
  assert(guest.includes("never** copy") || guest.includes("never copy"), "guest forbid copying JWT from chat");
  assert(guest.includes("filter") && guest.includes("mask"), "guest JWT filter failure mode");
  assert(guest.includes("storeAuth"), "guest OpenClaw storeAuth optional path");
  assert(guest.includes("OpenClaw bearer-http") || guest.includes("bearer-http"), "guest bearer-http is optional");
  assert(byId(prod.prompts, "guest-webhook").title.includes("no passport"), "guest prompt title is universal");
  assert(guest.includes("never bare") || guest.includes("ENDPOINT_NOT_FOUND") || guest.includes("bare GET"), "guest bare-GET /games/{id} warning");
  assert(guest.includes("contexts") && (guest.includes("auth/storage") || guest.includes("lobby quiet")), "guest lobby tick-context empty warning");
  assert(guest.includes("sit-cradle-hermes") || guest.includes("sit-cradle"), "guest points to passport sit prompts");

  const isolated = byId(prod.prompts, "isolated-tick").markdown;
  assert(isolated.includes("OpenClaw executor") || isolated.includes("executor ONLY"), "isolated-tick OpenClaw executor title");
  assert(isolated.includes("lightContext"), "isolated-tick lightContext");
  assert(isolated.includes("Timeout < interval") || isolated.includes("timeout") && isolated.includes("interval"), "isolated-tick timeout < interval");
  assert(isolated.includes("guest.jwt") || isolated.includes("bearer:lastcradle"), "isolated-tick guest Bearer path");
  assert(isolated.includes("never ensure_session") || isolated.includes("Never ensure_session") || isolated.includes("never ensure_session"), "isolated-tick forbids ensure_session on guest");
  assert(isolated.includes("contexts:[]") || isolated.includes("contexts[]"), "isolated-tick lobby contexts expectation");
  assert(!isolated.includes("GET /api/game/skill.md") || isolated.toLowerCase().includes("do not") && isolated.includes("skill.md"), "isolated-tick must forbid skill.md fetch");
  assert(isolated.includes("afterStorageAndSurvival") || isolated.includes("survives"), "isolated-tick keeps projection gate");
  assert(isolated.includes("Session split"), "isolated-tick hard session split");

  const isolatedHermes = byId(prod.prompts, "isolated-tick-hermes").markdown;
  assert(isolatedHermes.includes("Hermes executor"), "hermes tick branded");
  assert(isolatedHermes.includes("--no-agent"), "hermes tick prefers --no-agent");
  assert(
    isolatedHermes.includes("Do NOT load skill") ||
      (isolatedHermes.includes("without") && isolatedHermes.includes("--skill")),
    "hermes tick bans skill"
  );
  assert(isolatedHermes.includes("Budget: max 6") || isolatedHermes.includes("max 6 tool rounds"), "hermes tick tool budget");
  assert(isolatedHermes.includes("/tmp/lc_jwt.txt"), "hermes tick JWT file");
  assert(isolatedHermes.includes("idcp ensure_session"), "hermes tick idcp fallback");
  assert(isolatedHermes.includes("afterStorageAndSurvival") || isolatedHermes.includes("survives"), "hermes tick projection gate");
  assert(isolatedHermes.includes("slc_tick.py"), "hermes tick script path");

  const strategy = byId(prod.prompts, "strategy").markdown;
  assert(strategy.includes("afterStorageAndSurvival"), "strategy mentions projection gate");
  assert(strategy.includes("no skill.md on cron") || strategy.includes("no Sonnet"), "strategy cost rules");
  assert(strategy.includes("isolated tick is executor-only") || strategy.includes("executor-only"), "strategy session split");

  assert(byId(prod.prompts, "sit-cradle").blurb.toLowerCase().includes("openclaw"), "sit blurb names OpenClaw");
  assert(byId(prod.prompts, "sit-cradle-hermes").blurb.toLowerCase().includes("hermes"), "hermes sit blurb");
  assert(
    byId(prod.prompts, "guest-webhook").blurb.toLowerCase().includes("practice"),
    "guest blurb says season practice"
  );
  assert(guest.includes("not eligible for the prize"), "guest joins even when not prize-eligible");
  assert(guest.includes('contestMode: "practice"') || guest.includes("contestMode: `practice`") || guest.includes("`practice`"), "guest names practice mode");
  assert(!guest.includes("Contest seats require a Passport"), "guest prompt does not refuse contest practice seats");
  assert(byId(prod.prompts, "isolated-tick").blurb.toLowerCase().includes("executor"), "isolated blurb executor");
  assert(byId(prod.prompts, "isolated-tick-hermes").blurb.toLowerCase().includes("no-agent") || byId(prod.prompts, "isolated-tick-hermes").blurb.toLowerCase().includes("cheap"), "hermes tick blurb cost");

  const dev = buildEnrollPromptsPayload(mockReq("slcapi.dihola.io"));
  assert(dev.apiBase.includes(":9443"), `dev apiBase should pin :9443, got ${dev.apiBase}`);
  assert(
    dev.docs.passportPurchase.replace(/\/$/, "") === "https://purchase.dihola.io",
    "dev passport purchase"
  );
  assert(dev.prompts.some((p) => p.markdown.includes("curl -sk")), "dev TLS note");

  console.log("test-enroll-prompts: ok");
}

main();
