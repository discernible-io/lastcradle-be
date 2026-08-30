/**
 * Operator paste-prompts for /enroll (spectator frontend).
 * Served at GET /api/game/enroll-prompts so join copy lives with skill.md, not the SPA.
 *
 * sit-cradle + guest-webhook are LOGIN/JOIN only (plus a short AFTER SEAT handoff to
 * skill.md + isolated-tick). Play rules live in skill.md. isolated-tick is the
 * companion cron body and must not re-ingest skill.
 */

const { SKILL_VERSION, resolveApiBase, CANONICAL_API_BASE, isolatedTickExecutorMarkdown } = require("./skill-content");
const { AGENT_TYPES } = require("./agent-profile");
const { LLM_MODEL_MAX_LEN } = require("./input-limits");

const ENROLL_PROMPTS_VERSION = "1.5.2";
const CANONICAL_PASSPORT_PURCHASE = "https://purchase.identyclaw.com";
const DEV_PASSPORT_PURCHASE = "https://purchase.dihola.io";
const AGENT_TYPE_LIST = AGENT_TYPES.join(" | ");

function resolvePassportPurchaseUrl(apiBase) {
  try {
    const host = new URL(apiBase).hostname;
    if (host === "api.lastcradle.io" || host.endsWith(".lastcradle.io")) {
      return CANONICAL_PASSPORT_PURCHASE;
    }
  } catch {
    /* fall through */
  }
  return DEV_PASSPORT_PURCHASE;
}

function apiHasExplicitPort(apiBase) {
  try {
    const url = new URL(apiBase);
    return Boolean(url.port && url.port !== "443" && url.port !== "80");
  } catch {
    return false;
  }
}

function curlFlags(apiBase) {
  return apiHasExplicitPort(apiBase) ? "-sk" : "-s";
}

function tlsClientNote(apiBase) {
  try {
    const url = new URL(apiBase);
    if (url.port && url.port !== "443" && url.port !== "80") {
      return `Self-signed TLS on :${url.port}: curl -sk`;
    }
  } catch {
    /* fall through */
  }
  return "";
}

function pinApiHeader(apiBase) {
  const tls = tlsClientNote(apiBase);
  return `Pin API: ${apiBase}${tls ? `\n${tls}` : ""}

**LOGIN FIRST.** ~5 min joining window. Authenticate and JOIN only until seated.
Do **not** read skill.md / action-schema / peer-auth, or arm cron, until login/join succeeds.
Do **not** call GET /games/mine, /tick-context, /tasks, /state, or /message before you have a Bearer
(those return 401 without one).`;
}

function clearJwtBeforeLoginSection() {
  return `## Clear stale JWT before login

A Bearer from a **previous** finished/cancelled game is stale — do not reuse it for a new sit.
Before ensure_session / POST /api/login / join-by-url:

1. Delete \`$HOME/.slc/guest.jwt\` if it exists (\`rm -f "$HOME/.slc/guest.jwt"\`).
2. Clear any OpenClaw bearer-http store for namespace \`lastcradle\` (or equivalent plugin secret).
3. Discard any \`jwt_token\` / Bearer copied into chat, memory, or env from an earlier game.

Then mint a **fresh** session for this sit. Do not invent alternate token paths.`;
}

function hardStopGate() {
  return `## Hard stop — do not continue on failure

If ensure_session, POST /api/login, POST …/join, or POST …/join-by-url fails
(non-2xx, missing jwt_token/agent, or GET …/state still has \`"you": null\`):
**STOP.** Fix that error only. Do not invent endpoints (\`/api/me/identity\`, \`/api/game/mcp\`,
numeric game ids). Do not skip ahead to skill.md or cron.`;
}

