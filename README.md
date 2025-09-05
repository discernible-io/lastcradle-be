![rodit logo banner](./banner.png)

# RODiT Authentication API Server

This repository contains a sample API server that demonstrates the implementation of RODiT-based authentication using the RODiT Authentication SDK. The project is structured with a reusable SDK for RODiT authentication and a sample Express.js API that showcases its usage

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
Version 1.0.24 running on testnet at Smart Contract 20251001-rodit-org.testnet
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
    "userselected_dn": "CN=Discernible,OU=Cloud Engineering,OU=Platform Services,O=Rodit Technologies Inc,L=San Fernando,ST=Cadiz,C=ES",
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

The API server includes Swagger documentation accessible at `/api-docs` when the server is running.

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