# Security & standards compliance

> **Before editing:** Review [documentation-standard.md](../docs/docs/documentation-standard.md).

| | |
|---|---|
| **Created** | 2026-05-29 |
| **Last updated** | 2026-06-16 |
| **Scope** | `servertestapi` vs [discernible-io/docs](../docs/docs/) and `idclawserver-idc` |
| **API role** | Auth reference + **CRUDA** comment showcase (no `/api/echo`) |

## Executive summary

All repository-tracked compliance items from the original gap analysis are **implemented**. Remaining work is **operator configuration** (GitHub secrets, host `secrets.env`, TLS, linger verification) and one **deferred** product decision (geolocation middleware).

| Legend | Meaning |
|--------|---------|
| **Met** | Implemented and verifiable in this repo |
| **Operator** | Documented; configured on hosts / in GitHub, not in git |
| **Deferred** | Intentionally out of scope for servertest |
| **Nuanced** | Met with a documented difference from idc |

---

## Summary matrix

| Area | Status | Evidence |
|------|--------|----------|
| Auth (SDK 9.x, timestamp challenge, Bearer JWT) | **Met** | `src/routes/auth*.routes.js`, swagger login paths |
| Error envelope (`sendError` / `ErrorResponse`) | **Met** | All route modules + global handlers; CRUDA idempotency replay normalized |
| Configuration | **Met** | `config/development.json`, `config/main.json`; no `default.json` |
| SDK `config` import | **Met** | `@rodit/rodit-auth-be` in `src/app.js`, `src/protected/cruda.js` |
| CI/CD | **Met** | `.github/workflows/deploy.yml` |
| Gitleaks | **Met** | `.gitleaks.toml`, `gitleaks-action` in `build-images` |
| Package age gate | **Met** | `scripts/enforce-minimum-package-age.js` |
| Permission map vs swagger | **Met** | `scripts/update-permissionsmap.js`; CI validate + generate |
| Logging (no `console.*` in app code) | **Met** | `src/` uses SDK logger; Loki bootstrap uses `logger.*WithContext` |
| Startup config snapshot | **Met** | `src/services/startup-config.service.js` (redacted, post-listen) |
| Slim production image | **Met** | Multi-stage `api.Dockerfile`, npm removed from runtime |
| Host secrets | **Met** | `podman run --env-file …/secrets/secrets.env`; only `NODE_ENV` via `-e` |
| systemd linger | **Met** | `scripts/ensure-podman-linger.sh` on each deploy |
| `GET /health` (API probes) | **Met** | `src/services/health.service.js`; nginx proxies `/health` |
| Deploy-time API tests | **Met** | `scripts/run-deployment-api-tests.js` (findings-only, non-blocking) |
| nginx edge hardening | **Met** | Deny-by-default CORS, `limit_req`, JSON gateway errors |
| Dual branch deploy | **Met** | `main` + `development` → GHCR SHA tags; `legacy` archived |
| Legacy rsync / host build | **Met** | GHCR pull only; `scripts/deploy-local-podman.sh` for local parity |
| `validateConfig` fail-fast | **Nuanced** | Logs **warn** on validation issues (idc **throws**); startup continues |
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
| Permission map generator | `scripts/update-permissionsmap.js` |
| Deploy workflow | `.github/workflows/deploy.yml` |
| nginx (per env) | `nginx/nginx.main.conf`, `nginx/nginx.development.conf` |
| Container images | `api.Dockerfile`, `nginx.Dockerfile` |
| Gitleaks allowlist | `.gitleaks.toml` |
| Deploy tests | `scripts/run-deployment-api-tests.js` |
| Local Podman deploy | `scripts/deploy-local-podman.sh` |

---

## Compliance by standard

### CI/CD deployment ([cicd-deployment-standard.md](../docs/docs/cicd-deployment-standard.md))

| Requirement | Status | Notes |
|-------------|--------|-------|
| GHCR build + immutable SHA pull | **Met** | `build-images` → `test-and-deploy` |
| Gitleaks before `npm ci` | **Met** | `fetch-depth: 0` checkout |
| Minimum package age | **Met** | `enforce-minimum-package-age.js` |
| Branches `main` / `development` | **Met** | `DOMAIN` / `NODE_ENV` per branch |
| `APP_DIR` from `SSH_USER_*` | **Met** | `/home/<user>/servertest-app` |
| Host `secrets/secrets.env` | **Met** | No workflow `-e` for secrets |
| Linger on every deploy | **Met** | SSH + `ensure-podman-linger.sh` |
| Advisory HTTPS health | **Met** | `continue-on-error: true`; JSON `status` grep |
| In-container deploy tests | **Met** | Non-blocking `podman exec … run-deployment-api-tests.js` |

