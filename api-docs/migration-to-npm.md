# Migration Guide: Switch from local `sdk/` to the npm package `@rodit/rodit-auth-be`

This guide enables a one-pass migration from a checked-in `sdk/` (or tarball) to the published npm package. It is designed to be reused across APIs with a similar structure.

## 0) One-pass checklist

- [ ] Add `@rodit/rodit-auth-be` to `dependencies` and remove any local tarball refs
- [ ] Prefer root-level import: `const auth = require('@rodit/rodit-auth-be')`
- [ ] Replace direct `sdk/` imports throughout `src/`
- [ ] Update Dockerfile/CI to install from registry only
- [ ] Start app and verify health/login/logout flows
- [ ] Remove `sdk/` once stable

## 1) Dependencies

- Update `package.json` to use the registry package (pin or caret per your policy):
  ```json
  {
    "dependencies": {
      "@rodit/rodit-auth-be": "^1.0.4"
    }
  }
  ```
- Remove any local file/tarball entries, e.g.:
  ```json
  "@rodit/rodit-auth-be": "file:sdk/rodit-rodit-auth-be-1.0.x.tgz"
  ```
- Refresh dependencies:
  ```bash
  rm -f package-lock.json && npm install   # or: npm install && commit new lock
  ```

## 2) Prefer root-level imports (recommended)

Use the package’s consolidated surface instead of deep paths. This reduces future breakage and centralizes versioning.

Example in `src/app.js`:
```js
// Before
// const auth = require('../sdk/index');
// const logger = require('../sdk/services/logger');
// const roditManager = require('../sdk/lib/auth/roditmanager');
// const stateManager = require('../sdk/lib/blockchain/statemanager');
// const loggingmw = require('../sdk/lib/middleware/loggingmw');

// After
const auth = require('@rodit/rodit-auth-be');
const { logger, roditManager, stateManager, loggingmw } = auth;
```

### Package export surface (CommonJS)
From the package root (`require('@rodit/rodit-auth-be')`), the following are exported:
- __Core middleware__: `authenticate` (alias `authenticate_apicall`), `login`, `logout`, `loginWithNEP413`
- __Validation__: `validatePermissions`
- __Token__: `validateToken`, `generateToken`
- __Services__: `sessionManager`, `blockchainService`, `stateManager`, `mcpService`, `performanceService`
- __Logging__: `logger`, `loggingmw`
- __Utils__: `utils`, `validateAndSetDate`, `validateAndSetJson`, `validateAndSetUrl`, `calculateCanonicalHash`
- __Versioning__: `versioning.middleware`, `versioning.manager`, `versioning.VersionManager`
- __Config/Client__: `roditManager`, `initConfig`, `RoditClient`, `configure`

If a consumer needs lower-level modules, they may still import deep paths (see Section 3), but root-level imports are preferred.

## 3) Deep-path imports (only if necessary)

If you must target specific modules directly, use these mappings:
- `../../sdk/lib/auth/sessionmanager` → `@rodit/rodit-auth-be/lib/auth/sessionmanager`
- `../../sdk/lib/middleware/authenticationmw` → `@rodit/rodit-auth-be/lib/middleware/authenticationmw`
- `../../sdk/lib/middleware/validatepermissions` → `@rodit/rodit-auth-be/lib/middleware/validatepermissions`
- `../../sdk/services/logger` → `@rodit/rodit-auth-be/services/logger`
- `../../sdk/services/mcpservice` → `@rodit/rodit-auth-be/services/mcpservice`
- `../../sdk/services/performanceservice` → `@rodit/rodit-auth-be/services/performanceservice`
- `../../sdk/utils` → `@rodit/rodit-auth-be/utils`
- `../../sdk/lib/auth/roditmanager` → `@rodit/rodit-auth-be/lib/auth/roditmanager`
- `../../sdk/lib/blockchain/statemanager` → `@rodit/rodit-auth-be/lib/blockchain/statemanager`
- `../../sdk/lib/middleware/loggingmw` → `@rodit/rodit-auth-be/lib/middleware/loggingmw`

Non-standard variants observed:
- `../../sdk/lib/serviceslogger` → `@rodit/rodit-auth-be/services/logger`
- `../../sdk/lib/servicesmcpservice` → `@rodit/rodit-auth-be/services/mcpservice`
- `../../sdk/lib/servicesperformanceservice` → `@rodit/rodit-auth-be/services/performanceservice`

## 4) Project-wide search/replace

- Identify old imports:
  ```bash
  rg "\.\./\.\./sdk/" src/
  ```
- Replace with root-level usage or deep-paths as needed. Scripted option (review diffs!):
  ```bash
  apply() { from="$1"; to="$2"; rg -l "${from//\//\/}" src/ | xargs -r sed -i "s#${from//#/}#${to//#/}#g"; }
  apply "../../sdk/utils" "@rodit/rodit-auth-be/utils"
  apply "../../sdk/lib/auth/roditmanager" "@rodit/rodit-auth-be/lib/auth/roditmanager"
  apply "../../sdk/lib/blockchain/statemanager" "@rodit/rodit-auth-be/lib/blockchain/statemanager"
  apply "../../sdk/lib/middleware/loggingmw" "@rodit/rodit-auth-be/lib/middleware/loggingmw"
  apply "../../sdk/lib/serviceslogger" "@rodit/rodit-auth-be/services/logger"
  apply "../../sdk/lib/servicesmcpservice" "@rodit/rodit-auth-be/services/mcpservice"
  apply "../../sdk/lib/servicesperformanceservice" "@rodit/rodit-auth-be/services/performanceservice"
  ```

