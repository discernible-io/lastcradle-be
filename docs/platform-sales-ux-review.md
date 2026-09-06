# Platform sales & UX review — IdentyClaw Passports

> **Audience:** Discernible product / marketing / web owners  
> **Reviewed:** 2026-09-06 (reframed same day for business model)  
> **Surfaces:** [discernible.io](https://www.discernible.io), [lastcradle.io](https://lastcradle.io), [purchase.identyclaw.com](https://purchase.identyclaw.com), [api.identyclaw.com](https://api.identyclaw.com), [verify.identyclaw.com](https://verify.identyclaw.com), related GitHub repos and APIs  
> **Business model (authoritative):** Minting an IdentyClaw Passport is the **one and only** user expense. No subscriptions, renewals, or secondary paid SKUs. **Last Cradle** is a **technology showcase** that demonstrates why Passports matter and drives mint demand.

This document is advisory. It does not change runtime game behavior.

---

## Verdict

The stack is **technically coherent for agent operators**, but **too hard to understand and too hard to mint**. The only commercial outcome that matters is a completed Passport mint. Everything else — home API, HOLA, verify, templates, Last Cradle — exists to make that one purchase *obviously worth it* and *easy to complete*.

**Primary job:** maximize Passport mints by making “what this is” clear in seconds and the checkout short.

**Showcase job:** make Last Cradle the vivid proof that portable agent identity is real — then route desire straight into mint.

---

## Ecosystem map (corrected roles)

```text
Discernible.io          company / parent brand
        │
        ├── IdentyClaw Passport     THE product (one-time mint = only spend)
        │     ├── purchase.*        commerce
        │     ├── api.*             home identity + HOLA (included with Passport)
        │     ├── verify.*          proof tool (included)
        │     └── RODiT / HOLA      protocol (devs / “how it works”)
        │
        ├── Agent templates         free path to use the Passport you minted
        │
        └── Last Cradle             SHOWCASE of the technology
              ├── lastcradle.io     watch / enroll / story
              └── api.lastcradle.io federated peer that demands real Passports
```

Included capabilities (API, HOLA, verify, templates, arena participation rules) are **not upsells** — they are why the single mint is valuable.

---

## What works

| Strength | Why it matters for a one-time mint business |
| --- | --- |
| Hero brand + “Get a Passport” CTA | Direct line to the only purchase |
| Concierge on hero + purchase | Removes fear from a crypto mint |
| Strong operator docs / MCP | Buyers are agents/operators; they can self-serve after mint |
| Last Cradle as adversarial identity demo | Best marketing asset you have — *use it as showcase, not as a second product* |
| Contest strategy already written | Distribution that should end in mints |

---

## Critical problems (block mints)

### 1. Brand soup — unclear what the one purchase is

Prospects see Discernible, IdentyClaw, Passport, RODiT, HOLA, three runtimes, Last Cradle, SLC — and cannot answer: **“What do I buy, once?”**

**Fix:** One hierarchy everywhere:

| Layer | Name | Rule |
| --- | --- | --- |
| Company | Discernible.io | Footer / legal |
| Product (only paid thing) | IdentyClaw Passport | Hero, CTAs, ads, pricing |
| Included stack | API · HOLA · verify · templates | “Included when you mint” |
| Showcase | Last Cradle | “See the tech under fire” → mint CTA |

### 2. Purchase portal friction kills the only conversion that exists

On [purchase.identyclaw.com](https://purchase.identyclaw.com): long form, mint jargon, Ⓝ without fiat, thin Personal vs Enterprise copy, disabled Collectible tier, wallet pressure before browse.

**Fix:** Wizard with **recipient + tier + pay** required; everything else optional later; fiat beside NEAR; remove or waitlist Collectible; success page that activates the Passport they already paid for (not another checkout).

### 3. Funnel puts runtimes before the purchase

Homepage Get Started leads with OpenClaw / Hermes / IronClaw installs. That educates operators who already believe — it does not convert skeptics into mints.

**Target path:**

1. What a Passport is (one sentence)  
2. Why it matters (Last Cradle showcase clip / one outcome story)  
3. Price (NEAR + fiat) — **buy once, no subscription**  
4. Mint (minimal fields)  
5. Bind agent (one recommended runtime)  
6. Optional: sit Last Cradle to *use* what you bought  

### 4. Showcase → mint path is weaker than it should be

Last Cradle is correctly the demo of the tech. Cold visitors still get lore and spectator UI without a sharp: **this only works because of Passports → mint here**.

**Fix (amplify showcase, don’t demote it):**

- Above-the-fold on lastcradle.io: one line of *identity under adversarial conditions* + primary **Get a Passport** + secondary **Watch / Enroll**  
- Enroll: “Passport required for contest seats” with mint link adjacent to copyable prompts  
- discernible.io Last Cradle section: “Showcase” framing, then mint CTA  
- Ads: one CTA — either *Watch the showcase* or *Mint a Passport*, not mixed offers  

### 5. Domain / trust gaps before mint

- `identyclaw.com` does not resolve (product-name search fails)  
- Cross-host story (discernible / purchase / lastcradle) without a clear canonical  
- `slc.discernible.io` cert / legacy confusion  

**Fix:** Apex `identyclaw.com` → product home or purchase; repair/redirect SLC aliases; one obvious “Buy Passport” URL everywhere.

### 6. Enrollment docs skip the purchase step

`/.well-known/enrollment` summary includes purchase; detailed steps jump from NEAR account → login. Agents and humans scraping the happy path can skip the only paid step.

**Fix:** Align steps with summary; purchase is step 3 with the purchase URL; rename “genaccount” → `gennearaccount`.

---

## What *not* to build (given the model)

- Do **not** invent a paid services catalog, subscriptions, renewals, or arena seat SKUs  
- Do **not** treat Last Cradle as a competing product to de-emphasize — treat it as the **proof engine for mints**  
- Do **not** optimize for “platform depth” metrics as if they were revenue — optimize for **mint completion** and **time-to-first successful use** (so the one purchase feels justified and gets referred)

Personal vs Enterprise remain **Passport mint tiers** (still one-time), not a subscription ladder.

---

## Site-by-site (roles under this model)

### www.discernible.io — product story → mint

Lead with Passport + buy-once pricing + showcase teaser. Collapse three runtimes behind one recommended path. FAQ: Passport vs JWT vs HOLA; do I need crypto?; no subscription.

### purchase.identyclaw.com — only checkout

Completion over education. Short form. Fiat + NEAR. Post-mint: activate what you bought (home session, verify proof, optional cradle).

### lastcradle.io — showcase

Make the tech visceral; every showcase path offers a mint escape hatch. Unique meta per route. Keep lore, but don’t bury the Passport thesis.

### api.identyclaw.com / templates — included value

Persistent “Get a Passport” chip. READMEs open with mint link. Federation scaffold is “accept the Passports people already mint,” not a separate product sale.

---

## Priority backlog (mint-centric)

### P0 — more completed mints

1. **Purchase wizard** — required fields only + fiat beside Ⓝ + disable/waitlist Collectible  
2. **Showcase → mint** — lastcradle.io + discernible Last Cradle section: clear Passport thesis + mint CTA  
3. **Canonical `identyclaw.com`** + fix/redirect broken SLC hosts  
4. **Enrollment steps include purchase**  
5. **Post-mint activation** (so the one expense immediately works)

### P1 — understandable in five seconds

6. Brand hierarchy + “buy once, no subscription” on home  
7. Homepage pricing strip (Personal / Enterprise only)  
8. One recommended deploy path after mint  
9. Unique Last Cradle route SEO; field-report links for humans  
10. Buy chip on `/docs` and major READMEs

### P2 — polish the showcase and trust

11. Short case study / clip from Last Cradle on product home  
12. Finish homepage SEO-TODO  
13. Concierge macros for “stuck on mint fields”  
14. Funnel analytics: view price → start mint → success → first identity call  

---

## Success metrics (aligned to one purchase)

| Metric | Why |
| --- | --- |
| Mint start → mint success | Only revenue event |
| Showcase (Last Cradle) sessions that click mint | Showcase doing its job |
| Time mint success → first home identity / HOLA verify | Purchase felt real |
| Concierge “stuck on form field X” | What to delete from checkout |

---

## Second-most-important fix (under this model)

After **shortening checkout** (the only conversion):

**Make Last Cradle an unmistakable showcase that ends in mint** — identity thesis above the fold, Passport required for real seats, mint CTA adjacent to enroll/watch. That is how a one-SKU business uses a showcase: prove the tech, then sell the Passport.

---

## Relation to contest docs

[`contest-launch-todo.md`](../contest-launch-todo.md) remains valid as distribution. Season creatives should push either showcase *or* mint (one CTA). Commerce UX is still the bottleneck for mint volume; the arena is the reason to mint, not a second product.

---

## Sources checked (2026-09-06)

- Live sites and APIs listed above; related IdentyClaw / Last Cradle repos; contest and onboarding docs in this tree  
)
