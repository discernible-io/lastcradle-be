# RODiT Authentication API

A production-ready Node.js API server implementing the RODiT (Robust Decentralized Identity Token) authentication system with comprehensive session management, access control, and monitoring capabilities.

## Overview

This API provides secure authentication services using the Discernible Authentication system, enabling applications to implement cryptographic identity verification, JWT-based authorization, and fine-grained access control.

**Version**: 2025.10.01  
**Production URL**: https://api.discernible.io:9443  
**API Documentation**: https://api.discernible.io:9443/api-docs

## Standards compliance

See [security-compliance.md](security-compliance.md) for gap analysis against [discernible-io/docs](https://github.com/discernible-io/docs) standards and the ranked improvement backlog.

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

### API Endpoints

#### Public Endpoints
- `GET /` - Health check and API information
- `GET /api/home` - Homepage endpoint
- `POST /api/login` - User authentication
- `GET /api-docs` - Interactive Swagger UI
- `GET /api-docs/swagger.json` - OpenAPI specification

#### Protected Endpoints (Require Authentication)
- `POST /api/logout` - Session termination
- `GET /api/token/claims` - Inspect JWT token claims
- `GET /api/metrics` - Performance metrics
- `GET /api/metrics/system` - System resource metrics
- `POST /api/metrics/reset` - Reset metrics (admin only)

#### CRUDA Operations (Require Authentication + Permissions)
- `POST /api/cruda/create` - Create comment
- `POST /api/cruda/list` - List all comments
- `GET /api/cruda/list` - List all comments (GET)
- `POST /api/cruda/read` - Read specific comment
- `GET /api/cruda/read/:id` - Read comment by ID
- `POST /api/cruda/update` - Update comment
- `PUT /api/cruda/update` - Update comment (PUT)
- `POST /api/cruda/destroy` - Delete comment
- `DELETE /api/cruda/destroy` - Delete comment (DELETE)

#### Session Management (Admin)
- `POST /api/sessions/login` - Create session
- `POST /api/sessions/logout` - End session
- `GET /api/sessions/list_all` - List all active sessions
- `POST /api/sessions/close` - Terminate specific session
- `POST /api/sessions/cleanup` - Clean up expired sessions

#### MCP (Model Context Protocol)
- `GET /api/mcp/resources` - List available resources
- `GET /api/mcp/resource/:uri` - Get specific resource
- `GET /api/mcp/schema` - Get OpenAPI schema

#### Client Token Signing
- `POST /api/signclient` - Sign new client RODiT token

## Installation

### Prerequisites

- Node.js 20.x or higher
- npm or compatible package manager
- SQLite 3.x
- (Production) Podman or Docker
- (Production) nginx with TLS certificates

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
# Node Environment
NODE_ENV=production
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
```

## Deployment

### GitHub Actions Workflow

The deployment is automated via GitHub Actions (`.github/workflows/deploy.yml`):

1. **Trigger**: Push to `main` branch or manual workflow dispatch
2. **Build**: Install dependencies and prepare artifacts
3. **Deploy**: 
   - SSH to production server
   - Build Docker images (`api.Dockerfile`, `nginx.Dockerfile`)
   - Create Podman pod with both containers
   - Mount volumes for certs, logs, and data
   - Configure environment variables
   - Start services

### Manual Deployment

```bash
# SSH to production server
ssh user@178.62.195.21

# Navigate to application directory
cd ~/servertest-app

# Pull latest changes
git pull origin main

# Build and restart containers
podman pod rm -f servertest-pod
podman build -t servertest-image:latest -f api.Dockerfile .
podman build -t servertest-nginx:latest -f nginx.Dockerfile .

# Create pod and run containers
podman pod create --name servertest-pod -p 9443:9443
podman run -d --pod servertest-pod --name servertest-container \
  -v ~/servertest-app/data:/app/data:Z \
  -v ~/servertest-app/logs:/app/logs:Z \
  -v ~/servertest-app/certs:/app/certs:ro,Z \
  -e NODE_ENV=production \
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
│   ├── routes/                # Public route handlers
│   │   ├── home.js
│   │   ├── login.js
│   │   ├── signclient.js
│   │   └── mcproutes.js
│   ├── protected/             # Protected route handlers
│   │   ├── cruda.js           # CRUDA showcase (auth + authorize)
│   │   └── metricsroutes.js
│   └── mcp/                   # MCP implementation
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

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test suite
npm test -- --grep "Authentication"
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