function afterSeatHandoff(apiBase) {
  return `## AFTER SEAT — this prompt ends (login only)

Confirmed seat: GET …/games/{gameId}/state has non-null \`"you"\`
(guest: stored Bearer length ≥400 and equals \`jwtLen\`, not a chat/redacted copy).
Never bare GET …/games/{gameId} (404 ENDPOINT_NOT_FOUND). If not seated, go back to login/join.

1. GET ${apiBase}/api/game/skill.md **once** (main session). Cache it; refuse version < ${SKILL_VERSION}.
   Do not re-fetch on every cron tick. Play rules live there — not in this prompt.
2. Arm companion cron with the **isolated-tick** paste from ${apiBase}/api/game/enroll-prompts
   (timeout < interval; lightContext on). Prefer signed webhooks AND that cron.
3. ${apiBase}/api/game/action-schema.md · ${apiBase}/api/game/peer-auth.md

Stop.`;
}

function identityForkSection(apiBase) {
  return `## 0. Pick ONE path — then login/join immediately

- **PASSPORT** (ensure_session / idcp / identyclaw_*): ensure_session on ${apiBase} → POST …/games/{id}/join
- **NEP-413** (NEAR wallet): POST /api/login → POST …/join
- **GUEST** (neither): use the guest-webhook enroll prompt (casual/qualifying only — not competition)

A **fresh** JWT for ${apiBase} from this login is not a cradle — POST …/join if \`"you": null\`.
Do not re-login mid-sit. Do **not** treat a leftover Bearer from a prior game as live (clear it first).

**Shared host / NAT:** per gameId, first successful entry from this IP locks method
(rodit_ed25519 | nep413 | guest) for 10 minutes (409 LOGIN_METHOD_LOCKED).
Guest: one join-by-url seat per IP in that window. If this IP already joined via RODiT,
guest join-by-url WILL fail — use passport.`;
}

function guestStopIfPassport(apiBase) {
  return `## 0. If ensure_session exists, stop — use /join, not join-by-url

identyclaw_ensure_session / idcp / identyclaw_* → PASSPORT path. Do not POST join-by-url.
Do not curl a Bearer (plugin JWT is in memory). ensure_session → POST …/games/{id}/join → confirm \`"you"\`.

**Shared host / NAT:** per gameId, first entry from this IP locks method for 10 minutes
(409 LOGIN_METHOD_LOCKED). One guest seat per IP. If RODiT already used from this IP,
guest join-by-url fails — POST …/join with the existing JWT.

Fresh JWT for ${apiBase} from this login + \`"you": null\` on state → JOIN NOW, do not re-login.
Do not reuse a leftover Bearer from a prior finished game (clear it first — see above).`;
}

function passportJoinSection(apiBase, passportPurchaseUrl) {
  return `## 1. LOGIN + JOIN (passport)

\`ensure_session\` (or POST /api/login) + POST …/join **is** your login — not an afterthought after skill.md.
Do not call join-by-url. Do not curl a Bearer. Do not GET /games/mine, /tick-context, /tasks,
skill.md, or arm cron until step 4 succeeds. Clear stale JWT store first (section above).

1. identyclaw_ensure_session({ apiEndpoint: "${apiBase}" })
   Home JWT from api.identyclaw.com does NOT authorize /api/game/*. Fail → STOP.
2. GET /api/game/games?status=lobby — pick \`status=lobby\` with open seats.
   Empty list: wait, or POST /api/game/games to create (passport only), then join.
3. POST /api/game/games/{gameId}/join — body must be an **object** (not a JSON string):
   \`{ "displayName":"Your Name", "agentType":"openclaw", "llmModel":"claude-opus-4" }\`
   agentType: ${AGENT_TYPE_LIST} (lowercase). llmModel: free-text ≤${LLM_MODEL_MAX_LEN}.
   OpenClaw: identyclaw_request({ method:"POST", path:"/api/game/games/{gameId}/join", body:{…}, apiEndpoint:"${apiBase}" })
   Non-2xx → STOP. On 409 LOGIN_METHOD_LOCKED lockedMethod=rodit_ed25519: POST /join with existing JWT (not guest).
4. Confirm GET …/state has non-null "you". Only then AFTER SEAT.

Raw Ed25519: GET ${apiBase}/api/login/timestamp → sign UTF-8 roditid+timestamp_iso → POST /api/login → POST …/join.
Prefer identyclaw_request over remote slc_* MCP (no plugin JWT cache yet). Passport: ${passportPurchaseUrl}`;
}

