/**
 * Session Storage Examples
 * 
 * This file demonstrates how to implement and use external session storage
 * with the SessionManager. The storage is completely external to the SDK
 * and can be Redis, database, or any other storage mechanism.
 * 
 * Copyright (c) 2025 Discernible, Inc. All rights reserved.
 */

const { setStorage, InMemorySessionStorage } = require('../lib/auth/sessionmanager');

// Example 0: In-Memory Storage (Default)
// The InMemorySessionStorage is used by default - no configuration needed
// But you can also create additional instances for testing or isolation
function setupInMemoryStorage() {
  // This is optional - InMemorySessionStorage is already the default
  const memoryStorage = new InMemorySessionStorage();
  setStorage(memoryStorage);
  
  console.log('In-memory session storage configured (this is the default)');
  
  // You can access additional methods for debugging
  console.log('Storage info:', memoryStorage.getStorageInfo());
}

// Example 1: Redis Storage Implementation
class RedisSessionStorage {
  constructor(redisClient, keyPrefix = 'session:') {
    this.redis = redisClient;
    this.keyPrefix = keyPrefix;
  }

  async get(sessionId) {
    try {
      const data = await this.redis.get(`${this.keyPrefix}${sessionId}`);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Redis get error:', error);
      return null;
    }
  }

  async set(sessionId, session) {
    try {
      const ttl = session.expiresAt ? (session.expiresAt - Math.floor(Date.now() / 1000)) : null;
      const key = `${this.keyPrefix}${sessionId}`;
      
      if (ttl && ttl > 0) {
        await this.redis.setex(key, ttl, JSON.stringify(session));
      } else {
        await this.redis.set(key, JSON.stringify(session));
      }
      return true;
    } catch (error) {
      console.error('Redis set error:', error);
      return false;
    }
  }

  async delete(sessionId) {
    try {
      const result = await this.redis.del(`${this.keyPrefix}${sessionId}`);
      return result > 0;
    } catch (error) {
      console.error('Redis delete error:', error);
      return false;
    }
  }

  async keys() {
    try {
      const keys = await this.redis.keys(`${this.keyPrefix}*`);
      return keys.map(key => key.replace(this.keyPrefix, ''));
    } catch (error) {
      console.error('Redis keys error:', error);
      return [];
    }
  }

  async size() {
    try {
      const keys = await this.keys();
      return keys.length;
    } catch (error) {
      console.error('Redis size error:', error);
      return 0;
    }
  }

  async clear() {
    try {
      const keys = await this.redis.keys(`${this.keyPrefix}*`);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
      return true;
    } catch (error) {
      console.error('Redis clear error:', error);
      return false;
    }
  }
}

// Example 2: Database Storage Implementation (SQLite/PostgreSQL/MySQL)
class DatabaseSessionStorage {
  constructor(db, tableName = 'sessions') {
    this.db = db;
    this.tableName = tableName;
  }

  async get(sessionId) {
    try {
      const query = `SELECT session_data FROM ${this.tableName} WHERE session_id = ? AND (expires_at IS NULL OR expires_at > ?)`;
      const result = await this.db.get(query, [sessionId, Math.floor(Date.now() / 1000)]);
      return result ? JSON.parse(result.session_data) : null;
    } catch (error) {
      console.error('Database get error:', error);
      return null;
    }
  }

  async set(sessionId, session) {
    try {
      const query = `INSERT OR REPLACE INTO ${this.tableName} (session_id, session_data, expires_at, updated_at) VALUES (?, ?, ?, ?)`;
      await this.db.run(query, [
        sessionId,
        JSON.stringify(session),
        session.expiresAt,
        Math.floor(Date.now() / 1000)
      ]);
      return true;
    } catch (error) {
      console.error('Database set error:', error);
      return false;
    }
  }

  async delete(sessionId) {
    try {
      const query = `DELETE FROM ${this.tableName} WHERE session_id = ?`;
      const result = await this.db.run(query, [sessionId]);
      return result.changes > 0;
    } catch (error) {
      console.error('Database delete error:', error);
      return false;
    }
  }

  async keys() {
    try {
      const query = `SELECT session_id FROM ${this.tableName} WHERE expires_at IS NULL OR expires_at > ?`;
      const results = await this.db.all(query, [Math.floor(Date.now() / 1000)]);
      return results.map(row => row.session_id);
    } catch (error) {
      console.error('Database keys error:', error);
      return [];
    }
  }

  async size() {
    try {
      const query = `SELECT COUNT(*) as count FROM ${this.tableName} WHERE expires_at IS NULL OR expires_at > ?`;
      const result = await this.db.get(query, [Math.floor(Date.now() / 1000)]);
      return result.count;
    } catch (error) {
      console.error('Database size error:', error);
      return 0;
    }
  }

