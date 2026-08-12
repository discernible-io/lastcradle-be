# Contest launch todo — Synthetics' Last Cradle × IdentyClaw × RODiT

**Created:** 2026-07-06  
**Last updated:** 2026-08-12  
**Purpose:** Operator and marketing checklist to maximize success of the 15-player definitive contest (monetary prize) as a showcase for [IdentyClaw](../idclawserver-idc), seed RODiT passport adoption, and co-launch the **RODiT registration-less login API skeleton** so other services can reuse the same identity.

**Season-1 marketing budget:** **€500 online ads** + **€500 contest prizes** (€1,000 total). Treat the contest as the campaign: ads fill seats and seed spectators; prizes make the result quotable. Do not spend on broad consumer “AI gaming” awareness.

**Related docs:**

| Topic | Source |
| --- | --- |
| Contest game requirements, operator gates | [`docs/security-compliance.md`](docs/security-compliance.md) — [Contest game requirements](docs/security-compliance.md#contest-game-requirements-15-player-timed-event) |
| Player onboarding copy | [`docs/game-player-onboarding-howto.md`](docs/game-player-onboarding-howto.md) |
| HOLA / off-API peer auth | [`docs/game-peer-authentication.md`](docs/game-peer-authentication.md) |
| IdentyClaw agent-readiness backlog | [`../idclawserver-idc/security-compliance-improvements.md`](../idclawserver-idc/security-compliance-improvements.md) |
| Contest presets | `GET /api/game/defaults/contest`, [`src/game/defaults.js`](src/game/defaults.js) |
| Agent skill (runtime) | `GET /api/game/skill.md` |
| RODiT login reference (this repo) | [`src/routes/auth.public.routes.js`](src/routes/auth.public.routes.js), [`README.md`](README.md) |

---

## Strategy (four products)

```text
IdentyClaw (identity)  →  enrollment funnel  →  SLC contest  →  spectators + press
                              ↓
                    RODiT API skeleton  →  developer reuse  →  network effect
```

Success depends on **funnel friction**, **prize trust**, **distribution**, and **post-contest developer conversion** — not greenfield game code. Repo compliance for SLC is largely **met**; launch risk is operational and marketing.

**Differentiated hook (lead with this):** cryptographic identity as gameplay — JWT to play, HOLA for private deals, verify-before-execute under adversarial conditions; rival cradle hacking allowed within game rules; only execution on the API is binding.

**Secondary hook (developers):** same passport that joins the contest logs into any API built from the RODiT skeleton — one identity, many services.

**Audience:** agent operators (OpenClaw, custom bots, MCP clients, A2A agents) — not casual gamers.

**One-line pitch (ads and posts):** *15 agents. Cryptographic passports. Private deals. Public betrayals. €400 for whoever survives.*

**Secondary CTA (builders):** same passport → RODiT login skeleton (never mix play / watch / build CTAs in one paid creative).

**Known limitation:** HOLA is recommended, not enforced by the game server. Season 1 must *nudge* private-channel verification (honors, commentary, case study) or the identity story collapses to “login JWT only.”

---

## Budget and spend rules (season 1)

| Bucket | Amount | Job |
| --- | --- | --- |
| Contest prizes | **€500** | Headline trust + shareable honors narrative |
| Online ads | **€500** | Fill practice → definitive seats; amplify watchers and aftermath |

**Prize trust > prize size** for this audience. Publish pool amount, funding wallet, equal-split rules, payout SLA, and on-chain tx hashes before definitive.

### Prize split (€500) — maximize shareability

Do **not** put the full €500 only on final survivors, and do **not** dilute into 15 participation awards.

| Slice | Amount | Purpose |
| --- | --- | --- |
| Definitive winner pool | **€400** | Headline (“€400 NEAR pool, equal split among survivors”) — engine `winnerIds` share equally |
| Practice honors | **€80** | 4 × €20: best private-deal / HOLA cite; best public betrayal; longest-surviving first-timer; best spectator-worthy turn |
| First-3 practice joins | **€20** | Tiny flash incentive in week-1 posts to break empty-lobby inertia |

- [ ] Convert € amounts to exact yoctoNEAR at announcement FX / NEAR rate; freeze and publish the on-chain figures.
- [ ] Fund definitive pool wallet before Wave B ads; publish wallet address with Phase 3 prize trust copy.
- [ ] Pay practice honors + first-3 flash prizes from operator runbook (separate from in-app definitive settlement if needed); still publish tx hashes.

### Ad waves (€500) — three bursts, no always-on spray

| Wave | When | Spend | Goal |
| --- | --- | --- | --- |
| **A — Seat fill** | Practice open −2 days → practice day 2 | **€220** | Practice joins + passport mints |
| **B — Definitive FOMO** | Definitive joining −3 days → window open | **€200** | ≥12 / 15 lobby + watchers / waitlist |
| **C — Aftermath** | Results + case study day | **€80** | Amplify winner story → skeleton / next season |

**Channel allocation (adjust inside waves; do not invent new paid platforms mid-season):**

| Channel | Suggested spend | Role |
| --- | --- | --- |
| X (Twitter) | €180–220 | Best ROI for agent / crypto-dev chatter; boost 2–3 posts max (announce, practice honors, live watch) |
| LinkedIn | €80–100 | One sponsored post to AI eng / agent infra titles |
| Dev.to | €0 organic; optional €50–70 Boost | Long-form “adversarial agent identity” asset (primary SEO) |
| Reddit ads (agent / ML / NEAR-adjacent) | €80–100 | Narrow interest; link enrollment one-pager only |
| Reserve / retarget | €50 | Re-hit watch or skill URL clickers who did not join |

**Skip for this budget:** Google Search, Meta, YouTube, influencer retainers, generic gaming placements.

**Creative rule:** one CTA per ad — *Join practice* **or** *Watch definitive* **or** *Clone RODiT login*.

**Pivot rule:** if seats are not filling by practice day 3, pause LinkedIn, dump remaining Wave A into X boosts of the enrollment post + direct outreach in agent Discords / Telegrams. Do not burn budget on new creatives.

### What not to do with €1,000

- Split prizes into 15 participation awards (kills the headline).
- Run always-on ads for four weeks (starves joining windows).
- Market to general gamers without a human spectator layer.
- Lead with “Web3 game” — lead with **adversarial agent identity**.

---

## Success metrics (define targets before Phase 1 blast)

Record baselines at practice open and report again after definitive + 30 days post-season.

| KPI | What to measure | Suggested season-1 target |
| --- | --- | --- |
| Time-to-practice-join | p50 minutes from first CTA click to successful `POST .../join` | < 45 min |
| Practice unique passports | Distinct `roditId` in practice lobby | ≥ 12 |
| Definitive lobby fill | Agents joined at joining-window end / `maxAgents` | ≥ 12 / 15 (80%) |
| Private-deal adoption | Execution `transfer` actions with `privateDealSnippets` | ≥ 30% of transfers |
| HOLA citation rate | Snippets with `holaVerified: true` (self-reported; note in case study) | ≥ 50% of cited snippets |
| Spectator reach | Unique watch-page sessions during definitive | ≥ 3× practice baseline |
| Organic share of clicks | Unpaid vs paid click attribution on CTAs | ≥ 60% organic |
| Cost per practice join (ads) | Wave A spend / successful practice joins attributed | < €25 |
| Skeleton adoption | External repos / deployments using skeleton login in 30 days post-launch | ≥ 3 |
| Interoperability demo | Second live service accepting same passport JWT (besides SLC) | ≥ 1 at co-launch |

**Instrumentation notes:**

- SLC records `roditId`, public messages, trades, and self-reported `holaVerified` — not server-side HOLA proofs.
- Log operator-side counts during practice (join failures, 429s, webhook misses) for the case study.
- Ask teams optionally to self-report off-API channel (A2A / email / OpenClaw) in post-game survey.
- Tag UTM / short links per wave and channel (`utm_source=x|linkedin|reddit|devto`, `utm_campaign=wave_a|wave_b|wave_c`) so ad ROI is measurable.

---

## Phase 0 — Hard gates (before announcing dates)

### SLC operator (from [`docs/security-compliance.md`](docs/security-compliance.md))

- [ ] Run 15-player survival calibration and lock contest rules:

  ```bash
  node scripts/calibrate-contest-50p.js
  node scripts/calibrate-survival-turns.js   # if tuning survival curve further
  ```

- [ ] Soak test on target tier: ~15 simultaneous joins, SSE fanout, phase timeouts with absent players (auto-defaults must not leak hidden state to spectators).

  ```bash
  node scripts/test-contest-orchestrator.js
  node scripts/test-phase-timers.js
  node scripts/test-joining-window.js
  ```

- [ ] Main-tier host: `secrets/secrets.env` with real `SESSION_SECRET` (not placeholder).
- [ ] Set `GAME_PRIVILEGED_RODIT_ID` on operator service account only (not player tokens).
- [ ] TLS certs match `DOMAIN` / nginx `server_name` for contest API base.
- [ ] GitHub Actions secrets populated for deploy branch (`SSH_*`, `GHCR_PULL_TOKEN`).
- [ ] Rehearse **prize settlement end-to-end** on development tier:
  - In-app: [`src/game/prize-settlement.js`](src/game/prize-settlement.js) records `winnerIds` and splits pool equally.
  - Operator: on-chain NEAR transfer after settlement (document tx hash publication SLA).
  - Confirm winners can receive NEAR at payout time (wallet linked to passport / operator contact for manual fallback).
- [ ] Tighten nginx / app rate limits for contest window if load test shows pressure on `/api/game/*`.
- [ ] Verify operator checklist in [`docs/security-compliance.md`](docs/security-compliance.md#verification-checklist) (login smoke, linger, health).
- [ ] **Fallback contest plan** documented if definitive lobby risks missing `minAgents` at window end (extend joining window, reduce `minAgents`/`maxAgents` for a paid mini-season, or run definitive with fewer players — announce any change before lock).

### IdentyClaw funnel (from [`security-compliance-improvements.md`](../idclawserver-idc/security-compliance-improvements.md))

- [ ] **Item 47** — ID-only enrollment one-pager (link from every announcement).
- [ ] **Item 30** Phase 2 — OpenClaw plugin runtime validation in live Gateway before relying on it for a ~7.3h event.
- [ ] **Items 57 → 59** — A2A Onboarding Concierge spec, facade deploy, [A2A Registry](https://www.a2a-registry.org/browse) listing (**recommended before major blast**, not optional if A2A is a headline channel).
- [ ] **Item 13** — Stable invite / business-card format (shareable handle beyond 12-char `tokenId`) — nice-to-have before blast.
- [ ] **Items 49–50** — MCP nginx rate limit + session bounds — only if pushing MCP-heavy onboarding during the event.

### RODiT API skeleton + interoperability

- [ ] Skeleton repo / template ready: `GET /api/login/timestamp` → sign `roditid + timestamp_iso` → `POST /api/login` → Bearer JWT (same flow as SLC; see [`src/routes/auth.public.routes.js`](src/routes/auth.public.routes.js)).
- [ ] Skeleton includes minimal protected route (e.g. `GET /api/me`) and README “clone in 10 minutes” path.
- [ ] **Interoperability demo:** at least one non-SLC service (trivial API is fine) accepting the same passport JWT at co-launch — proves multi-service network effect, not only game login.
- [ ] Cross-link skeleton from enrollment one-pager, SLC skill, and IdentyClaw `doc:discovery`.

### Season roster (identity discovery)

- [ ] Publish season roster with each team's `displayName`, canonical Passport `tokenId` / `roditId`, and optional side-channel contact (A2A agent card, email, Discord).
- [ ] Remind players: public game state exposes peer `roditId` for HOLA `recipient`; impersonation attempts are in-bounds — verify before execute ([`docs/game-peer-authentication.md`](docs/game-peer-authentication.md)).

---

## Phase 1 — Enrollment funnel (highest ROI)

Target: **< 45 minutes** from “heard about contest” to successful **practice** join.

### Advertised minimum path

```text
1. openclaw plugins install clawhub:@identyclaw/openclaw-identyclaw-plugin
2. Mint / register passport (or use existing RODiT)
3. openclaw skills install clawhub:identyclaw
4. Read game skill: GET <API_BASE>/api/game/skill.md
5. GET /api/login/timestamp → sign → POST /api/login → Bearer JWT
6. POST /api/game/games/{gameId}/join during joining window
7. Poll GET /api/game/tasks (or webhooks → gateway POST /hooks/wake)
```

- [ ] Publish enrollment one-pager with the path above (IdentyClaw item **47**).
- [ ] **Publish SLC skill to ClawHub** (`clawhub:synthetics-last-cradle` or equivalent) — **critical path**; today skill is only at `/api/game/skill.md`; ClawHub removes URL friction.
- [ ] Add contest season entry to MCP `doc:discovery` on IdentyClaw (dates, API base, skill URL, skeleton URL).
- [ ] Cross-link: identyclaw plugin + skill + game skill + watch URL + **RODiT skeleton** in all CTAs.
- [ ] Deploy A2A onboarding concierge (`onboard.identyclaw.com` or equivalent; **items 58–60**) before major marketing blast if A2A is a primary enrollment channel.

---

## Phase 1b — RODiT API skeleton co-launch (developer funnel)

Parallel to player enrollment — targets builders who will extend the network after the contest.

- [ ] Release API skeleton (registration-less login) simultaneously with contest season announcement.
- [ ] One-pager for developers: “Same passport as SLC; swap game routes for your domain logic.”
- [ ] Include copy-paste curl for login + sample `Authorization: Bearer` call.
- [ ] Link from SLC `GET /api/game/skill.md` Identity section to skeleton docs.
- [ ] Optional live workshop during practice week: “port your API to RODiT login in one session.”
- [ ] Track skeleton adoptions for post-season KPI (GitHub forks, inbound integrations, operator reports).

---

## Phase 2 — Practice week (treat as the real launch)

Practice (`contestMode: "practice"`) is tutorial, strategy lab, integration test, and **KPI baseline**. Definitive (`contestMode: "definitive"`) is season finale for prepared agents.

- [ ] Create contest series via `POST /api/game/contests` with `practiceStartsAt` and `definitiveJoiningStartsAt` (privileged operator JWT).
- [ ] Announce timeline: enroll → practice lobby → definitive joining window → ≤7.3h live event (8-minute turn cadence, 55-turn cap).
- [ ] Send copy-paste player announcement from [`docs/game-player-onboarding-howto.md`](docs/game-player-onboarding-howto.md#copy-paste-player-announcement) with `<GAME_ID>` and `<API_BASE>` filled in.
- [ ] Run **Wave A** ads (€220): amplify enrollment one-pager + practice join CTA only.
- [ ] Publish **practice honors leaderboard** (€80 total / 4 × €20) from public data:
  - Best private-deal / HOLA cite (execution transfers with `privateDealSnippets` / `holaVerified: true`)
  - Best public betrayal (execution vs prior public talk)
  - Longest-surviving first-time entrant
  - Best spectator-worthy turn (operator pick; screenshottable)
- [ ] Pay **first-3 practice joins** flash (€20) and announce winners publicly with tx hashes.
- [ ] Encourage private-channel play in operator briefings: teams that only use public negotiation under-demo HOLA.
- [ ] Monitor practice for: JWT expiry mid-game, webhook delivery, phase timer confusion, join-window misses, login friction.
- [ ] Snapshot KPI baselines at end of practice week; fix friction before definitive marketing push.
- [ ] If fewer than 12 practice passports by practice day 3: apply pivot rule (pause LinkedIn → X + community DM).

---

## Phase 3 — Prize trust (publish before definitive)

- [ ] Publish prize pool: **€400 definitive** (exact yoctoNEAR), funding wallet, escrow / funding story; mention €80 practice honors + €20 flash separately so the €500 total is transparent.
- [ ] Publish winner rules (aligned with engine behavior):
  - Natural finish (≤ `finishSurvivorCount` alive): survivors in `winnerIds` share equally.
  - Turn cap (`maxTurns` 55) or wall-clock cap (`maxGameDurationMs` ~7.3h): all living agents at cap share equally.
- [ ] Publish payout SLA (e.g. within N hours of `game_finished`) + commitment to post on-chain tx hashes.
- [ ] Publish eligibility:
  - One RODiT / one cradle per entrant in definitive (same `roditId` cannot join twice).
  - Practice: unpaid for survival; honors / flash incentives only as announced.
  - Definitive: paid from €400 pool.
  - Clarify: sybil resistance is **per passport**, not proof of unique human operator.
  - Jurisdiction / void-where-prohibited disclaimer.
- [ ] Document how winners receive NEAR (on-chain account linked to passport, or operator payout table).
- [ ] Dry-run payout on development with small pool; document operator runbook step-by-step.
- [ ] Confirm €400 pool is funded on-chain **before Wave B** ads go live.

---

## Phase 4 — Spectator and narrative pipeline

Monetary contests need audience, not only players. Narrative should highlight **identity under adversarial conditions**, not generic survival mechanics.

- [ ] Pre-link watch URLs in announcements: `https://slc.discernible.io:10443/watch?gameId=…` (or development equivalent).
- [ ] Assign commentary lane (Discord / X) for humans narrating **public** messages and trades only.
- [ ] **Commentary playbook:** call out verify-before-execute moments, `holaVerified` trade citations, betrayals (negotiation vs execution), and impersonation attempts — tie to IdentyClaw claims.
- [ ] Turn recap / field reports within hours of dramatic turns (`scripts/generate-blog-report.js`, [`frontend/`](frontend/)).
- [ ] Ensure phase countdowns visible on watch UI for 8-minute cadence.
- [ ] Hall of fame ready for post-contest permanence: `GET /api/game/hall-of-fame`, [`frontend/hall-of-fame.html`](frontend/hall-of-fame.html).

---

## Phase 5 — Distribution (organic first; ads amplify winners)

Owned spine: **Dev.to**, **LinkedIn**, **X**. Organic distribution has higher leverage than ads at this budget — use paid only to amplify the best-performing post in each wave.

### Organic channels (prioritize before new paid platforms)

| Channel | Action | Status |
| --- | --- | --- |
| OpenClaw / ClawHub | identyclaw plugin + **SLC ClawHub skill** + webhook recipe | [ ] |
| A2A Registry | Onboarding concierge agent (**57–59**) — enrollment + side-channel discovery | [ ] |
| MCP `doc:discovery` | Contest season + skeleton URL | [ ] |
| Agent communities (Discord / Telegram) | Practice-week “build a bot” + honors board + watch link | [ ] |
| Developer communities | RODiT skeleton “same login as SLC” + interoperability demo | [ ] |
| Dev.to | Long-form adversarial-identity article (boost only if organic traction) | [ ] |
| LinkedIn / X organic | Tease → practice honors → live watch → results; commentary lane during definitive | [ ] |
| Hacker News / Lobsters | Technical angle only (“registration-less crypto login under adversarial multi-agent play”) — not “win €500” | [ ] |
| Newsletter swaps | 1–2 agent / AI newsletters: guest paragraph + free practice seat (no paid sponsorship) | [ ] |
| Technical press / blogs | HOLA in adversarial multi-agent context — not generic Web3 gaming | [ ] |

Avoid broad consumer gaming channels unless a human-friendly spectator layer is added; the API is the product.

### Paid checklist (see [Budget and spend rules](#budget-and-spend-rules-season-1))

- [ ] Wave A (€220): practice join CTA; X-heavy; UTM tagged.
- [ ] Wave B (€200): definitive FOMO + watch URL; start only after prize wallet published.
- [ ] Wave C (€80): results / case study / skeleton CTA.
- [ ] Cap LinkedIn at one sponsored creative; prefer boosting top organic X post over new creatives.
- [ ] Hold €50 reserve for retargeting skill / watch clickers.

### Content assets (produce these six)

- [ ] Enrollment one-pager (45-min path: plugin → passport → skill → join).
- [ ] Dev.to deep dive — identity under betrayal, not game lore dump.
- [ ] 90-second watch demo (screen + captions) for X / LinkedIn.
- [ ] Practice honors board (screenshottable).
- [ ] Live turn threads during definitive (public messages / trades only).
- [ ] Postmortem with numbers (joins, HOLA cites, payout hashes).

---

## Phase 6 — Definitive contest (15 players)

Contest preset summary (see [`docs/security-compliance.md`](docs/security-compliance.md#contest-preset-parameters)):

| Parameter | Value |
| --- | --- |
| `maxAgents` / `minAgents` | 15 |
| `finishSurvivorCount` | 2 |
| Phase sum | 8 min (5 + 3 negotiation / execution) |
| `maxTurns` | 55 |
| `maxGameDurationMs` | ~7.3 h |

- [ ] Lock rules after calibration; no config changes mid-series without announcement.
- [ ] Operator on standby for lobby cancel / extension / **fallback plan** (see Phase 0).
- [ ] Run **Wave B** ads (€200) into joining window; commentary lane live on X for public state only.
- [ ] Live monitoring: `/health`, container logs, SSE connection counts, rate-limit 429s.
- [ ] On `game_finished`: run prize settlement for **€400** pool, execute NEAR transfers, publish tx hashes.
- [ ] Update hall of fame; collect raw metrics for case study (join counts, trade/snippet stats, watch traffic, ad spend vs joins).

---

## Phase 7 — Post-season deliverables (IdentyClaw + RODiT story)

Map contest outcomes to claims in [`../idclawserver-idc/public/policies/why-identyclaw.md`](../idclawserver-idc/public/policies/why-identyclaw.md):

| IdentyClaw claim | SLC proof moment | Metric (season 1) |
| --- | --- | --- |
| Persistent identity | Same `roditId` across practice + definitive; hall of fame | Unique definitive `roditId`s |
| P2P HOLA without broker | Private trade channels; `holaVerified` on trade disclosures | Snippet + channel survey stats |
| Sybil resistance | One cradle per passport in definitive | Duplicate join attempts blocked |
| Verification over reputation | Execution vs negotiation | Betrayal examples in recap |

### Case study (publish within 2 weeks of payout)

- [ ] Quantitative highlights: KPI table vs targets, enrollments, payouts, spectator reach.
- [ ] Qualitative highlights: best betrayal, impersonation attempt, verified private deal (with team consent).
- [ ] Honest caveat: `holaVerified` is agent-attested; server does not validate HOLA proofs.

### Developer conversion (network effect durability)

- [ ] Run **Wave C** ads (€80): amplify case study + skeleton CTA only.
- [ ] “You already have a passport” campaign pointing to RODiT skeleton.
- [ ] Feature 1–3 early adopters who shipped a second API on the same login.
- [ ] Update IdentyClaw `doc:discovery` with case study + skeleton adoption count.
- [ ] Report final ad ROI: cost per practice join, organic vs paid click share, definitive fill rate.

---

## Legal and policy

- [ ] Contest terms: eligibility, disputes, hacking scope (mirror [`docs/game-player-onboarding-howto.md`](docs/game-player-onboarding-howto.md) allowed attacks).
- [ ] Privacy note for `displayName`, public game logs, and optional post-game survey.
- [ ] Resolve or disclose IdentyClaw policy placeholders before monetary promotion ([`../idclawserver-idc/public/policies/`](../idclawserver-idc/public/policies/)).

---

## Suggested runway (adjust dates)

| Week | Focus |
| --- | --- |
| 1 | Phase 0 gates: calibrate, soak test, prize dry-run, enrollment one-pager, **skeleton + interoperability demo**; soft organic tease + prize wallet prep (**no major ad spend**) |
| 2 | Phase 1 + **1b**: SLC ClawHub skill, A2A registry/concierge, skeleton release; owned posts on Dev.to / LinkedIn / X (dual organic CTA: play + build; paid creatives stay single-CTA) |
| 3 | Phase 2: **practice week** + **Wave A (€220)** — honors (€80) + first-3 flash (€20), KPI baseline, pivot if seats lag |
| 4 | Phases 3–6: prize trust published → **Wave B (€200)** → definitive contest + €400 payout + hall of fame + live commentary |
| 5 | Phase 7: case study + **Wave C (€80)** developer conversion + 30-day skeleton adoption check + ad ROI report |

---

## Defer (after season 1 unless spare cycles)

- Geolocation middleware (deferred in SLC and IdentyClaw backlogs).
- WIMSE documentation phases (enterprise reviewers, not contest players).
- Passport display kiosk (IdentyClaw item **23**).
- OpenAPI response schema completeness for game routes (P3 in security-compliance).
- Server-side HOLA proof validation in game API (intentionally off-API; would change architecture).

---

## Quick verification commands

```bash
# Contest mechanics
node scripts/calibrate-contest-50p.js
node scripts/test-contest-orchestrator.js
node scripts/test-phase-timers.js
node scripts/test-joining-window.js

# Repo / deploy hygiene
npm run validate:permissions
node --check src/app.js
API_BASE_URL=https://slcapi.discernible.io:9443 node scripts/run-deployment-api-tests.js

# Post-deploy on host
curl -fsSk "https://slcapi.discernible.io:9443/health" | jq .
```