### Configuration ([configuration-standard.md](../docs/docs/configuration-standard.md))

| Requirement | Status | Notes |
|-------------|--------|-------|
| Per-env JSON files | **Met** | `development` / `main` |
| `METHOD_PERMISSION_MAP` from swagger | **Met** | CI runs update + validate |
| `SESSION_SECRET` on main | **Met** | Placeholder in JSON; override in host secrets |
| Health / RPC tuning | **Met** | `HEALTH_CHECKS_CACHE_MS`, `NEAR_RPC_TIMEOUT` |

### Error handling ([error-handling-standard.md](../docs/docs/error-handling-standard.md))

| Requirement | Status | Notes |
|-------------|--------|-------|
| `{ error, requestId, timestamp }` | **Met** | `ErrorResponse` in swagger + routes |
| Login silent mode | **Met** | `SECURITY_OPTIONS.SILENT_LOGIN_FAILURES` |

### Logging ([logging-standard.md](../docs/docs/logging-standard.md))

| Requirement | Status | Notes |
|-------------|--------|-------|
| No `console.*` in `src/` | **Met** | Deploy test script uses `console.log` for JSON lines only |
| Redacted config snapshot | **Met** | 15s delay after listen (collector warmup) |
| NEAR RPC fallback audit | **Met** | `resolveHealthyNearRpcUrl` + host labels in logs |

### Documentation ([documentation-standard.md](../docs/docs/documentation-standard.md))

