# RODiT Authentication API

A production-ready Node.js API server implementing the RODiT (Robust Decentralized Identity Token) authentication system with comprehensive session management, access control, and monitoring capabilities.

## Overview

This API provides secure authentication services using the Discernible Authentication system, enabling applications to implement cryptographic identity verification, JWT-based authorization, and fine-grained access control.

**Version**: 2025.10.01  

| Branch | Role | URL |
|--------|------|-----|
| **`main`** | Main tier (SDK 9.x after merge from `development`) | https://api.discernible.io:9443 |
| **`development`** | Staging / integration | https://api.dihola.io:9443 |
| **`legacy`** | Archive of pre-migration `main` (read-only) | — |

See [`docs/BRANCHING.md`](docs/BRANCHING.md).

## Documentation

| Document | Summary |
| --- | --- |
| [`docs/game-peer-authentication.md`](docs/game-peer-authentication.md) | HOLA offline P2P between agents; game API scope vs Passport proof |
| [`docs/security-compliance.md`](docs/security-compliance.md) | Gap analysis and verification checklist against organization standards |
| [`docs/BRANCHING.md`](docs/BRANCHING.md) | Branch roles (`main`, `development`, `legacy`) and promotion workflow |
| [`scripts/README-database-init.md`](scripts/README-database-init.md) | SQLite initialization for development and deployment |
| [`api-docs/swagger.json`](api-docs/swagger.json) | OpenAPI 3.0 spec (authoritative API contract; served at `/api-docs/swagger.json`) |

### Organization standards ([`docs/`](docs/))

