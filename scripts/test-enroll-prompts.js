#!/usr/bin/env node
/**
 * Operator enroll prompts: live skill pin, projection gate, write path /message.
 */

const {
  ENROLL_PROMPTS_VERSION,
  buildEnrollPromptsPayload
} = require("../src/game/enroll-prompt-content");
const { SKILL_VERSION } = require("../src/game/skill-content");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function mockReq(host) {
  return {
    protocol: "https",
    get: (h) => (h === "host" ? host : h === "x-forwarded-proto" ? "https" : null)
  };
}

function main() {
  const prod = buildEnrollPromptsPayload(mockReq("api.lastcradle.io"));
  assert(prod.version === ENROLL_PROMPTS_VERSION, "bundle version");
  assert(prod.skillVersion === SKILL_VERSION, `skill pin ${SKILL_VERSION}`);
  assert(prod.apiBase === "https://api.lastcradle.io", `prod apiBase ${prod.apiBase}`);
  assert(prod.prompts.length === 2, "two prompts");
  assert(prod.prompts[0].id === "sit-cradle", "sit-cradle first");
  assert(prod.prompts[1].id === "guest-webhook", "guest-webhook second");
  assert(prod.docs.passportPurchase === "https://purchase.identyclaw.com", "prod passport purchase");

  const sit = prod.prompts[0].markdown;
  const guest = prod.prompts[1].markdown;
  for (const [name, md] of [
    ["sit", sit],
    ["guest", guest]
  ]) {
    assert(md.includes(`refuse version < ${SKILL_VERSION}`), `${name} skill pin`);
    assert(md.includes("afterStorageAndSurvival"), `${name} projection gate`);
    assert(md.includes("never baseline.survives"), `${name} never baseline`);
    assert(!md.includes("read baseline.survives"), `${name} must not gate on baseline`);
    assert(md.includes("POST …/message") || md.includes("POST .../message"), `${name} write /message`);
    assert(!md.includes("POST …/messages") && !md.includes("POST .../messages"), `${name} no POST /messages`);
    assert(md.includes("Do not re-fetch"), `${name} cache skill on isolated ticks`);
    assert(md.includes("survival-only") || md.includes("companion cron"), `${name} isolated-tick diet`);
  }

  assert(sit.includes("Pick ONE path"), "sit identity fork");
  assert(guest.includes("If ensure_session exists"), "guest stop-if-passport");
  assert(!guest.includes("Passport join (most fleet"), "guest prompt omits passport join section");

  const dev = buildEnrollPromptsPayload(mockReq("slcapi.dihola.io"));
  assert(dev.apiBase.includes(":9443"), `dev apiBase should pin :9443, got ${dev.apiBase}`);
  assert(dev.docs.passportPurchase === "https://purchase.dihola.io", "dev passport purchase");
  assert(dev.prompts[0].markdown.includes("curl -sk"), "dev TLS note");

  console.log("test-enroll-prompts: ok");
}

main();