| Requirement | Status | Notes |
|-------------|--------|-------|
| Swagger as contract | **Met** | Auth, CRUDA, sessions/revoke, `/health` |
| Dual server URLs | **Met** | `api.discernible.io:9443`, `api.dihola.io:9443` |

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
| 3 | 11 | `sendError()` everywhere | **Met** |
| 3 | 12 | Startup config logging | **Met** |
| 3 | 13 | Env-specific nginx | **Met** |
| 3 | 14 | GitHub SSH secrets split | **Operator** |
| 4 | 15 | API `/health` + probes | **Met** |
| 4 | 16 | Deploy-time test suite | **Met** |
| 4 | 17 | nginx rate limit + CORS | **Met** |
| 4 | 18 | Geolocation | **Deferred** |
| 4 | 19 | No rsync deploy | **Met** |

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
podman logs servertest-container 2>&1 | grep -E 'configuration validated|Resolved configuration'
```

---

## Operator setup

Configure **once per environment** (not stored in this repo):

| Item | Where |
|------|--------|
| `SSH_HOST_MAIN`, `SSH_USER_MAIN`, `SSH_PRIVATE_KEY_MAIN`, `SSH_KNOWN_HOSTS_MAIN` | GitHub Actions secrets |
| `SSH_HOST_DEVELOPMENT`, `SSH_USER_DEVELOPMENT`, … | GitHub Actions secrets |
| `GHCR_PULL_TOKEN` | GitHub Actions + host `podman login ghcr.io` |
| `~/servertest-app/secrets/secrets.env` | Deploy host (`SESSION_SECRET`, NEAR creds, etc.) |
| TLS PEMs | `~/servertest-app/certs/fullchain.pem`, `privkey.pem` |
| Linger | `loginctl enable-linger <deploy-user>` or rely on deploy script |

Branches ([docs/BRANCHING.md](docs/BRANCHING.md)):

| Branch | Role | `NODE_ENV` | Deploy on push | `server_name` |
|--------|------|------------|----------------|---------------|
| `main` | Production | `main` | Yes | `api.discernible.io` |
| `development` | Staging | `development` | Yes | `api.dihola.io` |
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
- [x] Deploy API tests step (findings-only)
- [x] Advisory HTTPS health on JSON `status`

**Operator (per host)**

- [ ] GitHub secrets populated for target branch
- [ ] `secrets/secrets.env` present; `SESSION_SECRET` not left as placeholder on main
- [ ] TLS certs match `DOMAIN` / nginx `server_name`
- [ ] `loginctl show-user <deploy-user> -p Linger` → `yes`
- [ ] Login smoke: timestamp → login → Bearer on `/api/cruda/list`
- [ ] `POST /api/logout` with expired-but-valid-signature JWT (if testing logout)

---

## Contest game requirements (50-player timed event)

Target format: ~50 participants, one practice week, one definitive prize game, turns on a **15-minute cadence**, wall-clock cap **≤ 2 days**, live online following.

### Summary matrix

| Area | Status | Evidence / notes |
|------|--------|------------------|
| Phase timers (negotiation → message report → execution) | **Met** | Timers when duration &gt; 0; `scheduler.js` wires all phases |
| Absent-player auto-defaults on phase timeout | **Met** | Actual message counts + `{ type: "none" }` actions |
| `executionDurationMs` enforcement | **Met** | Enforced when &gt; 0 (0 = submission-gated for casual games) |
| Max turns / max game duration | **Met** | `maxTurns`, `maxGameDurationMs`, `ends_at`; forced finish + ranking |
| 50-player contest config preset | **Met** | `CONTEST_GAME_CONFIG` / `PRACTICE_GAME_CONFIG`; `GET /api/game/defaults/contest` |
| Practice vs definitive contest mode | **Met** | `contestMode`; `POST /api/game/contests` series + lobby auto-start |
| Scheduled lobby / auto-start | **Met** | `contest-orchestrator.js` watches joining window end + lobby full |
| Spectator-safe public state | **Met** | Non-participants no longer bypass hide/find fog-of-war |
| Game list / live push (SSE or WebSocket) | **Met** | `GET /api/game/games`; `GET /api/game/games/:id/events` (SSE) |
| Prize settlement (winner → NEAR/auth) | **Partial** | `prize-settlement.js` records winner + audit ref; NEAR transfer is operator |
| 50-player survival balance calibration | **Operator** | `scripts/calibrate-contest-50p.js` (+ `calibrate-survival-turns.js`) before locking rules |

### Contest preset parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `maxAgents` / `minAgents` | 50 | Full lobby |
| `finishSurvivorCount` | 1 | Single clear winner for prize |
| `negotiationDurationMs` | 8 min | Main trading window |
| `messageReportDurationMs` | 2 min | Self-report window |
| `executionDurationMs` | 5 min | Action window (15 min total per turn) |
| `turnIntervalMs` | 15 min | Documented cadence target (phase sum) |
| `maxTurns` | 192 | 48 h ÷ 15 min |
| `maxGameDurationMs` | 48 h | Hard wall-clock cap |
| `survivalCostPlayerReference` | 50 | Survival pressure calibrated at full lobby |

### Implementation files

| Concern | Path |
|---------|------|
| Defaults + contest preset | `src/game/defaults.js` |
| Phase scheduling | `src/game/scheduler.js` |
| Turn resolution + forced finish | `src/game/engine.js` |
| Persistence (`ends_at`, `message_report_ends_at`) | `src/game/schema.js`, `src/game/repository.js` |
| HTTP surface | `src/game/routes.js` |
| Contest orchestration | `src/game/contest-orchestrator.js`, `src/game/prize-settlement.js` |
| Live push (SSE) | `src/game/events.js`, `GET /api/game/games/:id/events` |
| Phase-timer smoke test | `scripts/test-phase-timers.js` |
| 50-player calibration | `scripts/calibrate-contest-50p.js` |

### Security notes for contest mode

- **Phase timeouts must not leak hidden state** — auto-default message reports use server-side actual counts only; spectators must not gain intelligence visibility (see `canViewerSeeCapacities`).
- **Forced finish at deadline** must be deterministic (survivors ranked by alive status, then total inventory, then later elimination) so prize disputes are auditable.
- **Rate limits** on game endpoints remain via existing nginx / `userratelimitmw`; contest traffic may need tighter per-route limits (operator).
- **Official contest creation** requires `createOfficialContest` on the JWT `permissions` array for `POST /api/game/contests` and for `POST /api/game/games` when the config matches an official contest (`contestMode: "definitive"` or 50-player min/max). Practice/casual lobbies keep standard game scopes.
- Grant `createOfficialContest` only to operator service accounts (not general player tokens).

### Verification

```bash
node scripts/test-phase-timers.js
node scripts/test-contest-orchestrator.js
node scripts/test-joining-window.js
node scripts/calibrate-contest-50p.js
node --check src/game/contest-orchestrator.js
node --check src/game/scheduler.js
```

---

## Deferred / future

| Item | Rationale |
|------|-----------|
| Geolocation middleware (`checkGeolocation`) | Policy decision; JWT geo claims unused in servertest |
| `validateConfig` fail-fast on `main` | Optional hardening: match idc and `process.exit(1)` on validation failure |
| Expand deploy test suite | Current script covers health, timestamp, welcome, swagger paths; extend per [test-constitution.md](../docs/docs/test-constitution.md) as needed |
| Contest orchestration (practice week, auto-start, prizes) | Implemented — see [Contest game requirements](#contest-game-requirements-50-player-timed-event) |

---

## References

- Standards: [../docs/docs/](../docs/docs/)
- Reference app: `../idclawserver-idc`
- OpenAPI: [api-docs/swagger.json](api-docs/swagger.json)
- Deploy workflow: [.github/workflows/deploy.yml](.github/workflows/deploy.yml)
- Local deploy: [scripts/deploy-local-podman.sh](scripts/deploy-local-podman.sh)
- Operator README: [README.md](README.md)