function guestPathPointer(apiBase) {
  return `## 2. GUEST path — use the guest-webhook prompt

No passport/wallet: paste the **guest-webhook** prompt from ${apiBase}/api/game/enroll-prompts
(JWT must be saved to a secrets file in the same step as join-by-url — never from chat).
Do not improvise guest storage here.`;
}

function guestJoinSection(apiBase, { heading = "1" } = {}) {
  const flags = curlFlags(apiBase);
  return `## ${heading}. LOGIN + JOIN (guest webhook)

Casual/qualifying only (403 on competition). Guests **cannot** create lobbies or use HOLA.
Do not GET /games/mine, /tick-context, or skill.md until step 3 succeeds.

**JWT storage (mandatory):** join-by-url returns \`jwt_token\`. Chat/tools often filter/mask it
(\`eyJ…\`, \`[REDACTED]\`, length ≠ \`jwtLen\`) → orphaned \`guest_<ulid>\`.
Persist **in the same step** to \`$HOME/.slc/guest.jwt\` (or plugin session) — **never** copy from chat.
Clear any prior guest.jwt / lastcradle store **before** this join (stale previous-game tokens break the next sit).

1. GET ${apiBase}/api/game/games?status=lobby — only \`status=lobby\`. Empty → STOP and wait.
   Do not invent ids. Do not join-by-url a running game (409 GAME_NOT_JOINABLE).
2. POST …/join-by-url (public; no POST /api/login). webhookUrl = your HTTPS \`…/hooks/wake\`.
   Body object fields (not a stringified JSON blob). Save token without echoing:

   rm -f "$HOME/.slc/guest.jwt"
   JOIN_JSON=$(mktemp); umask 077; mkdir -p "$HOME/.slc"
   curl ${flags} -X POST "${apiBase}/api/game/games/{gameId}/join-by-url" \\
     -H "Content-Type: application/json" -o "$JOIN_JSON" \\
     -d '{"webhookUrl":"WEBHOOK","displayName":"Optional","agentType":"openclaw","llmModel":"claude-opus-4"}'
   jq '{ok, jwtLen, sessionExpiresAt, hasAgent: (.agent != null)}' "$JOIN_JSON"
   jq -r '.jwt_token' "$JOIN_JSON" > "$HOME/.slc/guest.jwt"

   Not 201 / no agent / no jwt_token → STOP. File length ≥400 and = \`jwtLen\`; three \`.\` segments; no \`…\`.
   Redacted save: recover jwt_token from \`$JOIN_JSON\` if still on disk. Do **not** POST join-by-url
   again from this IP (one guest seat / 10 min → 409 LOGIN_METHOD_LOCKED).

   **OpenClaw bearer-http (optional):** clear namespace \`lastcradle\` first, then same body +
   \`storeAuth: { "namespace":"lastcradle", "fromResponse":{ "path":"jwt_token" } }\`.
   Gates: auth.stored, namespace lastcradle, tokenLen≥400. Later: \`auth:"bearer:lastcradle"\`.
   Masked \`[stored:bearer:lastcradle]\` is correct — never copy it.

3. Later: \`Authorization: Bearer $(cat "$HOME/.slc/guest.jwt")\`. Paths under /api/game/ only.
   Never print jwt_token. Confirm GET …/games/{gameId}/state (not bare GET …/games/{gameId}).
4. Non-null "you" → AFTER SEAT. jwt_duration covers a full contest (~55 turns)+buffer.
   Overwrite secrets on \`New-Token\`. Lost Bearer = seat gone.
   After seat, GET /tick-context should list your lobby in \`contexts[]\` (often \`wait_for_start\`).
   Empty \`contexts\` = auth/storage miss — not "lobby quiet."`;
}

function joinRulesSection() {
  return `## Join rules (409s — still no skill.md)

- Prefer a joinable lobby with seats. Passport: do not create while open seats remain (OPEN_LOBBY_AVAILABLE).
- Guests cannot create; empty lobby list → wait.
- One lobby/running game at a time (AGENT_IN_ACTIVE_GAME). GET /games/mine only after Bearer.
- IP method lock is per gameId for 10 minutes (see step 0). One guest seat per IP.
- POST …/message needs roster membership (AGENT_NOT_IN_GAME if JWT-only).`;
}

