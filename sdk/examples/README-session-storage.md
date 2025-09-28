# Session Storage Configuration

This document explains how to configure session storage for the RODiT SDK using environment variables and configuration files.

## Default Configuration

By default, the SDK uses **in-memory storage** which requires no configuration:

```javascript
const { RoditClient } = require('@rodit/rodit-auth-be');
const client = new RoditClient();
// Automatically uses InMemorySessionStorage
```

## Configuration Options

### Environment Variable

Set the `SESSION_STORAGE_TYPE` environment variable:

```bash
# Use in-memory storage (default)
export SESSION_STORAGE_TYPE=memory

# Use Redis storage
export SESSION_STORAGE_TYPE=redis

# Use database storage
export SESSION_STORAGE_TYPE=database

# Use file-based storage
export SESSION_STORAGE_TYPE=file
```

### Configuration File

Add to your `config/default.json` or other config files:

```json
{
  "SESSION_STORAGE_TYPE": "memory",
  "SESSION_CLEANUP_INTERVAL": 3600000,
  "SESSION_TOKEN_RETENTION_PERIOD": 604800
}
```

The configuration follows the standard [node-config](https://github.com/node-config/node-config) pattern and supports:
- Environment-specific configs (`development.json`, `production.json`)
- Environment variable overrides
- Custom environment variable mappings

### Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `SESSION_STORAGE_TYPE` | `"memory"` | Storage backend type (`memory`, `redis`, `database`, `file`) |
| `SESSION_CLEANUP_INTERVAL` | `3600000` | Cleanup interval in milliseconds (1 hour) |
| `SESSION_TOKEN_RETENTION_PERIOD` | `604800` | Token retention period in seconds (7 days) |

**Environment Variables:**
```bash
export SESSION_STORAGE_TYPE=memory
export SESSION_CLEANUP_INTERVAL=3600000      # 1 hour in milliseconds
export SESSION_TOKEN_RETENTION_PERIOD=604800 # 7 days in seconds
```

## Storage Types

### 1. Memory Storage (Default)

**Configuration:** `SESSION_STORAGE_TYPE=memory`

- **Pros:** Fast, no external dependencies, zero configuration
- **Cons:** Sessions lost on restart, not suitable for multi-instance deployments
- **Use case:** Development, testing, single-instance applications

```javascript
// No additional setup required - this is the default
const client = new RoditClient();
```

### 2. Redis Storage

**Configuration:** `SESSION_STORAGE_TYPE=redis`

- **Pros:** Persistent, clustered, TTL support, high performance
- **Cons:** Requires Redis server, additional dependency
- **Use case:** Production, multi-instance applications, high availability

```javascript
const redis = require('redis');
const { setStorage } = require('@rodit/rodit-auth-be/lib/auth/sessionmanager');
const { RedisSessionStorage } = require('./examples/session-storage-examples');

// Set up Redis client
const client = redis.createClient({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD
});

await client.connect();

// Configure Redis storage
const redisStorage = new RedisSessionStorage(client, 'rodit:session:');
setStorage(redisStorage);
```

**Environment Variables:**
- `REDIS_HOST` - Redis server host (default: localhost)
- `REDIS_PORT` - Redis server port (default: 6379)
- `REDIS_PASSWORD` - Redis password (if required)
- `REDIS_DB` - Redis database number (default: 0)

### 3. Database Storage

**Configuration:** `SESSION_STORAGE_TYPE=database`

- **Pros:** Persistent, ACID compliance, complex queries possible
- **Cons:** Slower than Redis, requires database setup
- **Use case:** When you already have a database, need ACID compliance

```javascript
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { setStorage } = require('@rodit/rodit-auth-be/lib/auth/sessionmanager');
const { DatabaseSessionStorage } = require('./examples/session-storage-examples');

// Set up database
const db = await open({
  filename: process.env.SESSION_DB_PATH || './sessions.db',
  driver: sqlite3.Database
});

// Create sessions table
await db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    session_data TEXT NOT NULL,
    expires_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
`);

