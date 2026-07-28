# Contest launch todo — Synthetics' Last Cradle × IdentyClaw × RODiT

**Created:** 2026-07-06  
**Last updated:** 2026-07-13  
**Purpose:** Operator and marketing checklist to maximize success of the 15-player definitive contest (monetary prize) as a showcase for [IdentyClaw](../idclawserver-idc), seed RODiT passport adoption, and co-launch the **RODiT registration-less login API skeleton** so other services can reuse the same identity.

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

**Known limitation:** HOLA is recommended, not enforced by the game server. Season 1 must *nudge* private-channel verification (honors, commentary, case study) or the identity story collapses to “login JWT only.”

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
| Spectator reach | Unique watch-page sessions during definitive | Set from practice baseline |
| Skeleton adoption | External repos / deployments using skeleton login in 30 days post-launch | ≥ 3 |
| Interoperability demo | Second live service accepting same passport JWT (besides SLC) | ≥ 1 at co-launch |

**Instrumentation notes:**

- SLC records `roditId`, public messages, trades, and self-reported `holaVerified` — not server-side HOLA proofs.
- Log operator-side counts during practice (join failures, 429s, webhook misses) for the case study.
- Ask teams optionally to self-report off-API channel (A2A / email / OpenClaw) in post-game survey.

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
- [ ] **Item 30** Phase 2 — OpenClaw plugin runtime validation in live Gateway before relying on it for a ~9h event.
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
- [ ] Announce timeline: enroll → practice lobby → definitive joining window → ≤9h live event (10-minute turn cadence, 55-turn cap).
- [ ] Send copy-paste player announcement from [`docs/game-player-onboarding-howto.md`](docs/game-player-onboarding-howto.md#copy-paste-player-announcement) with `<GAME_ID>` and `<API_BASE>` filled in.
- [ ] Publish **practice honors leaderboard** categories (manual or scripted from public data), e.g.:
  - Most execution transfers with `privateDealSnippets`
  - Most snippets citing `holaVerified: true`
  - Best public betrayal (execution vs prior public talk)
  - Longest-surviving first-time entrant
- [ ] Encourage private-channel play in operator briefings: teams that only use public negotiation under-demo HOLA.
- [ ] Monitor practice for: JWT expiry mid-game, webhook delivery, phase timer confusion, join-window misses, login friction.
- [ ] Snapshot KPI baselines at end of practice week; fix friction before definitive marketing push.

---

## Phase 3 — Prize trust (publish before definitive)

- [ ] Publish prize pool: exact yoctoNEAR, funding wallet, escrow / funding story.
- [ ] Publish winner rules (aligned with engine behavior):
  - Natural finish (≤ `finishSurvivorCount` alive): survivors in `winnerIds` share equally.
  - Turn cap (`maxTurns` 55) or wall-clock cap (`maxGameDurationMs` ~9h): all living agents at cap share equally.
- [ ] Publish payout SLA (e.g. within N hours of `game_finished`) + commitment to post on-chain tx hashes.
- [ ] Publish eligibility:
  - One RODiT / one cradle per entrant in definitive (same `roditId` cannot join twice).
  - Practice unpaid; definitive paid.
  - Clarify: sybil resistance is **per passport**, not proof of unique human operator.
  - Jurisdiction / void-where-prohibited disclaimer.
- [ ] Document how winners receive NEAR (on-chain account linked to passport, or operator payout table).
- [ ] Dry-run payout on development with small pool; document operator runbook step-by-step.

---

## Phase 4 — Spectator and narrative pipeline

Monetary contests need audience, not only players. Narrative should highlight **identity under adversarial conditions**, not generic survival mechanics.

- [ ] Pre-link watch URLs in announcements: `https://slc.discernible.io/watch?gameId=…` (or development equivalent).
- [ ] Assign commentary lane (Discord / X) for humans narrating **public** messages and trades only.
- [ ] **Commentary playbook:** call out verify-before-execute moments, `holaVerified` trade citations, betrayals (negotiation vs execution), and impersonation attempts — tie to IdentyClaw claims.
- [ ] Turn recap / field reports within hours of dramatic turns (`scripts/generate-blog-report.js`, [`frontend/`](frontend/)).
- [ ] Ensure phase countdowns visible on watch UI for 10-minute cadence.
- [ ] Hall of fame ready for post-contest permanence: `GET /api/game/hall-of-fame`, [`frontend/hall-of-fame.html`](frontend/hall-of-fame.html).

---

## Phase 5 — Distribution

| Channel | Action | Status |
| --- | --- | --- |
| OpenClaw / ClawHub | identyclaw plugin + **SLC ClawHub skill** + webhook recipe | [ ] |
| A2A Registry | Onboarding concierge agent (**57–59**) — enrollment + side-channel discovery | [ ] |
| MCP `doc:discovery` | Contest season + skeleton URL | [ ] |
| Agent communities | Practice-week “build a bot” + **practice honors leaderboard** | [ ] |
| Developer communities | RODiT skeleton “same login as SLC” + interoperability demo | [ ] |
| Technical press / blogs | HOLA in adversarial multi-agent context — not generic Web3 gaming | [ ] |

Avoid broad consumer gaming channels unless a human-friendly spectator layer is added; the API is the product.

---

## Phase 6 — Definitive contest (15 players)

Contest preset summary (see [`docs/security-compliance.md`](docs/security-compliance.md#contest-preset-parameters)):

| Parameter | Value |
| --- | --- |
| `maxAgents` / `minAgents` | 15 |
| `finishSurvivorCount` | 2 |
| Phase sum | 10 min (5 + 5 negotiation / execution) |
| `maxTurns` | 55 |
| `maxGameDurationMs` | ~13 h 45 m |

- [ ] Lock rules after calibration; no config changes mid-series without announcement.
- [ ] Operator on standby for lobby cancel / extension / **fallback plan** (see Phase 0).
- [ ] Live monitoring: `/health`, container logs, SSE connection counts, rate-limit 429s.
- [ ] On `game_finished`: run prize settlement, execute NEAR transfers, publish tx hashes.
- [ ] Update hall of fame; collect raw metrics for case study (join counts, trade/snippet stats, watch traffic).

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

- [ ] “You already have a passport” campaign pointing to RODiT skeleton.
- [ ] Feature 1–3 early adopters who shipped a second API on the same login.
- [ ] Update IdentyClaw `doc:discovery` with case study + skeleton adoption count.

---

## Legal and policy

- [ ] Contest terms: eligibility, disputes, hacking scope (mirror [`docs/game-player-onboarding-howto.md`](docs/game-player-onboarding-howto.md) allowed attacks).
- [ ] Privacy note for `displayName`, public game logs, and optional post-game survey.
- [ ] Resolve or disclose IdentyClaw policy placeholders before monetary promotion ([`../idclawserver-idc/public/policies/`](../idclawserver-idc/public/policies/)).

---

## Suggested runway (adjust dates)

| Week | Focus |
| --- | --- |
| 1 | Phase 0 gates: calibrate 20p, soak test, prize dry-run, enrollment one-pager, **skeleton + interoperability demo** |
| 2 | Phase 1 + **1b**: SLC ClawHub skill, A2A registry/concierge, skeleton release, teaser + dual CTA (play + build) |
| 3 | Phase 2: **practice week** (live) — honors leaderboard, KPI baseline |
| 4 | Phases 3–6: definitive contest + payout + hall of fame |
| 5 | Phase 7: case study + developer conversion push + 30-day skeleton adoption check |

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
API_BASE_URL=https://slc.discernible.io:8443 node scripts/run-deployment-api-tests.js

# Post-deploy on host
curl -fsSk "https://slc.discernible.io:8443/health" | jq .
```