  async clear() {
    try {
      const query = `DELETE FROM ${this.tableName}`;
      await this.db.run(query);
      return true;
    } catch (error) {
      console.error('Database clear error:', error);
      return false;
    }
  }
}

// Example 3: File-based Storage Implementation
class FileSessionStorage {
  constructor(storageDir = './sessions') {
    this.storageDir = storageDir;
    const fs = require('fs');
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }
  }

  async get(sessionId) {
    try {
      const fs = require('fs').promises;
      const filePath = `${this.storageDir}/${sessionId}.json`;
      const data = await fs.readFile(filePath, 'utf8');
      const session = JSON.parse(data);
      
      // Check expiration
      if (session.expiresAt && session.expiresAt < Math.floor(Date.now() / 1000)) {
        await this.delete(sessionId);
        return null;
      }
      
      return session;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      console.error('File get error:', error);
      return null;
    }
  }

  async set(sessionId, session) {
    try {
      const fs = require('fs').promises;
      const filePath = `${this.storageDir}/${sessionId}.json`;
      await fs.writeFile(filePath, JSON.stringify(session, null, 2));
      return true;
    } catch (error) {
      console.error('File set error:', error);
      return false;
    }
  }

  async delete(sessionId) {
    try {
      const fs = require('fs').promises;
      const filePath = `${this.storageDir}/${sessionId}.json`;
      await fs.unlink(filePath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return true; // Already deleted
      console.error('File delete error:', error);
      return false;
    }
  }

  async keys() {
    try {
      const fs = require('fs').promises;
      const files = await fs.readdir(this.storageDir);
      return files
        .filter(file => file.endsWith('.json'))
        .map(file => file.replace('.json', ''));
    } catch (error) {
      console.error('File keys error:', error);
      return [];
    }
  }

  async size() {
    try {
      const keys = await this.keys();
      return keys.length;
    } catch (error) {
      console.error('File size error:', error);
      return 0;
    }
  }

  async clear() {
    try {
      const fs = require('fs').promises;
      const files = await fs.readdir(this.storageDir);
      const jsonFiles = files.filter(file => file.endsWith('.json'));
      
      for (const file of jsonFiles) {
        await fs.unlink(`${this.storageDir}/${file}`);
      }
      return true;
    } catch (error) {
      console.error('File clear error:', error);
      return false;
    }
  }
}

// Usage Examples:

// Example 1: Using Redis Storage
async function setupRedisStorage() {
  const redis = require('redis');
  const client = redis.createClient({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD
  });
  
  await client.connect();
  
  const redisStorage = new RedisSessionStorage(client, 'rodit:session:');
  setStorage(redisStorage);
  
  console.log('Redis session storage configured');
}

// Example 2: Using Database Storage
async function setupDatabaseStorage() {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  
  const db = await open({
    filename: process.env.SESSION_DB_PATH || './sessions.db',
    driver: sqlite3.Database
  });
  
  // Create sessions table if it doesn't exist
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      session_data TEXT NOT NULL,
      expires_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  `);
  
  const dbStorage = new DatabaseSessionStorage(db);
  setStorage(dbStorage);
  
  console.log('Database session storage configured');
}

// Example 3: Using File Storage
function setupFileStorage() {
  const fileStorage = new FileSessionStorage('./data/sessions');
  setStorage(fileStorage);
  
  console.log('File session storage configured');
}

// Example 4: Configuration via Environment Variables or Config
function setupStorageFromConfig() {
  // Use SDK config which supports both config files and environment variables
  const config = require('../services/configsdk');
  let storageType;
  
  try {
    storageType = config.get('SESSION_STORAGE_TYPE');
  } catch (error) {
    // Fallback to environment variable if config fails
    storageType = process.env.SESSION_STORAGE_TYPE || 'memory';
  }
  
  console.log(`Configuring session storage: ${storageType}`);
  
  switch (storageType.toLowerCase()) {
    case 'memory':
      setupInMemoryStorage();
      break;
    case 'redis':
      setupRedisStorage();
      break;
    case 'database':
    case 'db':
      setupDatabaseStorage();
      break;
    case 'file':
      setupFileStorage();
      break;
    default:
      console.log(`Unknown storage type '${storageType}', using default in-memory storage`);
      setupInMemoryStorage();
  }
}

module.exports = {
  InMemorySessionStorage,
  RedisSessionStorage,
  DatabaseSessionStorage,
  FileSessionStorage,
  setupInMemoryStorage,
  setupRedisStorage,
  setupDatabaseStorage,
  setupFileStorage,
  setupStorageFromConfig
};