// Configure database storage
const dbStorage = new DatabaseSessionStorage(db);
setStorage(dbStorage);
```

**Environment Variables:**
- `SESSION_DB_PATH` - Database file path (default: ./sessions.db)

### 4. File Storage

**Configuration:** `SESSION_STORAGE_TYPE=file`

- **Pros:** Simple, no external dependencies, human-readable
- **Cons:** Not suitable for high concurrency, slower than memory/Redis
- **Use case:** Development, debugging, low-traffic applications

```javascript
const { setStorage } = require('@rodit/rodit-auth-be/lib/auth/sessionmanager');
const { FileSessionStorage } = require('./examples/session-storage-examples');

// Configure file storage
const fileStorage = new FileSessionStorage('./data/sessions');
setStorage(fileStorage);
```

**Environment Variables:**
- `SESSION_FILE_DIR` - Directory for session files (default: ./data/sessions)

## Implementation Examples

### Basic Setup

```javascript
// 1. Set environment variable
process.env.SESSION_STORAGE_TYPE = 'memory';

// 2. Initialize client (automatically uses configured storage)
const { RoditClient } = require('@rodit/rodit-auth-be');
const client = new RoditClient();

// 3. Check storage configuration
const storageInfo = await client.getSessionStorageInfo();
console.log('Storage type:', storageInfo.storageType);
```

### Application Startup

```javascript
const { configureStorageFromConfig } = require('@rodit/rodit-auth-be/lib/auth/sessionmanager');

// Configure storage based on environment/config
configureStorageFromConfig();

// Initialize your application
const app = express();
// ... rest of your application setup
```

### Custom Storage Implementation

```javascript
class CustomSessionStorage {
  async get(sessionId) { /* your implementation */ }
  async set(sessionId, session) { /* your implementation */ }
  async delete(sessionId) { /* your implementation */ }
  async keys() { /* your implementation */ }
  async size() { /* your implementation */ }
  async clear() { /* your implementation */ }
}

const { setStorage } = require('@rodit/rodit-auth-be/lib/auth/sessionmanager');
setStorage(new CustomSessionStorage());
```

## Configuration Validation

The SDK will validate your storage configuration and provide helpful warnings:

```javascript
const { RoditClient } = require('@rodit/rodit-auth-be');

const client = new RoditClient();
const storageInfo = await client.getSessionStorageInfo();

console.log({
  storageType: storageInfo.storageType,
  sessionCount: storageInfo.sessionCount,
  isConfigured: storageInfo.storageType !== 'InMemorySessionStorage' || process.env.SESSION_STORAGE_TYPE === 'memory'
});
```

## Migration Between Storage Types

Sessions are not automatically migrated when changing storage types. For production migrations:

1. **Memory → Redis/Database:** Sessions will be lost (users need to re-login)
2. **Redis → Database:** Export/import session data manually
3. **Any → Memory:** All persistent sessions will be lost

## Troubleshooting

### Common Issues

1. **"Storage missing required methods"**
   - Ensure your custom storage implements all required methods
   - Check method names are exact matches (case-sensitive)

2. **"Configuration property 'SESSION_STORAGE_TYPE' is not defined"**
   - Set the environment variable: `export SESSION_STORAGE_TYPE=memory`
   - Or add to your config file: `"SESSION_STORAGE_TYPE": "memory"`

3. **Redis/Database connection errors**
   - Check connection parameters (host, port, credentials)
   - Ensure the service is running and accessible
   - Verify network connectivity and firewall rules

### Debug Information

```javascript
const { sessionManager } = require('@rodit/rodit-auth-be/lib/auth/sessionmanager');

// Get current storage info
const storage = sessionManager.storage;
console.log('Storage type:', storage.constructor.name);

// For InMemorySessionStorage, get detailed info
if (storage.getStorageInfo) {
  console.log('Storage details:', storage.getStorageInfo());
}

// Check session count
console.log('Session count:', await storage.size());
```

## Best Practices

1. **Development:** Use `memory` storage for simplicity
2. **Production:** Use `redis` for scalability and persistence
3. **Testing:** Use `memory` or `file` storage for isolation
4. **Configuration:** Use environment variables for deployment flexibility
5. **Monitoring:** Check storage health and session counts regularly
6. **Security:** Ensure Redis/Database connections are encrypted in production

## Examples

See the following example files:
- `session-storage-examples.js` - Implementation examples for all storage types
- `config-based-storage.js` - Configuration-driven setup examples
- `test-session-storage.js` - Test suite for storage validation
- `verify-default-storage.js` - Verification that default setup works