## 5) Dockerfiles / containers

Install from the registry; do not copy `sdk/`:
```dockerfile
# Copy package files for deterministic installs
COPY package.json ./

# Install production deps
RUN npm install --production \
  && npm cache clean --force \
  && rm -rf /root/.npm/_cacache

# Copy source
COPY . .
```

Notes:
- If `package-lock.json` still points to a file: tarball, regenerate it locally and commit, or avoid copying the lockfile before `npm install` in the image build.

## 6) CI/CD

- Remove steps that package/copy `sdk/`.
- Ensure network access to the npm registry (auth if private).
- Use `npm ci` for reproducible builds (or `npm install` where appropriate).

### Environment Variable Configuration for Deployment

When deploying the API, ensure that environment variables are properly passed to the container runtime. The API requires specific environment variables for vault-based credential management and service configuration.

**Required environment variables for deployment:**
```yaml
# In GitHub Actions workflow (deploy.yml)
- name: Deploy API container
  run: |
    podman run -d \
      -e RODIT_NEAR_CREDENTIALS_SOURCE=vault \
      -e VAULT_ENDPOINT=${{ secrets.VAULT_ENDPOINT }} \
      -e VAULT_ROLE_ID=${{ secrets.VAULT_ROLE_ID }} \
      -e VAULT_SECRET_ID=${{ secrets.VAULT_SECRET_ID }} \
      -e VAULT_RODIT_KEYVALUE_PATH=${{ secrets.VAULT_RODIT_KEYVALUE_PATH }} \
      -e SERVICE_NAME=servertest-api \
      -e NEAR_CONTRACT_ID=${{ secrets.NEAR_CONTRACT_ID }} \
      # ... other container options
      your-api-image
```

**Critical notes:**
- Without `RODIT_NEAR_CREDENTIALS_SOURCE=vault`, the API will default to file-based credentials and fail to authenticate
- Vault credentials must be provided as GitHub secrets and passed to the container
- Missing environment variables will cause deployment failures or runtime authentication errors

## 7) Verification

- Local:
  ```bash
  npm install
  npm run start
  ```
  Validate:
  - Health endpoint responds
  - Login (including NEP-413), logout
  - Metrics & logs present

- Container:
  ```bash
  podman build -t your-api -f api.Dockerfile .
  podman run --rm -p 8080:8080 your-api
  ```

- Reverse proxy (Nginx): ensure upstream resolves once API is healthy.

## 8) Troubleshooting

- __crypto is not defined__
  - Ensure the code path comes from the npm package and that Node’s `crypto` is imported in any custom code using it.
- __nacl.util is undefined__
  - Import `tweetnacl-util` in code paths using `nacl.util.*`, or switch to `Buffer.from(base64, 'base64')` → `Uint8Array`.
- __Version mismatch__
  - Pin `@rodit/rodit-auth-be` to a known-good version. If a fix is needed, update local `/sdk`, bump the package, publish, and update the dependency.
- __Lingering local imports__
  - Re-run search for `../sdk/` or `../../sdk/` and remove/replace.
- __Configuration property 'API_DEFAULT_OPTIONS.DB_PATH' is not defined__
  - Ensure `API_DEFAULT_OPTIONS` section exists in `config/default.json` with required properties (`DB_PATH`, `LOG_DIR`)
  - Verify environment variable mappings in `config/custom-environment-variables.json`
- __rateLimit is not a function__
  - Use `ratelimitmw` instead of `rateLimit` when importing from the SDK: `const { ratelimitmw } = require('@rodit/rodit-auth-be')`
- __Cannot find module 'tweetnacl-util'__
  - Add `tweetnacl-util` dependency to `package.json`: `"tweetnacl-util": "^0.15.1"`
- __Deployment fails with credential errors__
  - Verify `RODIT_NEAR_CREDENTIALS_SOURCE=vault` environment variable is passed to container
  - Ensure all vault-related environment variables are properly configured in deployment script
  - Check that GitHub secrets are correctly referenced in the workflow

## 9) Rollback strategy

- Keep a branch/tag before migration.
- If runtime issues appear, revert to the previous commit, patch `/sdk`, publish a fixed package, and retry migration with the new version.

## 10) Cleanup

- After all services are stable on the npm package, remove the `sdk/` folder and any CI logic related to local packaging.

---

## Repo-specific notes (this project)

- `src/` now imports `@rodit/rodit-auth-be` exclusively. Example: `src/app.js` uses `const auth = require('@rodit/rodit-auth-be')` and destructures `logger`, `roditManager`, `stateManager`, `loggingmw` from it.
- Use the root export where possible to minimize coupling to internal paths.
