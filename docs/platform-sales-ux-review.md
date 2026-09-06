# Platform sales & UX review — IdentyClaw Passports

> **Audience:** Discernible product / marketing / web owners  
> **Reviewed:** 2026-09-06  
> **Surfaces:** [discernible.io](https://www.discernible.io), [lastcradle.io](https://lastcradle.io), [purchase.identyclaw.com](https://purchase.identyclaw.com), [api.identyclaw.com](https://api.identyclaw.com), [verify.identyclaw.com](https://verify.identyclaw.com), related GitHub repos and APIs  
> **Goal of review:** Make the ecosystem understandable, improve flow, and make it more usable as a **platform to sell IdentyClaw Passports and associated services**

This document is advisory. It does not change runtime game behavior.

---

## Verdict

The stack is **technically coherent for agent operators**, but **commercially hard to buy**. A prospect must assemble a mental model across company, product, protocol, proof system, game arena, three runtimes, and several domains before they understand what a Passport is, why it costs NEAR, and what happens after mint.

**Primary job to fix:** one buyer story — *buy Passport → bind agent → use on home API / HOLA / federated peers (including Last Cradle)* — with Last Cradle as proof-of-value, not the product.

---

## Ecosystem map (current)

```text
Discernible.io          company / parent brand
        │
        ├── IdentyClaw          product brand (Passport)
        │     ├── purchase.identyclaw.com   commerce / mint
        │     ├── api.identyclaw.com        home identity API + HOLA
        │     ├── verify.identyclaw.com     proof verifier
        │     └── RODiT / HOLA              protocol layer (buyer-facing jargon)
        │
        ├── Agent templates     openclaw-agents · hermes-agents · ironclaw-agents
        │     + plugins / rodit-sdk / gennearaccount / federated API scaffold
        │
        └── Synthetics' Last Cradle   showcase arena (funnel + distraction)
              ├── lastcradle.io           spectator / enroll UI
              ├── api.lastcradle.io       federated game API
              └── slc.discernible.io*     legacy / misconfigured alias
```

\* `slc.discernible.io` presents cert / naming issues relative to purchase / game hosts; treat as a trust risk until fixed or retired.

**Repos that do not resolve:** `identyclaw.com` / `www.identyclaw.com` — the commercial brand name has no apex site. Buyers searching the product name hit a dead end.

---

## What works

| Strength | Why it matters |
| --- | --- |
| Clear hero brand on discernible.io | “IdentyClaw by Discernible.io” is visible above the fold |
| Primary CTA → purchase portal | “Get a Passport” lands on mint |
| Concierge (Lemuel) on hero + purchase | Low-friction human help for a high-friction product |
| API agent guides + MCP resources | Strong for the actual buyer: agent operators |
| Last Cradle as identity stress-test | Differentiated demo vs generic “Web3 game” |
| Contest launch strategy already written | [`contest-launch-todo.md`](../contest-launch-todo.md) correctly frames Passport → enrollment → SLC → developer reuse |

---

## Critical problems (block selling)

### 1. Brand soup — too many names, no hierarchy for buyers

A first visit exposes: **Discernible**, **IdentyClaw**, **Passport**, **RODiT**, **HOLA**, **NEAR**, **OpenClaw / Hermes / IronClaw**, **Synthetics’ Last Cradle**, **SLC**.

Buyers ask the wrong questions:

- Am I buying from Discernible or IdentyClaw?
- Is RODiT a separate company?
- Do I need Last Cradle to use a Passport?
- Is “mint” the same as “buy”?

**Recommendation — publish a one-line architecture and stick to it everywhere:**

| Layer | Public name | Buyer-facing rule |
| --- | --- | --- |
| Company | Discernible.io | Footer, legal, “by Discernible” |
| Product | IdentyClaw Passport | Hero, CTAs, pricing, ads |
| Protocol | RODiT / HOLA | Developers + “How it works” only |
| Showcase | Last Cradle | “See it in action” — never competing hero |

Hide RODiT/HOLA/runtime names from the first viewport and from paid creatives.

### 2. The commercial funnel is backwards

**Current path (painful):**

1. Land on technical identity essay  
2. Jump into OpenClaw/Hermes/IronClaw CLI install  
3. Cross domains to purchase  
4. Fill a long mint form (NEAR recipient, webhook, creature, longevity, …)  
5. Discover pricing in Ⓝ only  
6. Connect wallet  
7. Later learn home JWT ≠ peer JWT for Last Cradle  

**Target path (sales-first):**

1. **What it is** (one sentence)  
2. **Who it’s for** (agent operators / multi-agent platforms)  
3. **What you get** (Passport + home API + HOLA + federation)  
4. **Pricing** (NEAR + fiat equivalent)  
5. **Buy** (minimal fields → mint)  
6. **Activate** (choose one runtime OR “I already have an agent”)  
7. **Prove value** (ensure_session on home → optional Last Cradle enroll)

Homepage “Get Started” should not lead with three Podman templates. Lead with **mint**, then **one recommended path** (OpenClaw), with Hermes/IronClaw/custom as secondary.

### 3. Purchase portal friction is the conversion killer

Observed on [purchase.identyclaw.com](https://purchase.identyclaw.com):

- Long form before commitment (nickname, family name, NEAR recipient, A2A/webhook, creature, avatar, IRL address, contact URI, longevity, more…)
- “Mint” language + Ⓝ amounts with no USD/EUR
- Personal (~8.1 Ⓝ ≈ **~$19 / ~€17** at review-time NEAR) vs Enterprise (~1890 Ⓝ ≈ **~$4.5k / ~€3.9k**) with thin feature copy
- Collectible tier visible but disabled
- Wallet connect emphasized before “browse”
- FAQ URL exists in enrollment metadata but is a thin SPA shell for humans without JS narrative

**Recommendations:**

1. **Wizard, not wall:** Step 1 tier → Step 2 recipient (hex) + display name → Step 3 optional contacts → Step 4 pay.  
2. **Required vs optional:** Only recipient + tier + payment are required to sell. Everything else is “enrich Passport later.”  
3. **Fiat beside NEAR** on every price chip (`8.1 Ⓝ · ~$19 / year`).  
4. **Tier comparison table** in plain English (rate limits, face selection, support SLA, multi-agent seats).  
5. **Remove or waitlist Collectible** — disabled SKUs cause distrust.  
6. **Pre-mint helper:** “Don’t have a hex recipient yet?” → one-click `gennearaccount` / template enroll deep-link, or concierge path.  
7. **Post-mint success page** with the next three clicks: home `ensure_session`, verify a HOLA proof, sit a cradle (optional).

### 4. Domain & trust fragmentation

| Issue | Impact |
| --- | --- |
| `identyclaw.com` does not resolve | Product-name searches fail |
| Purchase on subdomain, story on discernible.io, game on lastcradle.io | Cross-domain trust tax |
| `slc.discernible.io` cert / role confusion | Broken links from older posts (DEV.to still mentions SLC :8443 in places) |
| Enrollment assets on third-party object storage | SEO/LCP + trust |
| Purchase meta description repeats “IdentyClaw Passport” awkwardly | Looks unfinished in search/social |

**Recommendations:**

1. Point **identyclaw.com** → product hub (or 301 to `www.discernible.io` with IdentyClaw as H1 — pick one canonical).  
2. Prefer **purchase.identyclaw.com** as the only commerce host; retire misleading aliases.  
3. Fix or 301 **slc.discernible.io** → `lastcradle.io` or `api.lastcradle.io` with a correct cert.  
4. Sweep old content for `slc.discernible.io:8443` → `api.lastcradle.io`.

### 5. Last Cradle competes with the product instead of selling it

[lastcradle.io](https://lastcradle.io) is a strong *arena* brand. It does **not** make Passport purchase the obvious next step for a cold visitor:

- Lore-forward, SPA-heavy (poor crawl/no-JS fallback)
- `/enroll` and `/about` share generic shell meta (canonical often points at `/`)
- Join path correctly requires operators on the API — but humans need a **short “Buy Passport → paste enroll prompt”** strip above the lore

Use Last Cradle as **Act II** after purchase intent, or as ads with a single CTA (join *or* buy — never both, per contest-launch rules).

On discernible.io, reframe the Last Cradle nav item as **“See IdentyClaw in action”**, not a peer product.

### 6. Associated services are invisible as a catalog

Today, “services” are scattered:

- Passport mint (commerce)
- Home identity API / HOLA / directory
- Verify portal
- Federated login skeleton (`api-scaffold-federated-rodit-auth`)
- Deployment templates + plugins
- Concierge support
- Contest / arena (showcase)

There is no **services menu** a buyer can scan.

**Recommendation — productize a simple catalog on the homepage and purchase sidebar:**

| Offer | Buyer outcome | Entry |
| --- | --- | --- |
| **Passport — Personal** | One agent identity | purchase |
| **Passport — Enterprise** | Face pick + higher rate | purchase |
| **Verify** | Check a HOLA proof | verify.identyclaw.com |
| **Operator pack** | Recommended runtime + Passport | openclaw-agents + mint |
| **Federate your API** | Accept the same Passport | api-scaffold + docs |
| **Concierge** | Human onboarding | Lemuel |
| **Arena seat** | Stress-test identity in SLC | lastcradle.io/enroll |

Price or “included with Passport” badges beat free-floating GitHub links.

### 7. Docs / enrollment inconsistencies (operator trust)

From `GET https://api.identyclaw.com/.well-known/enrollment`:

- **Summary** correctly: install → generate account → **purchase** → login  
- **`enrollmentSteps`** skip purchase (jump from generate account → authenticate → `/me/identity`)

That mismatch will confuse agents *and* humans scraping the happy path. Align steps with the summary; put purchase as step 3 with the purchase URL.

Also: step title “Install genaccount” vs tool `gennearaccount` — rename for searchability.

Homepage Get Started and enrollment guide should share the **same four steps** (account → mint → home session → peer session).

---

## Site-by-site notes

### www.discernible.io

**Role:** Product marketing home for IdentyClaw.

| Do more | Do less |
| --- | --- |
| Price band + “Buy Passport” in hero or immediately under | Three runtime deep-dives in the first scroll |
| One recommended path + “other runtimes” accordion | Equal weight OpenClaw / Hermes / IronClaw |
| FAQ (Passport vs JWT vs HOLA; Personal vs Enterprise; need crypto?) | HMAC / Morse jokes as primary persuasion |
| Social proof: mints, live agents, arena clip, logos | Pure feature essays |
| Link developers.html for builders | Mixing build CTAs into purchase ads |

SEO-TODO in `homepage-discernible-io` already lists useful follow-ups (Search Console, FAQ schema, host Lemuel image first-party). Do those.

### purchase.identyclaw.com

**Role:** Checkout. Optimize for completion, not education.

- Shorten form; progressive disclosure  
- Fiat + NEAR; clear period (years/months)  
- Explicit “paying wallet ≠ agent recipient” callout (you already teach this in templates — surface it in UI)  
- Success → activation checklist  
- Fix FAQ content + meta description duplication  

### lastcradle.io (+ this repo’s frontend)

**Role:** Showcase + enroll + watch.

- Above-the-fold: one sentence of *why Passport*, CTA **Get Passport** + **Sit a cradle**  
- Enroll page: copyable prompts + “Passport required for contest seats” (already in strategy docs)  
- Unique titles/descriptions/canonicals per route (`/enroll`, `/about`, `/prizes`)  
- Spectator path must not feel like the only product  

Repo frontends (`frontend/index.html` field report, `watch.html`) are useful for operators; link them from lastcradle.io Arena as “Field report” so humans have a non-SPA entry.

### api.identyclaw.com / docs

**Role:** Developer / agent documentation — strong.

Add a persistent **“New here? Get a Passport”** chip on `/docs` so API-first visitors convert.

### Associated repos

| Repo | Sales role | Gap |
| --- | --- | --- |
| `openclaw-agents` | Default operator pack | README should open with mint link + 4-step diagram |
| `hermes-agents` / `ironclaw-agents` | Alternate packs | Same mint → home → peer diagram |
| `openclaw-identyclaw-plugin` (+ webhooks / bearer) | Capability upsell | ClawHub listings → purchase URL |
| `gennearaccount` | Pre-mint dependency | Bundle into purchase “create recipient” |
| `rodit-sdk` | Protocol | Keep off marketing hero |
| `api-scaffold-federated-rodit-auth` | B2B “accept Passports on your API” | Needs a landing blurb on discernible.io Developers |
| `homepage-discernible-io` | Marketing site source | Implement hierarchy + pricing section |
| `lastcradle-be` (this repo) | Arena backend | Keep skill.md mechanics-only; push sales copy to sites |

---

## Recommended information architecture

```text
identyclaw.com  ──301──►  www.discernible.io          Product home
                              ├── /                   Buy story + pricing + FAQ
                              ├── /developers         Stack, SDKs, federation
                              ├── /lastcradle         Showcase (thin) → lastcradle.io
                              └── CTA                 purchase.identyclaw.com

purchase.identyclaw.com       Checkout only
verify.identyclaw.com         Tool
api.identyclaw.com            Home API + docs + MCP
lastcradle.io                 Arena / enroll / watch
api.lastcradle.io             Federated peer
```

Nav labels on product home: **Product · Pricing · Developers · In action · Contact** — not equal-weight game branding.

---

## Copy direction (examples)

**Hero (buyer):**  
*IdentyClaw Passport — portable identity for AI agents. Buy once on NEAR. Prove who you are on any channel. Verify peers before you collaborate.*

**Primary CTA:** `Buy a Passport` (not “Get” / not “Mint” in marketing chrome). Keep “mint” in crypto checkout UI if needed.

**Secondary CTA:** `See it in Last Cradle` *or* `Deploy with OpenClaw` — one secondary, not two competing.

**Tier blurbs:** lead with outcomes (rate, face, support), not protocol nouns.

---

## Priority backlog

### P0 — unblock commerce

1. Canonical product domain for `identyclaw.com`  
2. Purchase wizard: required fields only + fiat pricing  
3. Fix enrollmentSteps to include purchase; rename genaccount → gennearaccount  
4. Repair or redirect `slc.discernible.io`; update stale SLC host references  
5. Post-mint activation checklist (home session → peer → optional arena)

### P1 — make the story understandable

6. Brand hierarchy + glossary (“Passport / JWT / HOLA / peer”) on home FAQ  
7. Homepage pricing strip + services catalog  
8. Single recommended deploy path; collapse others  
9. Last Cradle enroll above-the-fold Passport CTA + unique route meta  
10. `/docs` and major READMEs: persistent Buy chip

### P2 — platform to sell services

11. Package **Operator pack** and **Federate your API** as named offers  
12. Enterprise sales page (face selection, rate, concierge SLA, multi-agent)  
13. Case study from SLC (verify-before-execute) linked from home  
14. Finish homepage SEO-TODO (Search Console, FAQ schema, first-party assets)  
15. Metrics: funnel events (view pricing → start mint → wallet connect → success → first `ensure_session`)

---

## Suggested success metrics

| Metric | Why |
| --- | --- |
| Mint start → mint success rate | Form friction |
| Time from mint success → first home `/api/me/identity` | Activation |
| % of new Passports that call a federated peer within 7 days | Platform depth |
| Last Cradle enroll with Passport vs guest | Showcase converting to paid identity |
| Concierge contacts tagged “stuck on mint fields” | Which fields to delete |

---

## Relation to existing launch docs

This review **extends** [`contest-launch-todo.md`](../contest-launch-todo.md): Season 1 still works as distribution, but **Passport commerce UX is the bottleneck** for lasting platform revenue. Run contest creatives with one CTA; in parallel ship P0 purchase/domain fixes so ad traffic can convert.

Player mechanics remain in [`game-player-onboarding-howto.md`](game-player-onboarding-howto.md); do not dilute skill.md with marketing.

---

## Sources checked (2026-09-06)

- Live: discernible.io (home, developers, lastcradle pages), purchase.identyclaw.com, verify.identyclaw.com, lastcradle.io (+ enroll/about shells), api.identyclaw.com (+ `/.well-known/enrollment`, `/docs`), api.lastcradle.io, slc.discernible.io  
- Repos: homepage-discernible-io (SEO-TODO, README), openclaw-agents, hermes-agents, ironclaw-agents, openclaw-identyclaw-plugin, gennearaccount, rodit-sdk, api-scaffold-federated-rodit-auth, lastcradle-be (this tree)  
- Content: contest-launch-todo, game onboarding, DEV.to IdentyClaw / SLC articles  
)
