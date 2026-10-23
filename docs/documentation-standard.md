# Documentation Standard

> **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

**Created:** 2026-05-24  
**Last reviewed:** 2026-10-22

These principles govern how all documentation in this repository is written and maintained.

1. **Single Source of Truth**: [`api-docs/swagger.json`](../api-docs/swagger.json) is authoritative for all endpoints in each **consuming service repository** (service-relative path; see [Service-relative links](#service-relative-links))
2. **No Duplication**: Technical details live in one place; other docs reference them. The only exception is a **convenience procedure** (principle **19**): a step-by-step how-to that would otherwise force readers to assemble steps from multiple authoritative documents.
3. **Layered Complexity**:
   - **Operational**: `docs/` — deployment, configuration, and operations
   - **Interactive**: Runtime API (`/api-docs`, [`api-docs/swagger.json`](../api-docs/swagger.json)) — live exploration
4. **Cross-Referencing**: Docs link to each other and to runtime endpoints
5. **Offline Availability**: All docs are static files (no database lookups required)
6. **Self-Contained Topics**: When treating a subject, keep it self-contained and to the point. Mention things once rather than spreading related information across multiple places in the same document
7. **Positive, Actionable Guidance**: Write instructions as clear actions the reader can execute immediately. Prefer "Do X with Y result" over prohibitions, and use "Avoid X by doing Y" only when risk context is required.
8. **Consistent Terminology**: Use **development** and **main** for deployment tiers (see [`vocabulary-standard.md`](vocabulary-standard.md)); keep one terminology lane per document so the guidance remains immediately actionable
9. **Descriptive File Names**: File names define the topic of each document and must be carefully chosen. A file's name should clearly indicate its subject matter without requiring the reader to open it. Use the preferred **document type** in the name when it applies (principle **20**)
10. **Complete Indexing**: All documentation files must be referenced at least once in `README.md`. Every document in the codebase should be discoverable through the master index to ensure no documentation is orphaned or forgotten
11. **Meaningful Cross-References**: Documents should reference other files only when the target materially improves reader outcomes. Every cross-reference must be purposeful—removing it should make the document less useful
12. **Proven Reference Implementation**: When documenting a pattern, convention, or deployment shape, provide a **proven reference implementation**—a concrete, working example readers can follow or compare against—not placeholders alone.

    - **Pin versions when possible** — package versions, image tags, config schema versions, API contract versions, git refs, or similar — so the example stays reproducible and auditable.
    - **Label the reference clearly** — for example *Reference (SignSanctum)*, *Reference (SignPortal)*, *Reference (clienttestapi)* — and give real paths, commands, and values from that implementation.
    - **Prefer what is deployed or maintained** — reference a service, workflow, or client that exists in the codebase or is known to run in production/staging; do not invent hypothetical layouts.
    - Do not use *this repo* for a named service reference in **discernible-io/docs** — that label means the consuming application repository, not this standards-only repository.
    - If no proven implementation exists yet, say so explicitly and link to the tracked work; do not present an aspirational example as if it were live.

    **Example (deployment path):**

    | Reference | Content |
    | --- | --- |
    | Reference (SignSanctum) | Deploy to `~/signsanctum-app` using the workflow in [`cicd-deployment-standard.md`](cicd-deployment-standard.md) (pin the workflow file at the commit or release tag you document). |
    | Reference (SignPortal) | Deploy to `~/signportal-app` with the same pattern; call out any SignPortal-specific env keys or nginx paths from that repo’s pinned config. |

13. **Reference Examples Stay Stable**: Concrete references in documentation (for example *Reference (clienttestapi)*, *Reference (SignSanctum)*, or other service names and paths) illustrate a reusable pattern. Do **not** update those references to match a different consuming repository unless someone explicitly asks for that change.
14. **Service-relative links**: Paths such as `../src/app.js`, `../config/main.json`, `../api-docs/swagger.json`, `../.github/workflows/deploy.yml`, and `../scripts/*.sh` are written for **`docs/` at the root of a consuming service repository**. They resolve when standards are vendored (submodule, subtree, or copy) beside application code. In a **discernible-io/docs-only** clone, those targets are intentionally absent—follow the link text and apply the pattern in your service tree. Sibling-repository links (for example `../../infra/...`) point at optional companion repos on the operator workstation and may also be absent in a docs-only clone. Prefer service-relative links over hard-coding a single GitHub URL so the same markdown works across forks and mirrors.
15. **Editor notice in document headers**: Every markdown file under `docs/` must include the following blockquote immediately after the document title (or, if the file uses YAML frontmatter, immediately after the closing `---` of that frontmatter):
    > **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

    Do not remove or reword this notice when updating other sections. New documents added under `docs/` must include it before the first body section.
16. **Visible document dates**: Immediately after the editor notice, include **`Created: YYYY-MM-DD`**. Optionally add **`Last reviewed: YYYY-MM-DD`** when the document is substantively revised. Readers should not need file metadata or version control to know age. For older files missing `Created:`, backfill from git history (first commit that added the file) rather than inventing a date.
17. **Structure labels stay internal**: The principles and labels in this standard (for example *Single Source of Truth*, *No Duplication*, *documented only in this section*) guide authors and maintainers. In end-user documentation—guides, MCP resources, API descriptions, policies, and similar reader-facing material—do **not** expose that internal structure by default. Tell readers what to use and how to act. Surface structure or meta-labels only when doing so clearly serves another principle above (for example a purposeful cross-reference to the authoritative section, or wording that helps the reader complete a task without hunting duplicate copies).
18. **Avoid documentation sprawl**: Do not proliferate indices, quick-reference cards, “start here” pages, or orientation guides that cover the same navigation job. Prefer **one** entry point per audience or topic (for example a single README section, one quick-reference doc, or one setup guide)—then link outward to authoritative detail. Add a new index or quick-reference file only when it has a **distinct, non-overlapping** role that cannot be a section in an existing doc without making that doc unwieldy. If two documents both answer “where do I start?” or “what are the paths/URIs?”, merge or demote one to a cross-reference rather than maintaining parallel “30-second,” “quick,” and “complete” indexes for the same surface. **Only `README.md` is meta**—navigation, discovery, and pointers to other docs belong there. Every other document should be **content-rich** (procedures, schemas, examples, troubleshooting) rather than **metadata-rich** (tables of links, “start here” chains, or restatements of what other files contain).
19. **Convenience procedures (controlled duplication)**: Duplicate technical detail only when you need a **step-by-step how-to** so readers can complete a procedure in one place instead of piecing it together from several authoritative documents.

    - **Purpose** — end-to-end execution (deploy, rotate credentials, onboard a service), not parallel summaries, indexes, or “quick” restatements of the same topic (principles **2**, **6**, and **18** still apply).
    - **Authoritative links** — every duplicated fact must cite the section or file that owns it; readers must be able to jump to the source of truth.
    - **Convenience notice** — include a short note near the top of the procedure (for example immediately after the editor notice) stating that the document is a **convenience copy** for workflow, that **authoritative changes belong in the owning sections first**, and that this how-to should be updated afterward only when needed to keep the steps accurate.

    **Example (notice block):**

    > **Convenience document:** This how-to assembles steps from authoritative sections so you can run the procedure in one place. Change the owning documents first ([`configuration-standard.md`](configuration-standard.md), [`cicd-deployment-standard.md`](cicd-deployment-standard.md), …); update this file only to reflect those changes in the walkthrough.

    Name convenience procedures as **howto** documents (principle **20**), for example `deploy-service-howto.md`.

20. **Preferred document types**: Assign each document one primary type from the table below and reflect it in the file name (principle **9**). Other terminology (guide, runbook, checklist, constitution, …) is admissible when no preferred type fits, but prefer the types below so readers and maintainers can predict content and maintenance expectations.

    | Type | Use for | File name pattern |
    | --- | --- | --- |
    | **standard** | Programming, documentation, and architecture rules for authors and maintainers | `*-standard.md` (for example [`logging-standard.md`](logging-standard.md)) |
    | **policy** | User-facing rules—access, usage, compliance, and product behavior readers must follow | `*-policy.md` |
    | **howto** | Step-by-step procedures and “how to” walkthroughs (including convenience procedures, principle **19**) | `*-howto.md` |
    | **plan** | Time-bound remediation plans and roadmaps with a validity window | `*-plan.md` (for example [`node-alpine-cve-patch-plan.md`](node-alpine-cve-patch-plan.md)) |
    | **todo** | Living per-repository backlog of open work (compliance gaps, prioritized improvements) | `TODO.md` at the **repository root** (exactly that name) |

    When a document spans types (for example a plan that embeds how-to steps), pick the type that matches its **primary** purpose and link to the other form instead of blending suffixes. Prefer **`TODO.md`** over alternate backlog names (`security-compliance.md`, `*-improvements.md`, `SEO-TODO.md`, and similar). Keep cross-service migration items that standards cite by stable number in [`planned-improvements.md`](planned-improvements.md)—that file is the standards backlog, not a substitute for each service’s `TODO.md`.

21. **Per-repository TODO and host summaries**: Every consuming service repository keeps **one** living backlog at the repository root named exactly `TODO.md`. Index it from that repo’s `README.md` (principle **10**).

    - **Same content on deployment tiers** — The `TODO.md` blob on **main** and **development** must not diverge. Edit the backlog once and land the same file content on both branches (identical `git rev-parse <branch>:TODO.md` hashes). Do not maintain tier-specific todo lists.
    - **One-way host summary** — On each operator machine, **discernible-io/docs** may hold a periodic consolidation named `<hostname>-TODO.md` under `docs/` (for example [`dedalo43-TODO.md`](dedalo43-TODO.md) on host `dedalo43`, [`dedalo47-TODO.md`](dedalo47-TODO.md) on host `dedalo47`). That summary **reads from** each sibling repo’s `TODO.md` and never feeds changes back. Authoritative updates happen only in the per-repo files; refresh the host summary afterward and set its **Collected** date.
    - **Discovery** — When inventoring backlogs on a host, look for root `TODO.md` in each git checkout beside `~/docs`. Do not invent parallel index files for the same job (principle **18**).

## Applicability matrix

Standards in this repository are written primarily for **Node/Express RODiT APIs** that use `config/`, nginx TLS sidecars, and GHCR/Podman. Other consumer types use a subset—or an alternate guide. Score audits with this matrix before marking a repo non-conformant.

| Consumer type | Examples | Applies | N/A or alternate |
| --- | --- | --- | --- |
| **Containerized API** | `signsanctum-idc`, `signportal-idc`, `lastcradle-be` | vocabulary, configuration, logging, error-handling, allowed-fallback, cicd-deployment, test-constitution, documentation, planned-improvements | — |
| **Browser SPA (mint / purchase / verify)** | `mintclient-idc` | vocabulary, documentation, funnel (land/mint surfaces), cicd **image** hygiene where GHCR/Podman is used | Backend `config/` model → [`frontend-branch-env-migration.md`](frontend-branch-env-migration.md) + service `docs/frontend-configuration.md`; error-handling / test-constitution API suites N/A |
| **Static marketing site** | `homepage-discernible-io` | documentation, vocabulary (tier wording), funnel (land) | cicd GHCR/Podman N/A (Pages/Apache); configuration / logging / error-handling API standards N/A |
| **NEAR contracts** | `mintcontract-idc` (typically on other hosts) | documentation, vocabulary where deploy tiers exist | Node `config/`, Express error envelope, nginx/Podman cicd as written—use contract-repo backlog instead |
| **Agents / plugins** | `hermes-*`, `openclaw-*`, `ironclaw-*` | documentation if they ship `docs/`; vocabulary if dual-tier deploy | Full API cicd/config stack only when the plugin embeds that topology |
| **Infra / monitoring** | `infra`, `grafanaloki-app` | companion to cicd/configuration (host secrets, scans) | Not a consuming API; no root `TODO.md` required unless brought into host rollups |

When a standard’s body assumes `src/app.js` + `config/{NODE_ENV}.json`, treat that as the **API row** unless the standard itself points at an alternate (for example frontend env migration).

## Consuming standards distribution

**Authoritative tree:** this repository (`discernible-io/docs`). Service-relative links assume `docs/` at the consuming repo root.

| Method | Authority | When to use |
| --- | --- | --- |
| **Git submodule** (preferred) | Pin a docs **commit SHA** in the consumer; README states the pin | Continuous sync with an explicit upgrade PR |
| **Git subtree** | Same—pin/merge from docs; README states last merge SHA | Prefer when submodule tooling is awkward |
| **Reference-only** | Consumer has **no** vendored `docs/`; README links to this repo (commit or tag) | Light consumers (static sites, plugins) that only need a few guides |
| **Plain file copy** | **Non-authoritative** | Allowed only as a temporary convenience. Divergent copies must not be cited as “the standard.” Re-sync or replace with submodule/subtree |

**Conformance rule:** Audits judge against the **pinned docs commit** named in the consumer README (or against `main` of this repo when the consumer is reference-only). A stale vendored copy that disagrees with its pin is a **consumer gap**, not a license to invent a third variant.

## Per-repository TODO and host summaries

This section expands principle **21** above.

### Per-repo `TODO.md`

| Rule | Action |
| --- | --- |
| Name and location | Repository root, exactly `TODO.md` |
| Purpose | Open work for that service (gaps, ordered improvements, checklists) |
| Branches | Keep **main** and **development** content identical |
| Indexing | Link from the service `README.md` |
| Not for | Time-bound CVE/remediation plans (`*-plan.md`) or numbered standards migrations ([`planned-improvements.md`](planned-improvements.md)) |

### Host summary (`<hostname>-TODO.md`)

| Rule | Action |
| --- | --- |
| Location | This standards repo: `docs/<hostname>-TODO.md` |
| Direction | One-way: service `TODO.md` → host summary |
| Contents | Table of sources plus a short consolidation of **open** items (not a full copy of each backlog) |
| Refresh | Re-read sibling `TODO.md` files; update **Collected**; leave service files unchanged |
| Reference | [`dedalo43-TODO.md`](dedalo43-TODO.md) on host `dedalo43`; [`dedalo47-TODO.md`](dedalo47-TODO.md) on host `dedalo47` |

## Service-relative links

This section expands principle **14** above. When adding or reviewing links:

- **Inside `docs/`** — use same-directory names (`configuration-standard.md`) or paths relative to the current file.
- **Into application code** — use `../` from `docs/` (for example `../src/app.js`). Valid only when `docs/` is at the consuming repo root.
- **Into sibling repos** — use `../../<repo>/...` when documenting shared infra; document that the path is optional and local to the operator layout.
- **Do not** rewrite service-relative links to absolute GitHub URLs solely to satisfy link checkers in a docs-only clone.
