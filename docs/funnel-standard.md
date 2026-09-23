# Funnel standard

> **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

**Created:** 2026-09-21  
**Updated:** 2026-09-23

Cookieless enrollment / activation funnel instrumentation for IdentyClaw and sibling surfaces. Chart **product steps**, not hosts. Join across hops with `tokenIdHash` / `accountId` (and optional `funnel_id` only before a Passport exists)—**not cookies**.

**Related:** [`logging-standard.md`](logging-standard.md) (structured `infoWithContext` / Loki), [`vocabulary-standard.md`](vocabulary-standard.md) (deployment tiers). Channel / growth narrative for operators lives in the home-API repo’s `content/developer-growth-plan.md` (metrics targets only)—instrumentation SoT is **this file**.

## Goals

- Make **land → mint → verify → play → complete** measurable as adjacent step ratios.
- Keep attribution privacy-safe: query string, JSON body, and headers only.
- Emit the same `funnel.*` event names into the **same Loki tenant** from every surface.

## Scope

Applies to:

- Home API funnel emitters (`src/lib/funnel.js` in the home-API service)
- Purchase and verify SPAs that forward attribution and emit `funnel.land` (purchase land → Loki and verify FE helper are incomplete—see [Known gaps](#known-gaps-live-vs-standard))
- Sibling products that emit `funnel.play` / `funnel.complete` (for example Last Cradle)—**target**; FE has no emits; BE unverified
- Optional marketing lands (for example `www.discernible.io`) that preserve UTMs on CTAs

Does **not** require browser analytics SDKs for stitching. Plausible / gtag (or similar) are optional on marketing or game sites only when cookieless or behind an explicit consent gate—and are **not** substitutes for `funnel.*` ladder events.

## Privacy / cookies (hard rule)

Do **not** plant cookies, cookie-sync pixels, or cookie-like identifiers (`document.cookie`, `localStorage` / `sessionStorage` visitor ids) for funnel stitching without prior user permission on that surface.

| Allowed | Forbidden for stitching |
| --- | --- |
| Query params (`utm_*`, `funnel_id` / `vid`) | `Set-Cookie` / `document.cookie` visitor ids |
| JSON body fields on mint / verify / login | `localStorage` / `sessionStorage` visitor ids |
| Headers `X-Campaign-*` / `X-Utm-*` / `X-Funnel-Id` (when CORS allowlist permits) | Cookie-sync pixels, third-party ID graphs |
| In-memory attribution for the current page lifetime | Persisting `funnel_id` in a cookie “for convenience” |

No cookie consent banner is required when the surface plants **zero** stitching cookies.

**Live tension:** Last Cradle FE currently parks UTMs in `sessionStorage`. That conflicts with this rule until those keys are moved to URL/memory only (or consent is obtained on that surface). Purchase Plausible and Last Cradle gtag are **separate** from `funnel.*` and must not be treated as ladder evidence.

## Product step ladder

Primary conversion ladder to chart:

`land` → `mint_success` → `verify` (or `identity_confirmed`) → `play` → `complete`

| Step | Event | Typical emit site |
| --- | --- | --- |
| **land** | `funnel.land` (SPA / marketing) · `funnel.discovery` (API, `step=land`) | Purchase UI (land→Loki unverified), verify UI (no FE helper yet), lastcradle FE, homepage · home API `GET /`, `/.well-known/*`, optional `GET\|POST /api/funnel/land` (not on game API) |
| **mint** | `funnel.mint_attempt` / `funnel.mint_success` / `funnel.mint_failed` | Home API `POST /api/signclient` · purchase UI forwards UTMs |
| **verify** | `funnel.verify_result` | Home API `POST /api/identity/verify` (server-side) · verify UI should forward UTMs in body/query (no dedicated funnel helper yet) |
| **play** | `funnel.play` | Last Cradle first cradle sit / successful join / skill arm (**unverified**—see [Known gaps](#known-gaps-live-vs-standard)) |
| **complete** | `funnel.complete` | Last Cradle eligible Season finish (define “eligible completer” in code comments at the emit site) (**unverified**—see [Known gaps](#known-gaps-live-vs-standard)) |

Supporting (not ladder rungs—keep for diagnostics; chart ladder on `step`): `funnel.mcp_resource`, `funnel.login_challenge`, `funnel.login_result`, `funnel.identity_confirmed`.

Guard against distraction: the largest known product leak is **mint → play**, not cross-domain cookie gaps. If Last Cradle BE does not emit `funnel.play` / `funnel.complete` into the **same Loki tenant**, that gap is the largest ladder hole—larger than purchase land or CORS allowlist misses.

### Domain is metadata

Every emit carries `domain` as **where the event was emitted** (for example `purchase.identyclaw.com`, `verify.identyclaw.com`, `api.identyclaw.com`, `api.lastcradle.io`). Manage conversion by **`step`**, not by host. Use `step × domain` only to see which surface fires each rung.

## Required fields on every emit

Minimum structured fields (drop null / empty before log):

| Field | Required | Notes |
| --- | --- | --- |
| `funnel` | yes | Always `true` |
| `event` | yes | Canonical name, for example `funnel.land` |
| `step` | yes on ladder rungs | `land` \| `mint` \| `verify` \| `play` \| `complete` |
| `domain` | yes | Emitting surface host |
| `result` | yes when applicable | `success` \| `failed` \| `attempt` \| `error` |
| `path` / `uri` | when known | Request path or MCP uri |
| `tokenIdHash` | after mint when token id known | Hash only—never log raw Passport / facial token ids in funnel fields |
| `accountId` | when known | NEAR account from body keys the home API already accepts |
| `funnel_id` | optional pre-mint | Opaque ULID/UUID hop stitch; drop reliance after `mint_success` |
| `utm_source` … `utm_term` | when present | Forward inbound attribution |
| `requestId` | when available | Correlate within a hop |
| `errorCode` | on failures | For *why* drop-off analysis |
| `durationMs` | optional | Operation timing |

Log message shape for Loki searchability: prefer `funnel:<event>` (for example `funnel:funnel.land`) via `logger.infoWithContext`, with the fields above in context. Align with [`logging-standard.md`](logging-standard.md).

## Attribution

### UTM keys

Forward consistently on every paid and owned funnel link (land → purchase → enroll) and on mint / verify / login requests:

```text
?utm_source=<channel>&utm_medium=<paid|email|social>&utm_campaign=<kit-slug>&utm_content=<creative-variant>
```

Optional pre-Passport stitch (still not a cookie):

```text
&funnel_id=<opaque-id>
```

(`funnel_id` alias `vid` on inbound query/body only—normalize to `funnel_id` in logs.)

| Parameter | Examples |
| --- | --- |
| `utm_source` | `newsletter-latent-space`, `reddit`, `substack`, `devto`, `telegram`, `discord`, `x`, `linkedin` |
| `utm_medium` | `paid`, `email`, `social`, `organic` |
| `utm_campaign` | `verify-before-execute`, `onboarding-openclaw`, `openclaw-agent-hive`, `passport-vs-secrets`, `wave_a` |
| `utm_content` | `hook-a`, `thread-3`, `sponsor-cta`, `purchase-cta` |
| `funnel_id` | opaque ULID/UUID minted at land; drop after `mint_success` when `tokenIdHash` exists |

### Landing pages by funnel step

| Step | URL |
| --- | --- |
| land | https://www.discernible.io or https://lastcradle.io/enroll |
| mint | https://purchase.identyclaw.com → `POST https://api.identyclaw.com/api/signclient` |
| verify | https://verify.identyclaw.com / `POST /api/identity/verify` |
| play / complete | https://lastcradle.io/enroll → https://api.lastcradle.io |

### How surfaces may send attribution

Home API collectors accept attribution from, in practice:

1. Query string
2. JSON body fields (`utm_*`, `funnel_id` / `vid`)
3. Headers: `X-Campaign-*`, `X-Utm-*`, `X-Funnel-Id` (and `X-Visitor-Id` as `funnel_id` alias)

SPA browser clients must only send custom headers when the API CORS allowlist includes them. Prefer **JSON body** (and query on GET beacons) when headers would break preflight.

**Live CORS:** Home-API nginx (main + development) allowlists `www.discernible.io`, `discernible.io`, `lastcradle.io`, and `www.lastcradle.io`, and Allow-Headers includes funnel attribution headers. Prefer query/body when a surface cannot rely on that allowlist yet.

### Account id body keys (mint / login)

When forwarding NEAR account id, use a field the home API already resolves, for example:

`accountid` · `account_id` · `accountId` · `owneraccount_id` · `owner_id` · `implicit_account_id`

### Lifecycle of `funnel_id`

1. On land, if absent: mint an opaque ULID/UUID **in memory and the URL** only.
2. Preserve across internal hops (page → page, wallet → mint, verify → purchase CTAs).
3. Forward on `POST /api/signclient`, verify, and login when present.
4. After `mint_success`, **stop relying on `funnel_id`**—`tokenIdHash` / `accountId` take over. Remove it from the URL when convenient; never persist it in a cookie.

## Sibling emit contract

Every sibling surface (purchase, verify, lastcradle, optional homepage) that emits into the shared Loki tenant must:

1. Use the same `funnel.*` event names and `step` values from this standard.
2. Include at least `funnel: true`, `event`, `step`, `domain`, `result`.
3. Join with `tokenIdHash` and/or `accountId` after mint; use `funnel_id` only as a hop param before mint.
4. Forward inbound UTMs + `funnel_id` on every outbound funnel link and on mint / verify / login API calls.
5. Prefer a cookieless land path into the home API (discovery `GET /`, dedicated `GET|POST /api/funnel/land`, or equivalent) so SPA lands appear in the same tenant—query/body attribution only.

Do **not** set a stitching cookie unless the user has consented on that surface.

## Operator queries (LogQL sketches)

Adjust label selectors to the Loki tenant (`app`, etc.):

```logql
# Count by product step
sum by (step) (count_over_time({app="idclawserver"} |= "funnel:" | json | funnel="true" | step!="" [7d]))

# Count by event (includes supporting mid-funnel)
sum by (event) (count_over_time({app="idclawserver"} |= "funnel:" | json | funnel="true" [7d]))

# Step × domain (where each step fires — metadata only)
sum by (step, domain) (count_over_time({app="idclawserver"} |= "funnel:" | json | funnel="true" | step!="" [7d]))

# Mid-funnel: which MCP uris are fetched
sum by (uri) (count_over_time({app="idclawserver"} |= "funnel.mcp_resource" | json [7d]))

# Mint failures by HTTP status / error
sum by (errorCode) (count_over_time({app="idclawserver"} |= "funnel.mint_failed" | json [7d]))

# Login failures
sum by (errorCode) (count_over_time({app="idclawserver"} |= "funnel.login_result" | json | result="failed" [7d]))
```

*Where* drop-off = ratio between adjacent **steps**. *Why* = `errorCode` / `failureReasons` on failed events (plus purchase-portal wallet errors when present).

## How to test

### Unit (home API)

```bash
node scripts/funnel-smoke.js
```

Passes locally. Wired as `npm run funnel:smoke` in the home-API `package.json`.

### Land beacon

```bash
curl -i "https://api.identyclaw.com/api/funnel/land?domain=www.discernible.io&utm_source=manual&utm_campaign=probe&funnel_id=$(uuidgen)"
```

Expect **204**.

### End-to-end hop

1. Land with UTMs (and optional `funnel_id`).
2. Purchase → mint.
3. Confirm Loki lines share `funnel_id`, then `tokenIdHash` / `accountId` after mint.

### Mint attribution

Ensure `POST /api/signclient` carries UTMs / `funnel_id` in the **JSON body** (preferred). Nginx CORS allow-headers on the home API include `X-Funnel-Id`, `X-Visitor-Id`, `X-Funnel-Domain`, `X-Utm-*`, and `X-Campaign-*` (plus the prior auth headers). Prefer body/query when older edges or sibling proxies have not picked up the allowlist yet.

## How to monitor

LogQL sketches live in this file ([Operator queries](#operator-queries-logql-sketches)) and in the home-API `content/developer-growth-plan.md`, against:

```logql
{app="idclawserver"} |= "funnel:" | json | funnel="true"
```

- **Primary chart:** adjacent step ratios, especially **mint → play**.
- **Why drop-off:** `errorCode` on `funnel.mint_failed` and login failures (`funnel.login_result` with `result="failed"`).

When the growth plan and this standard disagree on LogQL or emit contract, **this file wins**.

## Proven reference implementations

| Reference | Role |
| --- | --- |
| Reference (home API / idclawserver-idc) | `src/lib/funnel.js` — `track`, `extractAttribution`, `appendAttribution`, `resolveAccountId`, `STEPS` / `EVENTS`; optional land beacon `GET\|POST /api/funnel/land`. Pin to the funnel-steps PR / merge commit when citing. |
| Reference (mintclient-idc) | `src/utils/funnelAttribution.js` — intended cookieless land on `purchase.identyclaw.com` and `verify.identyclaw.com`; forward on `POST /api/signclient` and `POST /api/identity/verify`; URL/memory only. **Purchase land → Loki is unverified**—see [Known gaps](#known-gaps-live-vs-standard). |

When adding a new surface, copy the sibling emit contract above; do not invent parallel event names or cookie-based visitor ids.

**Canonical doc location:** This file (`funnel-standard.md` in the docs standards tree) is the funnel instrumentation SoT. Do not treat a GitHub path under `discernible-io/docs` as authoritative if that tree 404s on your workstation—use the vendored/copied `docs/funnel-standard.md` beside the service, or this clone. The home-API `developer-growth-plan.md` holds channel / growth narrative and metric *targets* only; when it disagrees with this standard on emit contract, privacy, or LogQL, **this file wins**, then fix the plan.

## Known gaps (live vs standard)

Snapshot as of **2026-09-23**. Treat as verification backlog, not as permission to invent parallel events.

| Gap | Live finding | Impact / next check |
| --- | --- | --- |
| **play / complete unverified** | Not present in Last Cradle FE. Last Cradle BE source inaccessible for this review. Game API has **no** land / funnel land route. | Largest ladder hole if BE does **not** emit `funnel.play` / `funnel.complete` into the **same Loki tenant** as home API. Confirm BE emit path + tenant labels before charting mint→play. |
| **Purchase land → Loki** | Purchase client uses `logger.infoWithContext` with **no Loki URL in the browser bundle**, plus an empty HTTP beacon. Older docs claim purchase nginx proxies `/api/` to the home API; live `purchase.identyclaw.com/api/*` **301 → SPA**. | SPA `funnel.land` from purchase likely never reaches Loki. Prefer a cookieless beacon to home API discovery / `GET\|POST /api/funnel/land` (real API host), or fix nginx so `/api/` reaches the home API instead of the SPA. |
| **Docs drift** | `discernible-io/docs` 404 in environments that expected it. Older growth-plan / purchase notes claimed purchase nginx proxies `/api/` to the home API; live `purchase.identyclaw.com/api/*` **301 → SPA**. | Keep this standard as SoT; do not reintroduce hostname or `/api/` proxy claims into the growth plan. |
| **CORS allowlist** | ~~`www.discernible.io` / `lastcradle.io` missing from nginx CORS origin map.~~ **Fixed** in home-API `nginx.main.conf` / `nginx.development.conf` (origins + `X-Funnel-*` / `X-Utm-*` / `X-Campaign-*` Allow-Headers). | Redeploy nginx for both tiers; confirm preflight from those origins before relying on header attribution. |
| **Privacy tension** | Last Cradle uses `sessionStorage` for UTMs. Purchase Plausible + Last Cradle gtag are separate from `funnel.*`. | Violates the cookieless stitching rule until UTMs are URL/memory-only (or consented). Do not join Plausible/gtag into ladder ratios. |
| **Ops / verify FE** | ~~`funnel-smoke` is **not** in npm scripts.~~ Home API: `npm run funnel:smoke`. Verify UI has **no** funnel helper. | Verify still emits **server-side** on `POST /api/identity/verify` when the client forwards attribution in body/query. Add a verify FE helper when wiring land on that SPA. |

## Checklist for a new emit site

1. Pick the ladder `step` and canonical `event` (or mark as supporting mid-funnel).
2. Set `domain` to the emitting host; set `result` appropriately.
3. Forward inbound `utm_*` + `funnel_id`; mint `funnel_id` in URL/memory only if absent at land.
4. After mint, join on `tokenIdHash` / `accountId`; drop reliance on `funnel_id`.
5. Emit via the shared logger / Loki path—no stitching cookies without consent.
6. Document the emit in the service README with a link to this standard.