Vendored from [discernible-io/docs](https://github.com/discernible-io/docs) at commit `606b439`. Service-relative links in these files resolve in this repository.

| Document | Summary |
| --- | --- |
| [`docs/documentation-standard.md`](docs/documentation-standard.md) | How documentation is written, indexed, and cross-referenced |
| [`docs/vocabulary-standard.md`](docs/vocabulary-standard.md) | Deployment tier terms (**development** / **main**) and naming conventions |
| [`docs/configuration-standard.md`](docs/configuration-standard.md) | Config sources, priority order, secrets, and safe logging of settings |
| [`docs/logging-standard.md`](docs/logging-standard.md) | Winston/SDK logging patterns, `LOG_LEVEL`, structured context, and Loki |
| [`docs/error-handling-standard.md`](docs/error-handling-standard.md) | API error response shape and SDK `sendError` usage |
| [`docs/allowed-fallback-standard.md`](docs/allowed-fallback-standard.md) | Permitted config and RPC fallbacks |
| [`docs/cicd-deployment-standard.md`](docs/cicd-deployment-standard.md) | GHCR builds, Podman deploy, host secrets/TLS, and multi-environment CI/CD |
| [`docs/planned-improvements.md`](docs/planned-improvements.md) | Cross-service migration and improvement backlog |
| [`docs/rpc-configuration.md`](docs/rpc-configuration.md) | `NEAR_NETWORK_CONFIG` options for RPC reliability |
| [`docs/frontend-branch-env-migration.md`](docs/frontend-branch-env-migration.md) | Branch-specific frontend `.env` migration notes |

## Architecture

### Technology Stack

- **Runtime**: Node.js 20 (Alpine Linux)
- **Framework**: Express.js 4.19
- **Authentication**: @rodit/rodit-auth-be SDK 9.10.6 (aligned with idclawserver-idc)
- **Database**: SQLite 5.1 (sessions + application data)
- **Session Store**: connect-sqlite3 with express-session
- **Logging**: Winston 3.17 with Grafana Loki integration
- **API Documentation**: Swagger/OpenAPI 3.0 (swagger-ui-express)
- **Secrets Management**: HashiCorp Vault
- **Blockchain**: NEAR Protocol integration

### Infrastructure

```
┌─────────────────────────────────────────────────────────┐
│                    Internet (HTTPS)                      │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │   nginx (Port 9443)  │
              │   - TLS 1.2/1.3      │
              │   - Security Headers │
              │   - CORS Handling    │
              │   - Rate Limiting    │
              └──────────┬───────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │  Node.js (Port 8080) │
              │  - Express Server    │
              │  - RODiT SDK         │
              │  - JWT Validation    │
              └──────────┬───────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
    ┌────────┐    ┌──────────┐    ┌──────────┐
    │ SQLite │    │  Vault   │    │   Loki   │
    │   DB   │    │ (Secrets)│    │ (Logs)   │
    └────────┘    └──────────┘    └──────────┘
```

### Deployment

- **Platform**: DigitalOcean Droplet (Ubuntu)
- **Container Runtime**: Podman (rootless containers)
- **Pod Architecture**: Single pod with nginx + Node.js containers
- **CI/CD**: GitHub Actions (`.github/workflows/deploy.yml`)
- **Deployment Target**: 178.62.195.21
- **TLS Certificates**: Let's Encrypt (mounted at `/app/certs`)

## Features

### Core Functionality

- **Authentication**: RODiT credential-based login with cryptographic signature verification
- **Session Management**: Persistent SQLite-backed sessions with configurable expiration
- **Authorization**: Route-level permissions with JWT claims validation
- **Token Renewal**: Automatic JWT refresh for eligible sessions
- **Webhook Integration**: Configurable webhooks for audit events

### API contract

All endpoints are defined in [`api-docs/swagger.json`](api-docs/swagger.json) (authoritative per [`docs/documentation-standard.md`](docs/documentation-standard.md)). Explore interactively at `/api-docs` or `GET /api-docs/swagger.json` on a running server.

Surface areas: authentication, CRUDA comments, sessions, metrics, MCP, client signing, and `/api/game/*` (Bargain Against Entropy).

## Installation

### Prerequisites

- Node.js 20.x or higher
- npm or compatible package manager
- SQLite 3.x
- (main tier deploy) Podman or Docker
- (main tier deploy) nginx with TLS certificates

### Local Development

```bash
# Clone the repository
git clone https://github.com/rodit/servertest.git
cd servertest

# Install dependencies
npm install

# Set NODE_ENV to match config/development.json or config/main.json (see Configuration)

# Initialize database
chmod +x scripts/init-database.sh
./scripts/init-database.sh

# Start development server
npm start
```

The API will be available at `http://localhost:8080`

## Configuration

Configuration is managed through the `config` package with environment variable overrides.

### Key Configuration Files

- `config/development.json` / `config/main.json` - Per-environment configuration (`NODE_ENV`)
- `config/custom-environment-variables.json` - Maps env vars into config keys
- Environment variables override config values using `__` notation

### Required Environment Variables

```bash
# Node Environment (development or main)
NODE_ENV=main
LOG_LEVEL=info

# NEAR Blockchain
NEAR_CONTRACT_ID=rodit.near
NEAR_RPC_URL=https://rpc.mainnet.near.org
NEAR_CREDENTIALS_JSON_B64=<base64-encoded-credentials>

# Vault (Secrets Management)
VAULT_ENDPOINT=https://vault.example.com
VAULT_ROLE_ID=<vault-role-id>
VAULT_SECRET_ID=<vault-secret-id>
VAULT_RODIT_KEYVALUE_PATH=secret/rodit

# Logging (Grafana Loki)
LOKI_URL=https://loki.example.com
LOKI_BASIC_AUTH=<username:password>
LOKI_TLS_SKIP_VERIFY=false
SERVICE_NAME=servertest-api

# RODiT Configuration
RODIT_NEAR_CREDENTIALS_SOURCE=vault
MINTING_FEEACCOUNT=fees.rodit.near
MINTING_FEE=0.1

# Security Options
SECURITY_OPTIONS_LOGIN_MODE=standard
SECURITY_OPTIONS_SILENT_LOGIN_FAILURES=false
SECURITY_OPTIONS_SERVERORCLIENT=server

# API Options
API_DEFAULT_OPTIONS_DB_PATH=/app/data/rodit.db
API_DEFAULT_OPTIONS_LOG_DIR=/app/logs
API_VERSION=1.0.0

# Game operator (privileged contest endpoints)
GAME_PRIVILEGED_RODIT_ID=your.operator.rodit.near
```

## Deployment

### GitHub Actions Workflow

The deployment is automated via GitHub Actions (`.github/workflows/deploy.yml`):

1. **Trigger**: Push to `main` or `development`, or manual workflow dispatch
2. **Build**: Gitleaks, package age gate, `npm ci`, permission map validate, GHCR push
3. **Deploy**: SSH to branch-specific host, `podman pull` by SHA, `--env-file secrets/secrets.env`, linger script

The **`legacy`** branch is archived and does not deploy. See [docs/BRANCHING.md](docs/BRANCHING.md).

### Manual Deployment

```bash
# SSH to main-tier server
ssh user@178.62.195.21

# Navigate to application directory
cd ~/servertest-app

# Prefer CI/GHCR (see docs/BRANCHING.md). Local parity:
./scripts/deploy-local-podman.sh
TARGET=main ./scripts/deploy-local-podman.sh

# Create pod and run containers
podman pod create --name servertest-pod -p 9443:9443
podman run -d --pod servertest-pod --name servertest-container \
  -v ~/servertest-app/data:/app/data:Z \
  -v ~/servertest-app/logs:/app/logs:Z \
  -v ~/servertest-app/certs:/app/certs:ro,Z \
  -e NODE_ENV=main \
  [... other env vars ...] \
  servertest-image:latest

podman run -d --pod servertest-pod --name servertest-nginx \
  -v ~/servertest-app/certs:/app/certs:ro,Z \
  -v ~/servertest-app/logs/nginx:/var/log/nginx:Z \
  servertest-nginx:latest
```

### nginx Configuration

Environment-specific configs (`nginx/nginx.main.conf`, `nginx/nginx.development.conf`) are baked via `NODE_ENV` in `nginx.Dockerfile`:

- **TLS Termination**: TLS 1.2/1.3 with modern cipher suites
- **Security Headers**: HSTS, CSP, X-Frame-Options, etc.
- **CORS**: Deny-by-default; only listed origins receive `Access-Control-Allow-Origin`
- **Rate Limiting**: `limit_req` on public routes (login, MCP, docs, etc.)
- **Health**: Proxies `GET /health` to the API (dependency probes)
- **Logging**: JSON access logs; `/health` omitted from access log

Local deploy without rsync/GHCR: `./scripts/deploy-local-podman.sh` (requires `~/servertest-app/secrets/secrets.env`).

## Security

### Authentication Flow

1. Client sends RODiT credentials (roditid + signature)
2. Server verifies signature against NEAR blockchain
3. JWT token issued with configurable expiration
4. Subsequent requests include JWT in Authorization header
5. Middleware validates JWT and extracts user claims

### Security Features

- **Cryptographic Identity**: Ed25519 signature verification
- **JWT Tokens**: Short-lived tokens with automatic renewal
- **Session Management**: SQLite-backed persistent sessions
- **Rate Limiting**: Configurable per-route limits
- **CORS**: Whitelist-based origin validation
- **Security Headers**: Comprehensive HTTP security headers via nginx
- **Secrets Management**: HashiCorp Vault integration
- **TLS**: Modern TLS configuration with strong ciphers

### Access Control

Routes can require:
- **Authentication**: Valid JWT token
- **Authorization**: Specific permissions in token claims
- **Admin Privileges**: Elevated permissions for sensitive operations

## Monitoring & Logging

### Logging Stack

- **Winston**: Structured logging with multiple transports
- **Grafana Loki**: Centralized log aggregation
- **Log Levels**: debug, info, warn, error
- **Structured Context**: All logs include requestId, component, event

### Metrics

Available at `/api/metrics` (authenticated):
- Request counts and durations
- Error rates by endpoint
- Session statistics
- System resource usage (CPU, memory)

### Health Checks

- `GET /` - API health and version
- `GET /health` (nginx) - Load balancer health check

## Development

### Project Structure

```
servertest-rodit/
├── src/
│   ├── app.js                 # Main application entry point
│   ├── routes/                # Public route handlers (incl. mcproutes.js)
│   ├── protected/             # Protected route handlers
│   │   ├── cruda.js           # CRUDA showcase (auth + authorize)
│   │   └── metricsroutes.js
│   └── game/                  # Bargain Against Entropy
├── config/                    # Configuration files
├── api-docs/                  # OpenAPI specification
├── nginx/                     # nginx configuration
├── scripts/                   # Utility scripts
├── data/                      # SQLite databases (runtime)
├── logs/                      # Application logs (runtime)
├── api.Dockerfile            # Node.js container
├── nginx.Dockerfile          # nginx container
└── package.json

```

### Local verification

```bash
# Permission map matches swagger (both env files)
npm run validate:permissions

# Syntax / load check
node --check src/app.js

# Deploy smoke tests (API must be running)
API_BASE_URL=http://127.0.0.1:8080 node scripts/run-deployment-api-tests.js
```

### Code Style

- ESLint configuration for consistent code style
- Prettier for code formatting
- Structured logging with Winston
- Error handling with try-catch and middleware

## Troubleshooting

### Common Issues

**Issue**: `Authentication service unavailable`
- **Cause**: RoditClient not initialized
- **Solution**: Check Vault credentials and NEAR RPC connectivity

**Issue**: `Database locked`
- **Cause**: Multiple processes accessing SQLite
- **Solution**: Ensure only one instance is running, check file permissions

**Issue**: `Failed to connect to Loki`
- **Cause**: Network connectivity or authentication issue
- **Solution**: Verify LOKI_URL and LOKI_BASIC_AUTH, check TLS settings

**Issue**: `nginx 502 Bad Gateway`
- **Cause**: Node.js container not responding
- **Solution**: Check container logs: `podman logs servertest-container`

### Logs

```bash
# View application logs
podman logs servertest-container

# View nginx logs
podman logs servertest-nginx

# View logs on host
tail -f ~/servertest-app/logs/combined.log
tail -f ~/servertest-app/logs/nginx/nginxaccess.log
```

## API Usage Examples

### Authentication

```bash
# Login with RODiT credentials
curl -X POST https://api.discernible.io:9443/api/login \
  -H "Content-Type: application/json" \
  -d '{
    "roditid": "user.rodit.near",
    "roditid_base64url_signature": "...",
    "timestamp": 1234567890
  }'

# Response includes JWT token
{
  "jwt_token": "eyJhbGc...",
  "expires_in": 3600,
  "requestId": "01HQXXX..."
}
```

### Protected Endpoints

```bash
# Access protected endpoint with JWT
curl -X GET https://api.discernible.io:9443/api/token/claims \
  -H "Authorization: Bearer eyJhbGc..."

# Create a comment (requires permissions)
curl -X POST https://api.discernible.io:9443/api/cruda/create \
  -H "Authorization: Bearer eyJhbGc..." \
  -H "Content-Type: application/json" \
  -d '{"comment": "Hello, World!"}'
```

### Starting a game

**Bargain Against Entropy** lives under `/api/game/*`. Routes require a valid JWT (`authenticate` only — no `METHOD_PERMISSION_MAP` permission scopes). Players receive a **cradle** only if they call **join** while the lobby **joining window** is open (default **5 minutes**). On first join, the API sends a best-effort `cradle_assigned` webhook to the RODiT token's configured webhook URL.

Negotiation routes **public** messages through the API; **private coordination and HOLA mutual authentication happen entirely offline, directly peer-to-peer between agents** — not through this game API. Each peer **verifies independently** (IdentyClaw API or direct NEAR RPC, peer's choice) before honoring private trade proposals (**verify before execute**); game JWT is only for join, public broadcast, and execution settlement. The server does not track a reputation score — players affect one another's standing through what they say (public and private) and whether execution matches their talk.

See [`docs/game-peer-authentication.md`](docs/game-peer-authentication.md), and the **Negotiation and reputation** / **Peer authentication (HOLA)** subsections under **Game API** in [`api-docs/swagger.json`](api-docs/swagger.json) (also served at `/api-docs`).

Set a base URL for the examples below:

```bash
# Local dev
API_BASE=http://localhost:8080

# Staging / main tier
# API_BASE=https://api.dihola.io:9443
# API_BASE=https://api.discernible.io:9443
```

#### 1. Login challenge

```bash
curl -s "$API_BASE/api/login/timestamp"
```

Save `timestamp_iso` from the response (and optionally `timestamp`).

#### 2. Sign and obtain a JWT

Sign the UTF-8 string `roditid + timestamp_iso` (no separator) with your Ed25519 private key and encode the signature as base64url. Then:

```bash
JWT=$(curl -s -X POST "$API_BASE/api/login" \
  -H "Content-Type: application/json" \
  -d '{
    "roditid": "your.rodit.near",
    "timestamp_iso": "2026-06-18T12:00:00.000Z",
    "roditid_base64url_signature": "<base64url-signature>"
  }' | jq -r '.jwt_token')
```

Repeat steps 1–2 for each player (each identity needs its own JWT).

#### 3. Create a lobby

```bash
GAME=$(curl -s -X POST "$API_BASE/api/game/games" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "minAgents": 3,
      "joiningWindowDurationMs": 300000
    }
  }' | jq -r '.game.id')

echo "Lobby $GAME — joining window:"
curl -s "$API_BASE/api/game/games/$GAME/state" \
  -H "Authorization: Bearer $JWT" | jq '.game.joiningWindow'
```

Defaults: `minAgents` **3**, `joiningWindowDurationMs` **300000** (5 minutes). For a quick local smoke test, use `"minAgents": 1`.

Optional: schedule when the window opens:

```bash
curl -s -X POST "$API_BASE/api/game/games" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "joiningWindowStartsAt": "2026-06-18T18:00:00.000Z",
    "config": { "minAgents": 3 }
  }'
```

#### 4. Join (cradle assignment)

Each player must join **during** the open joining window:

```bash
curl -s -X POST "$API_BASE/api/game/games/$GAME/join" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"displayName": "Player One"}'
```

- Before the window opens → `409 JOIN_WINDOW_NOT_OPEN`
- After it closes → `409 JOIN_WINDOW_CLOSED`
- Same `roditId` joining again returns the existing agent (no second webhook)

#### 5. Start the game

When at least `minAgents` players have joined, start manually:

```bash
curl -s -X POST "$API_BASE/api/game/games/$GAME/start" \
  -H "Authorization: Bearer $JWT"
```

The lobby may also **auto-start** when the joining window ends if enough agents have joined. After start, turns advance through negotiation → message report → execution (see `GET /api/game/defaults`).

#### Monitor progress

```bash
# Public state (inventory/capacities visible only for your own agent)
curl -s "$API_BASE/api/game/games/$GAME/state" \
  -H "Authorization: Bearer $JWT"

# Server-sent events (phase changes, game finished, …)
curl -N "$API_BASE/api/game/games/$GAME/events" \
  -H "Authorization: Bearer $JWT"
```

#### Official contests (operator only)

`POST /api/game/contests` and `POST /api/game/games` with an official contest preset (`preset: "contest"` or `contestMode: "definitive"`) require the caller's JWT identity to match `GAME_PRIVILEGED_RODIT_ID` in server configuration. Casual lobbies use the flow above with any authenticated player.

```bash
curl -s -X POST "$API_BASE/api/game/contests" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "definitiveJoiningStartsAt": "2026-06-25T18:00:00.000Z",
    "prizeAmountYoctoNear": "1000000000000000000000000"
  }'
```

## License

Proprietary - Copyright (c) 2025 Discernible Inc. All rights reserved.

## Support

- **Email**: support@rodit-tech.com
- **Documentation**: https://docs.rodit-tech.com
- **Issues**: https://github.com/rodit/servertest/issues

## Contributing

This is a proprietary project. For contribution guidelines, please contact the development team.

---

**Last Updated**: 2025-01-01  
**Maintained by**: Discernible Inc.
