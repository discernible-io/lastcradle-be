![rodit logo banner](./banner.png)

# RODiT Authentication API Server

This repository contains a sample API server that demonstrates the implementation of RODiT-based authentication using the RODiT Authentication SDK. The project is structured with a reusable SDK for RODiT authentication and a sample Express.js API that showcases its usage.

## Repository Structure

- `/sdk` - The RODiT Authentication SDK (can be used in other projects)
- `/src` - Sample API implementation using the SDK
- `/config` - Configuration files for the API server
- `/certs` - SSL certificates for secure connections
- `/nginx` - Nginx configuration for production deployment

## About RODiT Authentication

RODiT (Record of Digital Trust) authentication leverages blockchain-based tokens for secure authentication. This system uses Public Key Cryptography with ownership verification through the NEAR Protocol in real-time. The PKC pair used for authentication is tied directly to the RODiT tokens themselves.

Learn more about this approach in our [technical article](https://vaceituno.medium.com/unleashing-the-power-of-public-key-cryptography-with-non-fungible-tokens-513286d47524).

## Prerequisites

- Node.js (v16 or higher)
- npm (v7 or higher)
- Access to NEAR Protocol testnet (for RODiT verification)
- Vault server (for credential management)

## Getting Started

### Installation

```bash
# Install dependencies for the API server
npm install

# The SDK is now provided via npm package @rodit/rodit-auth-be
# No separate SDK installation needed
```

### Configuration

The API server requires several environment variables to be configured for proper operation:

#### Environment Variables

| Variable | Default Value | Description |
|----------|---------------|-------------|
| `API_DEFAULT_OPTIONS_DB_PATH` | `/app/data/database.sqlite` | Path to the SQLite database file |
| `API_DEFAULT_OPTIONS_LOG_DIR` | `/app/logs` | Directory for application log files |
| `LOKI_TLS_SKIP_VERIFY` | `true` | Skip TLS verification for Loki connections (development) |
| `LOKI_URL` | `https://grafana.cableguard.net:3100` | Loki endpoint URL for centralized logging |
| `NEAR_CONTRACT_ID` | `20251001-rodit-org.testnet` | NEAR Protocol contract ID for RODiT verification |
| `RODIT_NEAR_CREDENTIALS_SOURCE` | `vault` | Source for NEAR credentials (vault or file) |
| `SERVERPORT` | `8080` | Port number for the API server |
| `SERVICE_NAME` | `servertestapi-api` | Service name for logging and identification |
| `VAULT_ENDPOINT` | `https://vault.rodit.org:8200` | HashiCorp Vault server endpoint |
| `VAULT_RODIT_KEYVALUE_PATH` | `signing-keys` | Vault path for RODiT signing keys |
| `VAULT_TOKEN_TTL` | `0` | Vault token time-to-live (0 = no expiry) |

#### Required Secrets

The following secrets must be configured in your deployment environment:

| Secret | Description |
|--------|-------------|
| `VAULT_ROLE_ID` | HashiCorp Vault AppRole ID for authentication |
| `VAULT_SECRET_ID` | HashiCorp Vault AppRole Secret ID for authentication |

#### Configuration Steps

1. Set up your environment configuration in the `/config` directory
2. Configure Vault credentials for secure storage
3. Set up your NEAR Protocol connection details
4. Ensure all required environment variables are set in your deployment environment

### Database Initialization

Before running the API server for the first time, you need to initialize the SQLite database:

```bash
# Initialize the database and create required directories
node scripts/init-database.js

# Alternative: Use the shell script version
./scripts/init-database.sh

# Or manually create the database file
touch data/database.sqlite
sqlite3 data/database.sqlite "CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, author TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT, data TEXT, expires_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP); CREATE TABLE IF NOT EXISTS metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT, method TEXT, response_time INTEGER, status_code INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);"
```

This script will:
- Create the `data/` directory for the SQLite database file
- Create the `logs/` directory for application logs  
- Initialize the SQLite database with required tables (comments, sessions, metrics)
- Set proper permissions for database operations

**Note**: The database file will be created at `data/database.sqlite`. If you encounter `SQLITE_CANTOPEN` errors, ensure the `data/` directory exists and has proper write permissions. The deployment workflow now automatically handles database initialization.

### Running the API Server

```bash
# Start the API server with nodemon for development
npm start

# Or start as a background process
setsid npm start >/dev/null 2>&1 < /dev/null &
```

## Using the SDK in Your Own Projects

The RODiT Authentication SDK is available as an npm package `@rodit/rodit-auth-be`. Install it in your projects with:

```bash
npm install @rodit/rodit-auth-be
```

Then import the required modules:

```javascript
const { logger, authenticate, stateManager, roditManager } = require('@rodit/rodit-auth-be');
```

## RODIT Token Information Display

During startup, the API server automatically displays comprehensive RODIT token information, similar to the `roditwallet.sh` command output. This includes:

### Startup Information Display

When the server starts, you'll see output like:

```
=== RODiT Authentication System ===
Version 1.0.26 running on testnet at Smart Contract 20251001-rodit-org.testnet
Get help with: npm run help

RODiT Contents
▹▸▹▹▹ Authentication token information loaded...

{
  "token_id": "01K43ASJTMA4V81C46WCRADGVD",
  "metadata": {
    "allowed_cidr": "0.0.0.0/0",
    "allowed_iso3166list": "{\"allow\":[\"WLD\"]}",
    "jwt_duration": "3600",
    "max_requests": "0",
    "maxrq_window": "0",
    "not_after": "2035-09-01",
    "not_before": "2025-09-01",
    "openapijson_url": "https://api.discernible.io/api-docs",
    "permissioned_routes": "{\"entities\":{\"name\":\"api\",\"methods\":{\"/api/login\":\"+0\",\"/api/logout\":\"+0\",\"/login\":\"+0\",\"/logout\":\"+0\",\"/signclient\":\"+0\",\"/info\":\"+0\",\"/list_sessions\":\"+0\",\"/close_session\":\"+0\",\"/cleanup_sessions\":\"+0\",\"/metrics\":\"+0\",\"/reset_metrics\":\"+0\",\"/get_nonce\":\"+0\",\"/verify_signature\":\"+0\",\"/offline_get_nonce\":\"+0\",\"/offline_verify_signature\":\"+0\",\"/face_prompt\":\"+0\",\"/hash_match\":\"+0\",\"/api/list_agents\":\"+0\",\"/api/mcp/list_resources\":\"+0\",\"/api/mcp/resource/health\":\"+0\",\"/api/mcp/resource/subscriptions\":\"+0\",\"/api/mcp/resource/purchase\":\"+0\",\"/api/mcp/schema\":\"+0\"}}}",
    "serviceprovider_id": "bc=near.org;sc=20251001-rodit-org.testnet;id=01K3XWVNWBRHNKHZ94Q42GTENH;id=01K3XWVNWBWK2QR7BZ8K0HVE2J",
    "serviceprovider_signature": "IoT6gy6PUDJ_5zXS73Yspdl4otySHYUg7p5T-HpplVHq1-wSpsNG0q1DWyDnpkg2KT_K4NF6_NVT_QEqBXMIAA",
    "subjectuniqueidentifier_url": "https://api.discernible.io",
    "userselected_dn": "CN=Discernible,OU=Cloud Engineering,OU=Platform Services,O=Discernible Inc,L=San Fernando,ST=Cadiz,C=ES",
    "webhook_cidr": "0.0.0.0/0",
    "webhook_url": "https://webhook-not-set.example.com"
  }
}
```

### Using RODIT Information in Your API

The RODIT token information displayed during startup can be programmatically accessed in your API code:

```javascript
const { stateManager } = require('@rodit/rodit-auth-be');

// Get the complete RODIT configuration
const configObject = await stateManager.getConfigOwnRodit();
const roditToken = configObject.own_rodit;

// Access token metadata
const metadata = roditToken.metadata;
const tokenId = roditToken.token_id;

// Use specific metadata fields
const allowedRoutes = JSON.parse(metadata.permissioned_routes);
const jwtDuration = metadata.jwt_duration;
const allowedCIDR = metadata.allowed_cidr;
const serviceEndpoint = metadata.subjectuniqueidentifier_url;
```

### Key Metadata Fields and Their Usage

- **`token_id`**: Unique identifier for the RODIT token
- **`allowed_cidr`**: IP address ranges allowed to access the API
- **`jwt_duration`**: Token expiration time in seconds
- **`permissioned_routes`**: JSON string containing allowed API routes and methods
- **`serviceprovider_id`**: Blockchain contract and provider information
- **`subjectuniqueidentifier_url`**: Primary API endpoint URL
- **`not_before`/`not_after`**: Token validity period
- **`max_requests`/`maxrq_window`**: Rate limiting configuration

### Automatic Rate Limiting Configuration

The API automatically configures rate limiting based on RODIT token metadata:

```javascript
// Rate limits are automatically applied from token metadata
if (roditToken.metadata.max_requests && roditToken.metadata.maxrq_window) {
  // Rate limiter is automatically updated with these values
  updateRateLimit(roditToken.metadata.max_requests, roditToken.metadata.maxrq_window);
}
```

## RODIT Configuration for This API

When creating a RODIT token for this API server, use the following `permissioned_routes` configuration to grant access to all available endpoints:

### Complete RODIT JSON Configuration

```json
{
  "entities": {
    "name": "servertest-api",
    "methods": {
      "/": "+0",
      "/home": "+0",
      "/api/login": "+0",
      "/api/logout": "+0",
      "/login": "+0",
      "/logout": "+0",
      "/api/signclient": "+0",
      "/api/echo/echo": "+0",
      "/api/cruda/create": "+0",
      "/api/cruda/list": "+0",
      "/api/cruda/read": "+0",
      "/api/cruda/update": "+0",
      "/api/cruda/destroy": "+0",
      "/api/metrics": "+0",
      "/api/metrics/system": "+0",
      "/api/metrics/reset": "+0",
      "/api/mcp/resources": "+0",
      "/api/mcp/resource/*": "+0",
      "/api/mcp/schema": "+0",
      "/api/sessions/login": "+0",
      "/api/sessions/logout": "+0",
      "/api/sessions/list_all": "+0",
      "/api/sessions/close": "+0",
      "/api/sessions/cleanup": "+0",
      "/api-docs": "+0"
    }
  }
}
```

### Endpoint Categories

**Public Routes:**
- `/` - Root/welcome page
- `/home` - Homepage  
- `/api-docs` - Swagger API documentation

**Authentication Routes:**
- `/api/login`, `/login` - User authentication with RODiT credentials
- `/api/logout`, `/logout` - User logout and session termination
- `/api/signclient` - RODiT token signing service

**Protected Routes (require authentication):**
- `/api/echo/echo` - Echo service for testing authenticated requests
- `/api/cruda/*` - CRUD operations (create, list, read, update, destroy) for comments
- `/api/metrics/*` - Performance metrics and system monitoring endpoints
- `/api/mcp/*` - Model Context Protocol endpoints for AI integration
- `/api/sessions/*` - Administrative session management endpoints

**Rate Limiting:**
All endpoints are configured with `"+0"` which allows unlimited access at the endpoint level. Global rate limiting is controlled by the RODIT token's `max_requests` and `maxrq_window` metadata fields.

### Usage in RODIT Token Creation

When creating your RODIT token, include this JSON configuration in the `permissioned_routes` field of your token metadata. This ensures that users with valid RODIT tokens can access all API functionality according to their authentication level and permissions.

## API Documentation

The API server includes Swagger documentation accessible at `/api-docs` when the server is running. The OpenAPI specification is automatically generated and published as a build artifact.

### Swagger/OpenAPI Specification

The `api-docs/swagger.json` file contains the complete OpenAPI 3.0 specification for this API server. This file is:

- **Generated automatically** during the build process via `npm run build:swagger`
- **Published as an artifact** in GitHub Actions for easy access and distribution
- **Accessible at runtime** via the `/api-docs` endpoint when the server is running
- **Used for client generation** and API documentation

The swagger.json includes:
- Complete endpoint definitions with request/response schemas
- Authentication requirements for each endpoint
- Parameter validation rules
- Response status codes and error handling
- Example requests and responses

## Infrastructure and Deployment

This project uses a comprehensive containerized deployment strategy with multiple components working together to provide a secure, scalable, and observable API service.

### GitHub Actions Workflow (`.github/workflows/deploy.yml`)

The deployment pipeline automates the entire build and deployment process:

**Key Features:**
- **Multi-stage deployment** with dependency installation, testing, and containerized deployment
- **Artifact publishing** - Automatically generates and publishes swagger.json as a build artifact
- **SSH-based deployment** to remote servers with secure key management
- **Environment variable injection** for secure configuration management
- **Multi-container orchestration** using Podman pods for service isolation
- **Comprehensive logging** and debugging output for troubleshooting

**Deployment Flow:**
1. **Build Phase**: Installs dependencies, generates Swagger documentation, publishes artifacts
2. **Setup Phase**: Establishes SSH connection, creates directory structure, syncs files
3. **Container Phase**: Builds and deploys API, Nginx, and Promtail containers in a pod
4. **Verification Phase**: Checks container status and displays logs for monitoring

**Environment Configuration:**
- Uses GitHub Secrets for sensitive data (SSH keys, Vault credentials)
- Uses GitHub Variables for non-sensitive configuration
- Supports manual deployment with custom commit SHA selection
- Includes comprehensive environment variable debugging

### API Container (`api.Dockerfile`)

The main application container built on Node.js Alpine Linux:

**Security Features:**
- **Non-root user execution** with dedicated `nodeuser` account
- **Minimal attack surface** using Alpine Linux base image
- **Process management** via Tini init system for proper signal handling
- **Dependency optimization** with production-only npm install and cache cleanup

**Container Structure:**
- **Base**: `node:18-alpine` for small footprint and security
- **Working Directory**: `/app` with proper ownership and permissions
- **Exposed Port**: 8080 for internal pod communication
- **Entry Point**: Tini-managed Node.js process for graceful shutdown
- **Data Persistence**: Mounted volumes for `/app/data` and `/app/logs`

### Nginx Reverse Proxy (`nginx.Dockerfile` & `nginx/nginx.conf`)

Production-grade reverse proxy with comprehensive security and performance features:

**nginx.Dockerfile Features:**
- **Minimal container** based on `nginx:mainline-alpine`
- **SSL/TLS support** with OpenSSL for certificate management
- **Non-root execution** using nginx user for security
- **Custom configuration** with security-hardened defaults

**nginx.conf Security Configuration:**
- **TLS 1.2/1.3 only** with modern cipher suites and HSTS
- **Comprehensive security headers** (CSP, X-Frame-Options, etc.)
- **CORS handling** with origin validation and preflight support
- **Request size limits** to prevent DoS attacks (1M default, 10M for uploads)
- **Rate limiting** and timeout configuration
- **Custom error pages** with proper CORS headers

**Proxy Features:**
- **WebSocket support** with upgrade header handling
- **Load balancing** ready configuration
- **Loki proxy endpoint** at `/loki/` for log aggregation
- **Health check endpoints** with proper error handling
- **Request/response logging** with detailed format for monitoring

### Log Aggregation (`promtail/promtail-config.yml`)

Centralized logging configuration for observability:

**Promtail Configuration:**
- **Multi-source log collection** from application and nginx logs
- **Label extraction** for structured logging (component, logtype, level)
- **Pipeline processing** with regex parsing and filtering
- **Loki integration** with retry logic and TLS configuration
- **Performance optimization** with backoff strategies

**Log Processing Pipeline:**
- **Filename parsing** to extract component and log type information
- **Message filtering** to reduce noise (e.g., webhook startup messages)
- **Label standardization** for consistent querying in Grafana
- **Error handling** with graceful degradation

**Integration Features:**
- **Service labeling** using environment-driven service names
- **Hostname identification** for multi-instance deployments
- **Job categorization** for different log sources
- **Path-based collection** with wildcard support

## Docker Deployment

This repository includes Docker configuration for easy deployment:

```bash
# Build and run the API container
docker build -f api.Dockerfile -t rodit-api .
docker run -p 3000:3000 rodit-api

# For production with Nginx
docker-compose up -d
```

## Security Considerations
- All authentication tokens are transmitted via HTTP headers, not cookies
- Permissions are validated for each protected route
- Vault is used for secure credential storage
- Token expiry and renewal is handled automatically

## 5. Jump start your server account

Install near and create an implicit account ID and a key pair with the command:
near generate-key

Output example:
- Key pair with ed25519:BNcExLS7k84HswwFHpB49jZnh1y6bsRS7P51FVmeBBxs public key for an ACCOUNT "9a1de9b4aa4ddd4a3091f43f1de680a9f5405d70e8ca69c3fb5daa96b5cd1270"
- Resulting in the key pair stored in: ~/.near-credentials/testnet/9a1de9b4aa4ddd4a3091f43f1de680a9f5405d70e8ca69c3fb5daa96b5cd1270.json
- From your NEAR wallet send some 0.01 Near to the newly generated implicit account ID to activate it

# Deployment Troubleshooting Guide

## Pre-Deployment Setup (One-Time Only)

### 1. Database Initialization
**CRITICAL**: Run this once before first deployment:

```bash
# On the target server, after first file sync
cd ~/servertest-app
node scripts/init-database.js
```

This creates the required `data/` and `logs/` directories and initializes the SQLite database with necessary tables.

## Common Deployment Issues

### Issue 1: SQLITE_CANTOPEN Error
**Symptom**: Application fails to start with database connection errors
**Cause**: Database not initialized or missing directories
**Solution**: 
```bash
ssh user@178.128.173.226
cd ~/servertest-app
node scripts/init-database.js
```

### Issue 2: Container Port Mismatch
**Symptom**: Service unreachable, nginx proxy errors
**Current Configuration**:
- API container exposes: 8080, 9443
- GitHub Actions API_PORT: 9443
- Nginx proxies to: `servertest-container:8080`
- App default port: 8080 (configurable)

**Verification**:
```bash
# Check if containers are running on expected ports
podman ps -a
podman port servertest-container
```

### Issue 3: Environment Variables Missing
**Required Variables** (from GitHub Actions):
- `LOKI_URL` - Loki logging endpoint
- `LOKI_BASIC_AUTH` - Loki authentication
- `LOKI_TLS_SKIP_VERIFY` - TLS verification setting
- `RODIT_NEAR_CREDENTIALS_SOURCE` - RODiT credentials source
- `SERVICE_NAME` - Service identifier
- `SERVERPORT` - Server port override
- `NEAR_CONTRACT_ID` - NEAR blockchain contract
- `VAULT_ENDPOINT` - Vault service endpoint
- `VAULT_ROLE_ID` - Vault authentication
- `VAULT_SECRET_ID` - Vault authentication
- `VAULT_TOKEN_TTL` - Vault token lifetime

**Verification**:
```bash
# Check environment variables in running container
podman exec servertest-container env | grep -E "(LOKI_|RODIT_|SERVICE_|VAULT_|NEAR_)"
```

### Issue 4: Volume Mount Permissions
**Symptom**: Nginx fails to start, permission denied errors
**Solution**:
```bash
# Ensure proper permissions for nginx logs
mkdir -p ~/servertest-app/logs/nginx
chmod 0775 ~/servertest-app/logs/nginx
podman unshare chown -R 101:101 ~/servertest-app/logs/nginx
```

### Issue 5: Pod Networking Issues
**Symptom**: Nginx can't reach API container
**Verification**:
```bash
# Check pod status
podman pod ps
podman pod inspect servertest-pod

# Test container connectivity
podman exec servertest-nginx curl -f http://servertest-container:8080/ || echo "Connection failed"
```

## Deployment Verification Steps

### 1. Check Container Status
```bash
ssh user@178.128.173.226
podman ps -a
podman pod ps
```

### 2. Check Application Logs
```bash
# API container logs
podman logs servertest-container

# Nginx logs
podman logs servertest-nginx

# Promtail logs
podman logs servertest-promtail
```

### 3. Test API Endpoints
```bash
# Test health endpoint
curl -k https://api.discernible.io:9443/

# Test API documentation
curl -k https://api.discernible.io:9443/api-docs/swagger.json
```

### 4. Check Loki Integration
```bash
# Verify Loki connectivity from container
podman exec servertest-container curl -sS -k "$LOKI_URL/loki/api/v1/status/buildinfo"
```

## Manual Deployment Steps

If automated deployment fails, use these manual steps:

### 1. Prepare Environment
```bash
ssh user@178.128.173.226
mkdir -p ~/servertest-app/{certs,logs,data,nginx,promtail}
mkdir -p ~/servertest-app/logs/nginx
chmod 0775 ~/servertest-app/logs/nginx
```

### 2. Sync Files
```bash
# From local machine
rsync -avz --delete \
  --exclude '.git' \
  --exclude '.github' \
  --exclude 'node_modules' \
  --exclude 'certs' \
  --exclude 'logs' \
  --exclude 'data' \
  ./ user@178.128.173.226:~/servertest-app/
```

### 3. Initialize Database (First Time Only)
```bash
ssh user@178.128.173.226
cd ~/servertest-app
node scripts/init-database.js
```

### 4. Build and Deploy Containers
```bash
# Clean up existing resources
podman pod exists servertest-pod && podman pod rm -f servertest-pod
podman image exists servertest-image:latest && podman rmi -f servertest-image:latest

# Create pod
podman pod create --name servertest-pod -p 9443:9443

# Build and run API container
podman build -t servertest-image:latest -f api.Dockerfile .
podman run -d \
  --pod servertest-pod \
  --name servertest-container \
  --restart=unless-stopped \
  -e LOKI_URL='$LOKI_URL' \
  -e SERVICE_NAME='$SERVICE_NAME' \
  # ... (add all required environment variables)
  -v ~/servertest-app/logs:/app/logs:Z \
  -v ~/servertest-app/data:/app/data:Z \
  -v ~/servertest-app/certs:/app/certs:ro,Z \
  servertest-image:latest

# Build and run nginx
podman build -t localhost/servertest-nginx:latest -f nginx.Dockerfile .
podman run -d \
  --pod servertest-pod \
  --name servertest-nginx \
  --restart=unless-stopped \
  -v ~/servertest-app/certs:/app/certs:ro,Z \
  -v ~/servertest-app/logs/nginx:/var/log/nginx:Z,U \
  localhost/servertest-nginx:latest
```

## Debugging Commands

### Container Inspection
```bash
# Inspect running containers
podman inspect servertest-container
podman inspect servertest-nginx

# Check resource usage
podman stats

# Access container shell
podman exec -it servertest-container sh
```

### Network Debugging
```bash
# Test internal connectivity
podman exec servertest-nginx ping servertest-container
podman exec servertest-container netstat -tlnp
```

### Log Analysis
```bash
# Follow logs in real-time
podman logs -f servertest-container

# Search for specific errors
podman logs servertest-container 2>&1 | grep -i error
podman logs servertest-container 2>&1 | grep -i "sqlite\|database"
```

## Recovery Procedures

### Complete Reset
```bash
# Stop and remove everything
podman pod stop servertest-pod
podman pod rm -f servertest-pod
podman image prune -f

# Preserve data but reset containers
# (Database and logs are preserved in host volumes)
```

### Database Reset (Use with Caution)
```bash
# Backup existing data
cp ~/servertest-app/data/database.sqlite ~/servertest-app/data/database.sqlite.backup

# Reinitialize database
cd ~/servertest-app
node scripts/init-database.js
```

## Monitoring and Alerts

### Key Metrics to Monitor
- Container health status
- API response times
- Database connection status
- Loki log ingestion
- SSL certificate expiration

### Health Check Endpoints
- `GET /` - Basic health check
- `GET /api-docs` - API documentation availability
- `GET /api/rodit/info` - RODiT configuration status (requires auth)

## Contact Information

For deployment issues:
- Check GitHub Actions logs first
- Review container logs on target server
- Verify all environment variables are set
- Ensure database initialization was completed

Remember: Database initialization is a **one-time manual step** that must be completed before the first deployment.