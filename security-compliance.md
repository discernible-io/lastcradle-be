# Security & standards compliance

> **Before editing:** Review [documentation-standard.md](../docs/docs/documentation-standard.md).

**Created:** 2026-05-29  
**Updated:** 2026-05-29  
**Scope:** `servertestapi` vs [discernible-io/docs](../docs/docs/) standards and `idclawserver-idc` reference implementation.

## Summary

| Area | Status | Notes |
|------|--------|--------|
| Auth (SDK 9.x, login challenge, Bearer JWT) | **Met** | Auth routes + swagger aligned |
| Error envelope (`sendError` / `ErrorResponse`) | **Met** | All routes; CRUDA idempotency replay normalized |
| Configuration (`config/{NODE_ENV}.json` + host secrets) | **Met** | `development` / `main`; no `default.json` |
| CI/CD (GHCR, Gitleaks, package age, dual branch) | **Met** | `.github/workflows/deploy.yml` |
| Secret scanning (Gitleaks) | **Met** | `.gitleaks.toml` + CI gate |
| Logging standard | **Met** | No `console.*` in `src/`; startup config snapshot |
| Documentation (swagger as source of truth) | **Met** | OpenAPI + `npm run validate:permissions` in CI |
| Production images (slim Node, no npm in runtime) | **Met** | Multi-stage `api.Dockerfile` |
| Host secrets (`secrets/secrets.env`) | **Met** | `--env-file` only; `NODE_ENV` via `-e` |
| systemd linger (rootless Podman) | **Met** | `scripts/ensure-podman-linger.sh` each deploy |
| API `GET /health` with dependency probes | **Met** | NEAR RPC + `roditAuth`; nginx proxies |
| Deploy-time API test suite | **Met** | `scripts/run-deployment-api-tests.js` (findings-only) |
| nginx edge hardening | **Met** | Deny-by-default CORS, `limit_req`, proxy `/health` |
| Geolocation middleware | **Deferred** | Not required for servertest showcase; policy TBD |
| GitHub operator secrets | **Operator** | `SSH_*_MAIN` / `SSH_*_DEVELOPMENT`, `GHCR_PULL_TOKEN` on host |

Legend: **Met** = implemented in repo; **Operator** = documented, configured outside git; **Deferred** = intentional non-goal for this API.

---

## Improvements (implementation status)

### Tier 1 — Low risk, low effort

| # | Item | Status |
|---|------|--------|
| 1 | `.gitleaks.toml` + Gitleaks in CI | **Met** |
| 2 | `npm run validate:permissions` in CI | **Met** (`build-images`) |
| 3 | Remove `console.*` from Loki bootstrap | **Met** |
| 4 | Document `GET /health` in swagger | **Met** (API JSON probes) |
| 5 | Host `secrets/secrets.env` only | **Met** |

### Tier 2 — Low–medium risk, medium effort

| # | Item | Status |
|---|------|--------|
| 6 | Complete OpenAPI alignment | **Met** |
| 7 | `config/development.json` + `config/main.json` | **Met** |
| 8 | Dual-branch deploy + GHCR SHA tags | **Met** |
| 9 | `ensure-podman-linger.sh` on deploy | **Met** |
| 10 | Slim multi-stage `api.Dockerfile` | **Met** |

### Tier 3 — Medium risk, medium effort

| # | Item | Status |
|---|------|--------|
| 11 | `sendError()` on all routes | **Met** |
| 12 | Startup configuration logging | **Met** (`startup-config.service.js`) |
| 13 | `nginx/nginx.{development,main}.conf` | **Met** |
| 14 | GitHub secrets split | **Operator** (see README / deploy workflow) |

### Tier 4 — Higher risk or larger effort

| # | Item | Status |
|---|------|--------|
| 15 | `GET /health` API + dependency probes | **Met** |
| 16 | Deploy-time API test suite | **Met** |
| 17 | nginx rate limits + deny-by-default CORS | **Met** |
| 18 | Geolocation middleware | **Deferred** |
| 19 | Remove legacy rsync deploy | **Met** (GHCR + `deploy-local-podman.sh`) |

---

## Verification checklist

- [x] `gitleaks` wired in CI (run locally: `gitleaks detect`)
- [x] Push to `development` / `main` triggers deploy workflow
- [x] `validateConfig` at startup
- [x] Login flow documented: `GET /api/login/timestamp` → `POST /api/login` → Bearer on `/api/cruda/*`
- [x] `POST /api/logout` via `authenticateForLogout`
- [x] `npm run validate:permissions` in CI
- [x] No secrets in workflow `-e` (env-file only)
- [x] Linger script on each deploy
- [ ] Operator: `loginctl show-user <deploy-user> -p Linger` → `yes` on each host
- [ ] Operator: GitHub secrets + `~/servertest-app/secrets/secrets.env` populated

---

## References

- Standards index: [../docs/docs/](../docs/docs/)
- Reference implementation: `../idclawserver-idc`
- OpenAPI: [api-docs/swagger.json](api-docs/swagger.json)
- Local deploy: [scripts/deploy-local-podman.sh](scripts/deploy-local-podman.sh)
