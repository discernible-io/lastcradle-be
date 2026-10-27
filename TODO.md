# Security & standards compliance

> **Before editing:** Review [`documentation-standard.md`](docs/documentation-standard.md).

**Created:** 2026-05-29  
**Last updated:** 2026-10-22 (P2 NEAR_RPC env mutation Met; P4 cleared; API Node digest + SBOM; OpenAPI P3 still open)

| | |
|---|---|
| **Scope** | `syntheticslastcradle` vs organization standards in [`docs/`](docs/) and `idclawserver-idc` |
| **API role** | Auth reference + **CRUDA** comment showcase (no `/api/echo`) |

## Executive summary

CI/CD, OpenAPI contract, `sendError()` on routes (including malformed JSON), Gitleaks, permission-map validation, slim API image (npm stripped, `apk` tini), config boolean encoding, `validateConfig` fail-fast, main-tier stack policy, consolidated request logging, session fail-fast on main, and nginx/domain alignment are **in place**. Remaining work is **narrow** — see [Remaining gaps](#remaining-gaps): optional OpenAPI tightening, plus **operator** host/GitHub setup and **deferred** product items (geolocation). `NEAR_RPC_URL` startup no longer mutates `process.env` (aligned with `api-scaffold-federated-idc` as of 2026-10-22). P4 branch-config cleanup and API Node digest + SBOM landed the same day.

| Legend | Meaning |
|--------|---------|
| **Met** | Implemented and verifiable in this repo |
| **Gap** | Standard requirement not yet met; repo change tracked below |
| **Operator** | Documented; configured on hosts / in GitHub, not in git |
| **Deferred** | Intentionally out of scope for syntheticslastcradle |
| **Nuanced** | Mostly met with a documented difference from idc or the standard |

---

## Remaining gaps

### Repo-tracked (nuanced / optional)

| Priority | Standard | Gap | Evidence | Suggested fix |
|----------|----------|-----|----------|---------------|
| P2 | [`configuration-standard.md`](docs/configuration-standard.md) | ~~Config via SDK, not ad-hoc `process.env` mutation~~ **Met 2026-10-22** | Startup uses `config.get("NEAR_RPC_URL")` only; no `process.env` write | Reference: `api-scaffold-federated-idc`. `idclawserver-idc` still mutates env at startup |
| P3 | [`documentation-standard.md`](docs/documentation-standard.md) | Some game OpenAPI objects are still loose | `GamePublicState` and `GameSse*` components cover state and SSE. `narrative` and `turnInvestments` remain `additionalProperties: true` | Tighten those objects as the game API stabilizes |

**Cleared (2026-10-22):** former **P4** — tier keys `NEAR_CONTRACT_ID` / `LOKI_URL` / `PUBLIC_PORT` / `LOKI_TLS_SKIP_VERIFY` are in branch JSON; unused `MINTING_FEE*` removed from `custom-environment-variables.json` and README; unused names dropped from the vendored configuration-standard table.

### Operator-only (not repo gaps)

| Item | Where |
|------|--------|
| GitHub `SSH_*` / `GHCR_PULL_TOKEN` | GitHub Actions secrets |
| Host `secrets/secrets.env` (`SESSION_SECRET`, NEAR creds, `NEAR_RPC_URL`, …) | Deploy host |
| TLS PEMs | `~/syntheticlc-app/certs/` |
| Linger verification | `loginctl enable-linger <deploy-user>` |

### Deferred (product / policy)

| Item | Rationale |
|------|-----------|
| Geolocation middleware (`checkGeolocation`) | Policy decision; JWT geo claims unused in syntheticslastcradle |
| See also [Deferred / future](#deferred--future) | Remaining product backlog |

---

## Summary matrix

| Area | Status | Evidence |
|------|--------|----------|
| Auth (SDK 9.x, timestamp challenge, Bearer JWT) | **Met** | `src/routes/auth*.routes.js`, swagger login paths |
| Error envelope on routes (`sendError` / `ErrorResponse`) | **Met** | Route modules + global 404/error handlers |
| Malformed JSON / parse errors | **Met** | `INVALID_JSON` via `sendError` after `express.json` in `src/app.js` |
| Configuration files + permission map | **Met** | Per-env JSON string booleans + swagger sync; `validateConfig` fail-fast |
| SDK `config` import | **Met** | `config.get` throughout; startup no longer mutates `process.env.NEAR_RPC_URL` (2026-10-22) |
| CI/CD workflow shape | **Met** | `.github/workflows/deploy.yml` — Gitleaks, age gate, GHCR, linger, advisory health |
| CI/CD tini sourcing | **Met** | `api.Dockerfile` — `/sbin/tini` from `apk` only |
| Gitleaks | **Met** | CI scan + placeholder regex allowlist in `.gitleaks.toml` |
| Package age gate | **Met** | `scripts/enforce-minimum-package-age.js` |
| Permission map vs swagger | **Met** | `scripts/update-permissionsmap.js` skips `/api/game/*`; 16 CRUDA/session/metrics ops; CI validate passes |
| Logging (no `console.*` in `src/`) | **Met** | Grep clean; deploy test script uses `console.log` for JSON lines only |
| Logging structure (`*WithContext`, completion) | **Met** | Single `Request completed` at `info` with `component: "API"` |
| Stack trace redaction on main | **Met** | `isMainTier()` gates stacks in `setupFallbackHandlers()` |
| Startup config snapshot | **Met** | `src/services/startup-config.service.js` (redacted, post-listen) |
| Slim API image (npm removed) | **Met** | Multi-stage `api.Dockerfile`, npm stripped from runtime; Node base pinned `node:22.23.4-alpine@sha256:…` (CVE-2026-111497); SBOM/provenance on image publish |
| Allowed fallbacks only | **Met** | Session fail-fast on main; Swagger tier URL from `SERVICE_NAME`; webhook policy documented in `cruda.js` |
| Host secrets wiring | **Met** | `podman run --env-file …/secrets/secrets.env`; only `NODE_ENV` via `-e` |
| systemd linger | **Met** | `scripts/ensure-podman-linger.sh` on each deploy |
| `GET /health` (API probes) | **Met** | `src/services/health.service.js`; nginx proxies `/health` |
| Deploy-time API tests | **Met** | Non-blocking smoke runner (`scripts/run-deployment-api-tests.js`) via workflow |
| nginx edge hardening | **Met** | Deny-by-default CORS, `limit_req`, JSON gateway errors |
| Dual branch deploy | **Met** | `main` + `development` → GHCR SHA tags; `legacy` archived |
| Legacy rsync / host build | **Met** | GHCR pull only; `scripts/deploy-local-podman.sh` for local parity |
| Documentation index | **Met** | README indexes `docs/`; local verification commands match `package.json` |
| Vocabulary in README | **Met** | **main** / **development** tier terms; `NODE_ENV=main` in examples |
| Geolocation middleware | **Deferred** | Not required for CRUDA showcase |
| GitHub / host secrets | **Operator** | See [Operator setup](#operator-setup) |

---

## Key implementation files

| Concern | Path |
|---------|------|
| Application entry | `src/app.js` |
| CRUDA showcase | `src/protected/cruda.js` |
| Auth (public) | `src/routes/auth.public.routes.js`, `auth-timestamp.public.routes.js` |
| Sessions (privileged) | `src/routes/session.privileged.routes.js` |
| Health probes | `src/services/health.service.js`, `near-rpc-probe.service.js` |
| Startup config log | `src/services/startup-config.service.js` |
| OpenAPI (source of truth) | `api-docs/swagger.json` |
| Permission map generator | `scripts/update-permissionsmap.js`, `scripts/sync-game-openapi-auth.js` |
| Game permissions / auth policy | `src/game/permissions.js`, `src/game/routes.js` |
| Deploy workflow | `.github/workflows/deploy.yml` |
| nginx (per env) | `nginx/nginx.main.conf`, `nginx/nginx.development.conf` |
| Container images | `api.Dockerfile`, `nginx.Dockerfile` |
| Gitleaks allowlist | `.gitleaks.toml` |
| Deploy tests | `scripts/run-deployment-api-tests.js` |
| Local Podman deploy | `scripts/deploy-local-podman.sh` |

---

## Compliance by standard

### Vocabulary ([`vocabulary-standard.md`](docs/vocabulary-standard.md))

| Requirement | Status | Notes |
|-------------|--------|-------|
| Branches / `NODE_ENV` / config files | **Met** | `main` / `development`; `config/main.json`, `config/development.json` |
| GitHub secrets `_MAIN` / `_DEVELOPMENT` | **Met** | `.github/workflows/deploy.yml` |
| Local deploy `TARGET=development\|main` | **Met** | `scripts/deploy-local-podman.sh` |
| No *production* for deployment tier in app code | **Met** | `isMainTier()` in `src/app.js`; README uses **main** / **development** |

### CI/CD deployment ([`cicd-deployment-standard.md`](docs/cicd-deployment-standard.md))

| Requirement | Status | Notes |
|-------------|--------|-------|
| GHCR build + immutable SHA pull | **Met** | `build-images` → `test-and-deploy` |
| Gitleaks before `npm ci` | **Met** | `fetch-depth: 0` checkout |
| Minimum package age | **Met** | `enforce-minimum-package-age.js` |
| Branches `main` / `development` | **Met** | `DOMAIN` / `NODE_ENV` per branch |
| `APP_DIR` from `SSH_USER_*` | **Met** | `/home/<user>/syntheticlc-app` |
| Host `secrets/secrets.env` | **Met** | No workflow `-e` for secrets |
| Linger on every deploy | **Met** | SSH + `ensure-podman-linger.sh` |
| Advisory HTTPS health | **Met** | `continue-on-error: true`; JSON `status` grep |
| In-container deploy tests | **Met** | Non-blocking step; smoke coverage (`/health`, timestamp, `/`) |
| Slim API image, npm removed | **Met** | Multi-stage `api.Dockerfile` |
| `apk` tini only in production stage | **Met** | `ENTRYPOINT ["/sbin/tini", "--"]` in `api.Dockerfile` |

### Configuration ([`configuration-standard.md`](docs/configuration-standard.md))

| Requirement | Status | Notes |
|-------------|--------|-------|
| Per-env JSON files | **Met** | `development` / `main` |
| `METHOD_PERMISSION_MAP` from swagger | **Met** | CI runs update + validate |
| `SESSION_SECRET` on main | **Met** | Placeholder in JSON; override in host secrets |
| Health / RPC tuning | **Met** | `HEALTH_CHECKS_CACHE_MS`, `NEAR_RPC_TIMEOUT` |
| Boolean values as `"true"` / `"false"` strings | **Met** | `config/development.json`, `config/main.json` |
| `validateConfig` aborts startup | **Met** | Re-throw after error log in `startServer()` |
| No ad-hoc `process.env` mutation | **Met** | Startup leaves RPC selection to SDK config layers (2026-10-22) |

### Error handling ([`error-handling-standard.md`](docs/error-handling-standard.md))

| Requirement | Status | Notes |
|-------------|--------|-------|
| Route handlers use `sendError()` | **Met** | All route modules + middleware |
| Global 404 / uncaught errors use `sendError()` | **Met** | `setupFallbackHandlers()` in `src/app.js` |
| `{ error, requestId, timestamp }` on API errors | **Met** | `ErrorResponse` in swagger + routes |
| Login silent mode | **Met** | `SECURITY_OPTIONS.SILENT_LOGIN_FAILURES` |
| Malformed JSON → `sendError` | **Met** | `INVALID_JSON` middleware after `express.json` |

### Logging ([`logging-standard.md`](docs/logging-standard.md))

| Requirement | Status | Notes |
|-------------|--------|-------|
| No `console.*` in `src/` | **Met** | Deploy test script uses `console.log` for JSON lines only |
| Redacted config snapshot | **Met** | 15s delay after listen (collector warmup) |
| NEAR RPC fallback audit | **Met** | `resolveHealthyNearRpcUrl` + host labels in logs |
| `*WithContext` + `component` on structured logs | **Met** | Request completion and lifecycle logs use `*WithContext` |
| Single request completion log at `info` | **Met** | One `Request completed` per request in `src/app.js` |
| Stack traces gated on main tier | **Met** | `isMainTier()` in global error handler |

### Allowed fallbacks ([`allowed-fallback-standard.md`](docs/allowed-fallback-standard.md))

| Requirement | Status | Notes |
|-------------|--------|-------|
| Config fallback (SDK layers) | **Met** | `@rodit/rodit-auth-be` `config.get` |
| RPC fallback with audit logging | **Met** | `resolveHealthyNearRpcUrl()` + structured logs |
| No other fallback patterns | **Met** | Main-tier session fail-fast; Swagger uses `SERVICE_NAME` tier URL |
| Webhook failure policy explicit | **Met** | Documented in `src/protected/cruda.js` (best-effort delivery) |

### Documentation ([`documentation-standard.md`](docs/documentation-standard.md))

| Requirement | Status | Notes |
|-------------|--------|-------|
| Swagger as contract | **Met** | Auth, CRUDA, sessions, `/health`, full `/api/game/*` with `x-game-auth` policy |
| Runtime serves static swagger | **Met** | `/api-docs` and `/api-docs/swagger.json` load `api-docs/swagger.json` (no swagger-jsdoc drift) |
| `npm run validate:permissions` | **Met** | Game paths excluded; map matches swagger (16 ops) |
| Dual server URLs | **Met** | `api.lastcradle.io`, `slcapi.dihola.io:9443` |
| README indexes all docs | **Met** | Standards, game howtos, `scripts/README-database-init.md` |
| README commands match `package.json` | **Met** | Local verification section lists `validate:permissions`, `node --check`, deploy smoke tests |

---

## Tier checklist (original improvement list)

| Tier | # | Item | Status |
|------|---|------|--------|
| 1 | 1 | `.gitleaks.toml` + CI | **Met** |
| 1 | 2 | `validate:permissions` in CI | **Met** |
| 1 | 3 | No `console.*` in Loki bootstrap | **Met** |
| 1 | 4 | `/health` in swagger | **Met** |
| 1 | 5 | `secrets.env` only | **Met** |
| 2 | 6 | OpenAPI alignment | **Met** |
| 2 | 7 | Branch config files | **Met** |
| 2 | 8 | Dual-branch GHCR deploy | **Met** |
| 2 | 9 | Linger script | **Met** |
| 2 | 10 | Slim `api.Dockerfile` | **Met** |
| 3 | 11 | `sendError()` on routes | **Met** |
| 3 | 12 | Startup config logging | **Met** |
| 3 | 13 | Env-specific nginx | **Met** |
| 3 | 14 | GitHub SSH secrets split | **Operator** |
| 3 | 15 | `validateConfig` fail-fast | **Met** |
| 3 | 16 | Config boolean string encoding | **Met** |
| 4 | 17 | API `/health` + probes | **Met** |
| 4 | 18 | Deploy-time test suite | **Met** | Smoke runner via workflow (non-blocking) |
| 4 | 19 | nginx rate limit + CORS | **Met** |
| 4 | 20 | Geolocation | **Deferred** |
| 4 | 21 | No rsync deploy | **Met** |
| 4 | 22 | Malformed JSON → `sendError` | **Met** |
| 4 | 23 | Logging consolidation + main-tier stack policy | **Met** |
| 4 | 24 | Allowed-fallback hygiene (session, swagger) | **Met** |

---

## Local verification commands

```bash
# Permission map matches swagger (both env files)
npm run validate:permissions

# Secret scan (requires gitleaks installed)
gitleaks detect --config .gitleaks.toml

# Syntax / load check
node --check src/app.js

# Deploy tests against local API (API must be running)
API_BASE_URL=http://127.0.0.1:8080 node scripts/run-deployment-api-tests.js
```

After deploy on host:

```bash
curl -fsSk "https://<DOMAIN>:9443/health" | jq .
loginctl show-user <deploy-user> -p Linger
podman logs syntheticlc-container 2>&1 | grep -E 'configuration validated|Resolved configuration'
```

---

## Operator setup

Configure **once per environment** (not stored in this repo):

| Item | Where |
|------|--------|
| `SSH_HOST_MAIN`, `SSH_USER_MAIN`, `SSH_PRIVATE_KEY_MAIN`, `SSH_KNOWN_HOSTS_MAIN` | GitHub Actions secrets |
| `SSH_HOST_DEVELOPMENT`, `SSH_USER_DEVELOPMENT`, … | GitHub Actions secrets |
| `GHCR_PULL_TOKEN` | GitHub Actions + host `podman login ghcr.io` |
| `~/syntheticlc-app/secrets/secrets.env` | Deploy host (`SESSION_SECRET`, NEAR creds, etc.) |
| TLS PEMs | `~/syntheticlc-app/certs/fullchain.pem`, `privkey.pem` |
| Linger | `loginctl enable-linger <deploy-user>` or rely on deploy script |

Branches ([`BRANCHING.md`](docs/BRANCHING.md)):

| Branch | Role | `NODE_ENV` | Deploy on push | `server_name` |
|--------|------|------------|----------------|---------------|
| `main` | Main tier | `main` | Yes | `api.lastcradle.io` |
| `development` | Development tier | `development` | Yes | `slcapi.dihola.io` |
| `legacy` | Pre-migration archive | — | No | — |

---

## Verification checklist

**Repo (automated or local)**

- [x] Gitleaks in CI
- [x] Package age gate in CI
- [x] `npm run validate:permissions` in CI
- [x] Dual-branch workflow (`main`, `development`)
- [x] No secrets in workflow `-e` (env-file only)
- [x] Linger script invoked each deploy
- [x] Deploy API tests step (findings-only, non-blocking)
- [x] Advisory HTTPS health on JSON `status`
- [x] `sendError()` on routes and global handlers
- [x] Config booleans as `"true"` / `"false"` strings
- [x] `validateConfig` fail-fast on startup
- [x] Main-tier stack trace / `NODE_ENV` guard (`isMainTier()`)
- [x] Malformed JSON error envelope (`INVALID_JSON`)
- [x] `api.Dockerfile` tini via `apk` only
- [x] README vocabulary and verification commands
- [x] Gitleaks placeholder regex allowlist (no whole-config paths)
- [x] CRUDA webhook best-effort policy documented

**Operator (per host)**

- [ ] GitHub secrets populated for target branch
- [ ] `secrets/secrets.env` present; `SESSION_SECRET` not left as placeholder on main
- [ ] TLS certs match `DOMAIN` / nginx `server_name`
- [ ] `loginctl show-user <deploy-user> -p Linger` → `yes`
- [ ] Login smoke: timestamp → login → Bearer on `/api/cruda/list`
- [ ] `POST /api/logout` with expired-but-valid-signature JWT (if testing logout)

---

## Always-on ranked casual play

Contest / season / prize surfaces were removed from the active line (archived on `archive/contest-season1`, tag `contest-season1`). Games are open-enrollment casual lobbies; every finish updates a global ladder with weekly snapshots.

### Summary matrix

| Area | Status | Evidence / notes |
|------|--------|------------------|
| Phase timers (negotiation → execution) | **Met** | Timers when duration &gt; 0; `scheduler.js` wires all phases |
| Absent-player auto-defaults on phase timeout | **Met** | `{ type: "none" }` actions |
| `executionDurationMs` enforcement | **Met** | Enforced when &gt; 0 (casual defaults use ~4 min AFK caps) |
| Max turns / max game duration | **Met** | Optional `maxTurns`, `maxGameDurationMs`, `ends_at` |
| Lobby auto-start / stale sweep | **Met** | `lobby-orchestrator.js` |
| Spectator-safe public state | **Met** | Non-participants do not bypass hide/find fog-of-war |
| Game list / live push (SSE) | **Met** | `GET /api/game/games`; `GET /api/game/games/:id/events` |
| Always-on global ranking | **Met** | `ranking.js`; `GET /api/game/ranking` |
| Weekly ranking snapshots | **Met** | `GET /api/game/ranking/weekly`; ISO-week freeze job |
| Per-game honors / hall of fame | **Met** | `hall-of-fame.js`; public spectator routes |

### Implementation files

| Concern | Path |
|---------|------|
| Defaults | `src/game/defaults.js` |
| Phase scheduling | `src/game/scheduler.js` |
| Turn resolution + forced finish | `src/game/engine.js` |
| Lobby lifecycle | `src/game/lobby-orchestrator.js` |
| Ranking + weekly snapshots | `src/game/ranking.js` |
| Live push (SSE) | `src/game/events.js` |
| Phase-timer smoke test | `scripts/test-phase-timers.js` |
| Hall of fame + ranking smoke | `scripts/test-hall-of-fame.js` |

### Security notes

- **Phase timeouts must not leak hidden state** — auto-default execution actions are `{ type: "none" }`; spectators must not gain intelligence visibility (see `canViewerSeeCapacities`).
- **Open enrollment** — passport JWT or guest join-by-url; guest `guest_*` ranking rows are per-session.
- **Rate limits** on game endpoints remain via existing nginx / `userratelimitmw`.
- Game routes accept any authenticated IdentyClaw / RODiT passport JWT (no `METHOD_PERMISSION_MAP`). See swagger `x-game-auth` and [`docs/game-player-onboarding-howto.md`](docs/game-player-onboarding-howto.md).

### Verification

```bash
node scripts/test-phase-timers.js
node scripts/test-stale-lobby-sweep.js
node scripts/test-hall-of-fame.js
node --check src/game/lobby-orchestrator.js
node --check src/game/ranking.js
node --check src/game/scheduler.js
```

---

## Deferred / future

| Item | Rationale |
|------|-----------|
| Geolocation middleware (`checkGeolocation`) | Policy decision; JWT geo claims unused in syntheticslastcradle |

---

## References

- Standards index: [`documentation-standard.md`](docs/documentation-standard.md) (vendored from [discernible-io/docs](https://github.com/discernible-io/docs))
- Reference app: `../idclawserver-idc`
- OpenAPI: [`api-docs/swagger.json`](api-docs/swagger.json)
- Game player onboarding: [`game-player-onboarding-howto.md`](docs/game-player-onboarding-howto.md)
- Game peer auth (HOLA): [`game-peer-authentication.md`](docs/game-peer-authentication.md)
- Game permissions: [`src/game/permissions.js`](src/game/permissions.js)
- Deploy workflow: [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
- Local deploy: [`scripts/deploy-local-podman.sh`](scripts/deploy-local-podman.sh)
- Operator README: [`README.md`](README.md)


## Standards gaps (host audit 2026-10-27)

Audited against discernible-io/docs `bad60c82`. Vendored pin in README is still `fcd5cf9` (behind host docs). Already-tracked: **P3** OpenAPI looseness; operator checklist; geolocation deferred.

| Priority | Gap | Standard | Suggested fix |
| --- | --- | --- | --- |
| P5 | Vendored `docs/` behind authoritative tree | documentation | Re-vendor / re-pin to current docs SHA; update README pin |
| P6 | ~~No `npm audit` in CI~~ | cicd-deployment | **Done** 2026-10-27 — `npm audit --omit=dev --audit-level=high` after `npm ci` (overrides + zod ^4.6.6) |
| P7 | ~~No Trivy image scan~~ | cicd-deployment | **Done** 2026-10-27 — Trivy CRITICAL/HIGH on API + nginx after push |
| P8 | ~~No blocking `npm test` before image publish~~ | test-constitution / cicd | **Done** 2026-10-27 — `npm test` (`test/validateConfig.test.js`) before Buildx; deploy smokes remain supplementary |
| P9 | Post-deploy health explicitly non-blocking | cicd-deployment | Decide: document exception or fail on `main` |
| P10 | No `pull_request` job / deploy concurrency | cicd-deployment | Add PR verify + deploy concurrency group keyed on the git ref |
| P11 | GHCR `:latest` from all branch pushes | cicd-deployment | `:latest` only from `main` |