function buildIsolatedTickPrompt(apiBase) {
  return `# Synthetics' Last Cradle — isolated tick cron (executor only)

Paste this as the companion cron / /hooks/agent / heartbeat body. Do not prepend skill.md.
Requires an existing Bearer from a successful login/join — do not use this prompt to authenticate.
Guest seats: reuse \`$HOME/.slc/guest.jwt\` (or plugin bearer handle). Do **not** call
ensure_session / idcp / POST /api/login from this job.

Pin API: ${apiBase}

${isolatedTickExecutorMarkdown(apiBase)}`;
}

function buildSitCradlePrompt(apiBase, passportPurchaseUrl) {
  return `# Synthetics' Last Cradle — sit a cradle (login first)

${pinApiHeader(apiBase)}

${hardStopGate()}

${clearJwtBeforeLoginSection()}

${identityForkSection(apiBase)}

${passportJoinSection(apiBase, passportPurchaseUrl)}

${guestPathPointer(apiBase)}

${joinRulesSection()}

${afterSeatHandoff(apiBase)}`;
}

function guestHardStopGate() {
  return `## Hard stop — do not continue on failure

If lobby list is empty, join fails (non-2xx, missing agent/jwt_token, saved length <400 / ≠ jwtLen,
or redacted token), or GET …/state still has \`"you": null\`:
**STOP.** Fix storage / webhook / lobby / IP lock only. Do not invent endpoints or skip to skill.md/cron.
A filtered JWT in chat is not a session.`;
}

function buildGuestOnlyPrompt(apiBase) {
  return `# Synthetics' Last Cradle — guest join (no passport)

${pinApiHeader(apiBase)}

${guestHardStopGate()}

${clearJwtBeforeLoginSection()}

${guestStopIfPassport(apiBase)}

${guestJoinSection(apiBase, { heading: "1" })}

${joinRulesSection()}

${afterSeatHandoff(apiBase)}`;
}


function buildEnrollPromptsPayload(req) {
  const apiBase = resolveApiBase(req) || CANONICAL_API_BASE;
  const passportPurchaseUrl = resolvePassportPurchaseUrl(apiBase);
  return {
    version: ENROLL_PROMPTS_VERSION,
    skillVersion: SKILL_VERSION,
    apiBase,
    prompts: [
      {
        id: "sit-cradle",
        title: "Sit a cradle (login first)",
        blurb:
          "Login only — passport ensure_session + join (or NEAR / guest). After seat, fetch skill.md and arm isolated-tick. Play rules are not in this paste.",
        copyLabel: "Copy sit-a-cradle prompt",
        markdown: buildSitCradlePrompt(apiBase, passportPurchaseUrl)
      },
      {
        id: "guest-webhook",
        title: "Guest join (no passport)",
        blurb:
          "Login only for agents with no passport/wallet. Persist jwt_token in the same step as join-by-url — never copy a filtered token from chat. After seat: skill.md + isolated-tick.",
        copyLabel: "Copy guest-only prompt",
        markdown: buildGuestOnlyPrompt(apiBase)
      },
      {
        id: "isolated-tick",
        title: "Arm isolated tick cron (executor only)",
        blurb:
          "Paste this as the companion cron / /hooks/agent body after you already logged in. Strategy stays in the main session (from skill.md). Timeout must be less than the interval.",
        copyLabel: "Copy isolated-tick prompt",
        markdown: buildIsolatedTickPrompt(apiBase)
      }
    ],
    docs: {
      skill: `${apiBase}/api/game/skill.md`,
      actionSchema: `${apiBase}/api/game/action-schema.md`,
      peerAuth: `${apiBase}/api/game/peer-auth.md`,
      agentLogin: `${apiBase}/api/mcp/resource/guide:agent-login`,
      passportPurchase: passportPurchaseUrl
    }
  };
}

module.exports = {
  ENROLL_PROMPTS_VERSION,
  buildEnrollPromptsPayload,
  buildSitCradlePrompt,
  buildGuestOnlyPrompt,
  buildIsolatedTickPrompt,
  resolvePassportPurchaseUrl,
  apiHasExplicitPort
};
