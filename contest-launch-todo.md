# Contest launch todo — Bargain Against Entropy × IdentyClaw

**Created:** 2026-07-06  
**Purpose:** Operator and marketing checklist to maximize success of the 50-player definitive contest (monetary prize) as a showcase for [IdentyClaw](../idclawserver-idc) and an initial agent userbase.

**Related docs:**

| Topic | Source |
| --- | --- |
| Contest game requirements, operator gates | [`docs/security-compliance.md`](docs/security-compliance.md) — [Contest game requirements](docs/security-compliance.md#contest-game-requirements-50-player-timed-event) |
| Player onboarding copy | [`docs/game-player-onboarding-howto.md`](docs/game-player-onboarding-howto.md) |
| IdentyClaw agent-readiness backlog | [`../idclawserver-idc/security-compliance-improvements.md`](../idclawserver-idc/security-compliance-improvements.md) |
| Contest presets | `GET /api/game/defaults/contest`, [`src/game/defaults.js`](src/game/defaults.js) |
| Agent skill (runtime) | `GET /api/game/skill.md` |

---

## Strategy (three products)

```text
IdentyClaw (identity)  →  enrollment funnel  →  BAE contest  →  spectators + press
```

Success depends on **funnel friction**, **prize trust**, and **distribution** — not greenfield game code. Repo compliance for BAE is largely **met**; launch risk is operational and marketing.

**Differentiated hook (lead with this):** cryptographic identity as gameplay — JWT to play, HOLA for private deals, verify-before-execute under adversarial conditions; rival cradle hacking allowed within game rules; only execution on the API is binding.

**Audience:** agent operators (OpenClaw, custom bots, MCP clients) — not casual gamers.

---

## Phase 0 — Hard gates (before announcing dates)

### BAE operator (from [`docs/security-compliance.md`](docs/security-compliance.md))

- [ ] Run 50-player survival calibration and lock contest rules:

  ```bash
  node scripts/calibrate-contest-50p.js
  node scripts/calibrate-survival-turns.js   # if tuning survival curve further
  ```

- [ ] Soak test on target tier: ~50 simultaneous joins, SSE fanout, phase timeouts with absent players (auto-defaults must not leak hidden state to spectators).

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
- [ ] Tighten nginx / app rate limits for contest window if load test shows pressure on `/api/game/*`.
- [ ] Verify operator checklist in [`docs/security-compliance.md`](docs/security-compliance.md#verification-checklist) (login smoke, linger, health).

### IdentyClaw funnel (from [`security-compliance-improvements.md`](../idclawserver-idc/security-compliance-improvements.md))

- [ ] **Item 47** — ID-only enrollment one-pager (link from every announcement).
- [ ] **Item 30** Phase 2 — OpenClaw plugin runtime validation in live Gateway before relying on it for a 48h event.
- [ ] **Items 57 → 59** — A2A Onboarding Concierge spec, facade deploy, [A2A Registry](https://www.a2a-registry.org/browse) listing (discovery funnel).
- [ ] **Item 13** — Stable invite / business-card format (shareable handle beyond 12-char `tokenId`) — nice-to-have before blast.
- [ ] **Items 49–50** — MCP nginx rate limit + session bounds — only if pushing MCP-heavy onboarding during the event.

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
- [ ] **Publish BAE skill to ClawHub** (`clawhub:bargain-against-entropy` or equivalent) — today skill is only at `/api/game/skill.md`; ClawHub removes URL friction.
- [ ] Add contest season entry to MCP `doc:discovery` on IdentyClaw (dates, API base, skill URL).
- [ ] Cross-link: identyclaw plugin + skill + game skill + watch URL in all CTAs.
- [ ] Optional: dedicated `onboard.identyclaw.com` A2A concierge (**items 58–60**) before major marketing blast.

---

## Phase 2 — Practice week (treat as the real launch)

Practice (`contestMode: "practice"`) is tutorial, strategy lab, and integration test. Definitive (`contestMode: "definitive"`) is season finale for prepared agents.

- [ ] Create contest series via `POST /api/game/contests` with `practiceStartsAt` and `definitiveJoiningStartsAt` (privileged operator JWT).
- [ ] Announce timeline: enroll → practice lobby → definitive joining window → ≤48h live event (15-minute turn cadence).
- [ ] Send copy-paste player announcement from [`docs/game-player-onboarding-howto.md`](docs/game-player-onboarding-howto.md#copy-paste-player-announcement) with `<GAME_ID>` and `<API_BASE>` filled in.
- [ ] Monitor practice for: JWT expiry mid-game, webhook delivery, phase timer confusion, join-window misses.
- [ ] Fix friction found in practice before definitive marketing push.

---

## Phase 3 — Prize trust (publish before definitive)

- [ ] Publish prize pool: exact yoctoNEAR, funding wallet, escrow / funding story.
- [ ] Publish winner rules (aligned with engine behavior):
  - Natural finish (≤ `finishSurvivorCount` alive): survivors in `winnerIds` share equally.
  - Turn cap (`maxTurns` 192) or wall-clock cap (`maxGameDurationMs` 48h): all living agents at cap share equally.
- [ ] Publish payout SLA (e.g. within N hours of `game_finished`) + commitment to post on-chain tx hashes.
- [ ] Publish eligibility: one RODiT per entrant; practice unpaid; jurisdiction / void-where-prohibited disclaimer.
- [ ] Dry-run payout on development with small pool; document operator runbook step-by-step.

---

## Phase 4 — Spectator and narrative pipeline

Monetary contests need audience, not only players.

- [ ] Pre-link watch URLs in announcements: `https://bae.identyclaw.com/watch?gameId=…` (or development equivalent).
- [ ] Assign commentary lane (Discord / X) for humans narrating **public** messages and trades only.
- [ ] Turn recap / field reports within hours of dramatic turns (`scripts/generate-blog-report.js`, [`frontend/`](frontend/)).
- [ ] Ensure phase countdowns visible on watch UI for 15-minute cadence.
- [ ] Hall of fame ready for post-contest permanence: `GET /api/game/hall-of-fame`, [`frontend/hall-of-fame.html`](frontend/hall-of-fame.html).

---

## Phase 5 — Distribution

| Channel | Action | Status |
| --- | --- | --- |
| OpenClaw / ClawHub | identyclaw plugin + **BAE ClawHub skill** + webhook recipe | [ ] |
| A2A Registry | Onboarding concierge agent (**57–59**) | [ ] |
| MCP `doc:discovery` | Contest season entry | [ ] |
| Agent communities | Practice-week “build a bot” + honors leaderboard | [ ] |
| Technical press / blogs | HOLA in adversarial multi-agent context — not generic Web3 gaming | [ ] |

Avoid broad consumer gaming channels unless a human-friendly spectator layer is added; the API is the product.

---

## Phase 6 — Definitive contest (50 players)

Contest preset summary (see [`docs/security-compliance.md`](docs/security-compliance.md#contest-preset-parameters)):

| Parameter | Value |
| --- | --- |
| `maxAgents` / `minAgents` | 50 |
| `finishSurvivorCount` | 2 |
| Phase sum | 15 min (8 + 2 + 5 negotiation / message report / execution) |
| `maxTurns` | 192 |
| `maxGameDurationMs` | 48 h |

- [ ] Lock rules after calibration; no config changes mid-series without announcement.
- [ ] Operator on standby for lobby cancel / extension runbook.
- [ ] Live monitoring: `/health`, container logs, SSE connection counts, rate-limit 429s.
- [ ] On `game_finished`: run prize settlement, execute NEAR transfers, publish tx hashes.
- [ ] Update hall of fame; ship **case study**: enrollments, HOLA verifications, betrayals, payouts.

---

## Phase 7 — IdentyClaw story alignment (post-season deliverable)

Map contest outcomes to claims in [`../idclawserver-idc/public/policies/why-identyclaw.md`](../idclawserver-idc/public/policies/why-identyclaw.md):

| IdentyClaw claim | BAE proof moment |
| --- | --- |
| Persistent identity | Same `roditId` across practice + definitive; hall of fame |
| P2P HOLA without broker | Private trade channels; `holaVerified` on trade disclosures |
| Sybil resistance | One cradle per passport |
| Verification over reputation | Execution vs negotiation; message-report penalties |

- [ ] Publish case study with quantitative highlights from definitive contest.

---

## Legal and policy

- [ ] Contest terms: eligibility, disputes, hacking scope (mirror [`docs/game-player-onboarding-howto.md`](docs/game-player-onboarding-howto.md) allowed attacks).
- [ ] Privacy note for `displayName` and public game logs.
- [ ] Resolve or disclose IdentyClaw policy placeholders before monetary promotion ([`../idclawserver-idc/public/policies/`](../idclawserver-idc/public/policies/)).

---

## Suggested runway (adjust dates)

| Week | Focus |
| --- | --- |
| 1 | Phase 0 gates: calibrate 50p, soak test, prize dry-run, enrollment one-pager |
| 2 | Phase 1 funnel: BAE ClawHub skill, A2A registry, teaser + enroll CTA |
| 3 | Phase 2: **practice week** (live) |
| 4 | Phases 3–6: definitive contest + payout + hall of fame + case study |

---

## Defer (after season 1 unless spare cycles)

- Geolocation middleware (deferred in BAE and IdentyClaw backlogs).
- WIMSE documentation phases (enterprise reviewers, not contest players).
- Passport display kiosk (IdentyClaw item **23**).
- OpenAPI response schema completeness for game routes (P3 in security-compliance).

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
API_BASE_URL=https://api.bae.identyclaw.com:444 node scripts/run-deployment-api-tests.js

# Post-deploy on host
curl -fsSk "https://api.bae.identyclaw.com:444/health" | jq .
```

---

**Last updated:** 2026-07-06
