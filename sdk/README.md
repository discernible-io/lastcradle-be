# RODiT SDK

A JavaScript SDK for interacting with RODiT authentication and API services. This SDK provides secure access to APIs using RODiT token-based authentication, with comprehensive validation, permission checking, and rate limiting based on token metadata.

> **Updated for 2025**: Now includes enhanced security features like timestamp validation to prevent replay attacks.

## Features

- **Token-based Authentication**: Secure authentication using RODiT tokens
- **Token Validation**: Verify token validity, expiration, and permissions
- **Timestamp Validation**: Prevent replay attacks by validating request timestamps
- **Subscription Management**: Check if service subscription is active
- **Secure API Request Handling**: Make authenticated API requests with proper headers
- **IP Authorization**: Validate client IP addresses against allowed CIDR ranges
- **Permission-based Access Control**: Control access based on token metadata
- **Webhook Support**: Register, manage, and verify webhooks
- **OpenAPI Integration**: Discover available endpoints from OpenAPI specifications
- **Session Management**: Handle authentication sessions with proper cleanup
- **Rate Limiting**: Respect rate limits defined in token metadata
- **Structured Logging**: Comprehensive logging with context for monitoring and debugging

## Installation

```bash
npm install @cableguard/rodit-sdk
```

## Quick Start

```javascript
const { RoditClient, createClient } = require('@cableguard/rodit-sdk');

async function main() {
  try {
    // Option 1: Create and initialize a client in one step
    const client = await createClient({
      credentialsPath: './credentials.json'
    });
    
    // Option 2: Create a client instance manually
    // const client = new RoditClient();
    // await client.init({ credentialsPath: './credentials.json' });
    
    // Check if token is valid
    if (!client.isTokenValid()) {
      console.error('Token is not valid at the current time');
      return;
    }
    
    // Make an authenticated API request
    const response = await client.request('GET', '/api/endpoint');
    console.log(response);
  } catch (error) {
    console.error('Error:', error.message);
  }
}

main();
```

## Authentication

The SDK supports authentication using RODiT tokens. The token metadata is loaded from the credentials file and used for all subsequent API requests.

### Login

```javascript
// Login to obtain a session token
const loginResult = await client.login();
console.log('Login successful, token expires:', loginResult.expiresAt);
```

### Logout

```javascript
// Logout to invalidate the session token
await client.logout();
console.log('Logout successful');
```

### Session Management

The SDK automatically manages sessions, including token refresh and cleanup:

```javascript
// The SDK handles token refresh automatically when making requests
// You can manually check if a refresh is needed
if (client.isTokenRefreshNeeded()) {
  await client.refreshToken();
}

// Session cleanup runs periodically, but can be triggered manually
await client.cleanupSessions();
```

## Configuration

The SDK can be configured in several ways:

### Using a Credentials File

```javascript
const client = await createClient({
  credentialsPath: './path/to/credentials.json'
});
```

### Using Environment Variables

```javascript
// Set environment variables
process.env.RODIT_API_ENDPOINT = 'https://api.example.com';
process.env.RODIT_TOKEN = 'your-token';

const client = await createClient();
```

### Using Direct Configuration

```javascript
const client = await createClient({
  apiEndpoint: 'https://api.example.com',
  token: 'your-token',
  // Other configuration options
  timeout: 5000,
  retries: 3
});
```

## API Reference

### RoditClient

The main client class for interacting with RODiT services.

#### Methods

- `init(options)`: Initialize the client with credentials
- `login()`: Authenticate and obtain a session token
- `logout()`: Invalidate the current session token
- `request(method, path, data, options)`: Make an authenticated API request
- `isTokenValid()`: Check if the token is valid
- `isSubscriptionActive()`: Check if the subscription is active
- `getRoditMetadata()`: Get the token metadata
- `isOperationPermitted(method, path)`: Check if an operation is permitted
- `refreshToken()`: Refresh the session token
- `cleanupSessions()`: Clean up expired sessions
- `getAvailableEndpoints()`: Get available API endpoints from OpenAPI spec

## Core Components

### RoditClient

The main client class for interacting with RODiT services.

```javascript
const client = new RoditClient({
  credentialsPath: './credentials.json' // Path to credentials file
});

// Initialize the client
await client.init();
```

### Utility Functions

The sdk provides several utility functions for working with RODiT tokens:

```javascript
const { utils } = require('@cableguard/rodit-sdk');

// Validate token configuration
const validationResult = await utils.validateRoditToken(config);

// Check if client IP is authorized
const isAuthorized = utils.isClientIpAuthorized('192.168.1.1', '192.168.1.0/24');

// Parse metadata JSON fields
const routes = utils.parseMetadataJson(metadata.permissioned_routes, {});
```

## Token Metadata

The RODiT token contains metadata that controls various aspects of API access:

| Field | Description |
|-------|-------------|
| subjectuniqueidentifier_url | API endpoint URL. The base URL for all API requests. |
| not_before | Token validity start date. Indicates when the service subscription begins. |
| not_after | Token expiration date. Indicates when the service subscription ends. |
| allowed_cidr | CIDR range for allowed client IP addresses. Defines the IP ranges from which the client is permitted to access the API. |
| allowed_iso3166list | JSON string of allowed country codes. Specifies which countries the API can be used from. |
| permissioned_routes | JSON string defining which API routes can be used and what rate limiting applies to them. |
| max_requests | Maximum number of requests allowed within the time window. |
| maxrq_window | Time window for rate limiting in seconds. |
| webhook_url | Webhook URL. Endpoint where notifications will be sent. |
| webhook_cidr | CIDR range for server IP addresses that are allowed to send webhooks to the client. |

## Examples

See the [examples directory](./examples) for complete usage examples:

- [Basic Usage](./examples/basic-usage.js) - Simple example of client initialization and API requests
- [Complete Example](./examples/complete-example.js) - Comprehensive example showing all sdk features

## Testing

Run the test suite with:

```bash
npm test
```

## License

MIT
