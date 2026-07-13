# Frontend Branch Env Migration

> **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

**Created:** 2026-05-24

This note documents the changes needed for React/Parcel frontends that are deployed from both `development` and `main` branches and need branch-specific public build configuration.

## Goals

- Build `development` with development API endpoints, for example `https://slc.dihola.io:8443`.
- Build `main` with main-tier API endpoints, for example `https://api.identyclaw.com:8443`.
- Stop tracking and deploying a single ambiguous `.env`.
- Prevent local `.env` files from overriding the selected branch config inside Docker builds.
- Remove console logging of sensitive form values, especially private keys such as `base58spprivateKey`.

## Env Files

Replace the single tracked `.env` with checked-in, non-secret branch files:

```text
.env.development
.env.main
```

Keep only public frontend build values in these files. In Create React App/Parcel style frontends, every `REACT_APP_*` value is bundled into the browser and must not be treated as a secret.

Example difference:

```dotenv
# .env.development
REACT_APP_SIGNAPIENDPOINT="https://slc.dihola.io:8443"
```

```dotenv
# .env.main
REACT_APP_SIGNAPIENDPOINT="https://api.identyclaw.com:8443"
```

Remove the tracked `.env` file. Keep `.env` ignored so local development can still copy one of the branch files:

```bash
cp .env.development .env
npm run build
```

## Git Ignore And Docker Ignore

Keep local env files ignored:

```gitignore
.env
.env.local
.env.development.local
.env.main.local
```

Allow the branch env files into the Docker build context, while excluding local `.env`:

```dockerignore
.env
.env.local
.env.*
!.env.development
!.env.main
!.env.example
```

## GitHub Actions

Derive `NODE_ENV` from the branch and copy the selected env before the frontend build:

```yaml
env:
  NODE_ENV: ${{ github.ref == 'refs/heads/main' && 'main' || 'development' }}

steps:
  - name: Install and build
    run: |
      cp ".env.${NODE_ENV}" .env
      npm ci
      npm run build
```

Pass the same `NODE_ENV` into the app image build:

```yaml
- name: Build and push app image
  uses: docker/build-push-action@v6
  with:
    context: .
    file: ./react.Dockerfile
    push: true
    build-args: |
      NODE_ENV=${{ env.NODE_ENV }}
```

## React Dockerfile

Make the app image select the branch env during the image build:

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
ARG NODE_ENV=development

COPY package*.json ./
COPY scripts ./scripts
COPY .env.development .env.main ./
RUN npm install

COPY . .
RUN cp ".env.${NODE_ENV}" .env && npm run build
```

Copying `.env` immediately before `npm run build` ensures any later `COPY . .` does not accidentally override the selected branch config.

## Local Deploy Scripts

If a local deploy script mirrors CI, it should use the same branch target:

```bash
cp ".env.${NODE_ENV}" .env
npm ci
npm run build

podman build -f react.Dockerfile \
  --build-arg "NODE_ENV=${NODE_ENV}" \
  -t "$APP_IMAGE_LOCAL" \
  "$REPO_ROOT"
```

## Helper Scripts

Any script that mutates frontend env values should stop writing only `.env`. Prefer either:

- update both `.env.development` and `.env.main` by default, or
- accept a target argument such as `development` or `main`.

For example:

```bash
node scripts/update-permissioned-routes.js all
node scripts/update-permissioned-routes.js development
node scripts/update-permissioned-routes.js main
```

## Sensitive Logging Cleanup

Remove form-level debug logging that dumps full values:

```javascript
console.log("Form values being submitted:", values);
console.log("JSON string being validated:", JSON.stringify(values, null, 2));
console.log("Validating values:", JSON.stringify(values, null, 2));
```

Also remove schema test helpers that log every field value. These can expose private keys during validation, including values such as `base58spprivateKey`.

If a private key has already appeared in browser logs, treat it as exposed and rotate it.

## Verification Checklist

- `development` build includes the development API endpoint.
- `main` build includes the main-tier API endpoint.
- `npm run build` succeeds after `cp .env.development .env`.
- `npm run build` succeeds after `cp .env.main .env`.
- No tracked `.env` remains.
- Local `.env` is ignored and not included in the Docker context.
- No console logs print private keys or full form payloads.
