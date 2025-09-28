/**
 * Configuration-Based Session Storage Setup
 * 
 * This example shows how to configure session storage using environment variables
 * and configuration files, following the same pattern as other SDK configurations.
 * 
 * Copyright (c) 2025 Discernible, Inc. All rights reserved.
 */

const { configureStorageFromConfig, setStorage } = require('../lib/auth/sessionmanager');
const config = require('../services/configsdk');

// Example 1: Using configuration to determine storage type
function setupStorageFromConfiguration() {
  console.log('=== Configuration-Based Storage Setup ===');
  
  try {
    // Get the configured storage type
    const storageType = config.get('SESSION_STORAGE_TYPE');
    console.log(`Configured storage type: ${storageType}`);
    
    // Use the built-in configuration function
    configureStorageFromConfig();
    
    console.log('✓ Storage configuration applied');
    
  } catch (error) {
    console.error('✗ Configuration failed:', error.message);
  }
}

// Example 2: Manual setup based on environment
function setupStorageManually() {
  console.log('\n=== Manual Storage Setup Based on Environment ===');
  
  const storageType = process.env.SESSION_STORAGE_TYPE || 'memory';
  console.log(`Environment storage type: ${storageType}`);
  
  switch (storageType.toLowerCase()) {
    case 'memory':
      console.log('Using default in-memory storage (no setup required)');
      break;
      
    case 'redis':
      console.log('Setting up Redis storage...');
      setupRedisFromEnv();
      break;
      
    case 'database':
      console.log('Setting up database storage...');
      setupDatabaseFromEnv();
      break;
      
    case 'file':
      console.log('Setting up file storage...');
      setupFileFromEnv();
      break;
      
    default:
      console.log(`Unknown storage type '${storageType}', using memory`);
  }
}

// Redis setup from environment variables
function setupRedisFromEnv() {
  try {
    const redis = require('redis');
    const { RedisSessionStorage } = require('./session-storage-examples');
    
    const client = redis.createClient({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD,
      db: process.env.REDIS_DB || 0
    });
    
    client.connect().then(() => {
      const redisStorage = new RedisSessionStorage(client, 'rodit:session:');
      setStorage(redisStorage);
      console.log('✓ Redis storage configured');
    }).catch(error => {
      console.error('✗ Redis connection failed:', error.message);
      console.log('  Falling back to in-memory storage');
    });
    
  } catch (error) {
    console.error('✗ Redis setup failed:', error.message);
    console.log('  Make sure to install redis: npm install redis');
  }
}

// Database setup from environment variables
function setupDatabaseFromEnv() {
  try {
    const sqlite3 = require('sqlite3');
    const { open } = require('sqlite');
    const { DatabaseSessionStorage } = require('./session-storage-examples');
    
    const dbPath = process.env.SESSION_DB_PATH || './data/sessions.db';
    
    open({
      filename: dbPath,
      driver: sqlite3.Database
    }).then(async (db) => {
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
      
      const dbStorage = new DatabaseSessionStorage(db);
      setStorage(dbStorage);
      console.log(`✓ Database storage configured: ${dbPath}`);
    }).catch(error => {
      console.error('✗ Database setup failed:', error.message);
      console.log('  Falling back to in-memory storage');
    });
    
  } catch (error) {
    console.error('✗ Database setup failed:', error.message);
    console.log('  Make sure to install sqlite: npm install sqlite3 sqlite');
  }
}

// File storage setup from environment variables
function setupFileFromEnv() {
  try {
    const { FileSessionStorage } = require('./session-storage-examples');
    
    const storageDir = process.env.SESSION_FILE_DIR || './data/sessions';
    const fileStorage = new FileSessionStorage(storageDir);
    setStorage(fileStorage);
    console.log(`✓ File storage configured: ${storageDir}`);
    
  } catch (error) {
    console.error('✗ File storage setup failed:', error.message);
    console.log('  Falling back to in-memory storage');
  }
}

// Example 3: Application startup with automatic configuration
async function initializeApplication() {
  console.log('\n=== Application Initialization with Session Storage ===');
  
  try {
    // Step 1: Configure storage based on environment/config
    console.log('1. Configuring session storage...');
    setupStorageManually();
    
    // Step 2: Initialize RoditClient (it will use the configured storage)
    console.log('2. Initializing RoditClient...');
    const { RoditClient } = require('../index');
    const client = new RoditClient();
    
    // Step 3: Verify storage is working
    console.log('3. Verifying storage configuration...');
    const storageInfo = await client.getSessionStorageInfo();
    console.log('   Storage info:', JSON.stringify(storageInfo, null, 2));
    
    console.log('✓ Application initialized successfully');
    return client;
    
  } catch (error) {
    console.error('✗ Application initialization failed:', error.message);
    throw error;
  }
}

// Example 4: Configuration validation
function validateConfiguration() {
  console.log('\n=== Configuration Validation ===');
  
  try {
    // Check session storage configuration
    const storageType = config.get('SESSION_STORAGE_TYPE');
    const cleanupInterval = config.get('SESSION_CLEANUP_INTERVAL');
    const retentionPeriod = config.get('SESSION_TOKEN_RETENTION_PERIOD');
    
    console.log(`✓ SESSION_STORAGE_TYPE: ${storageType}`);
    console.log(`✓ SESSION_CLEANUP_INTERVAL: ${cleanupInterval}ms (${cleanupInterval / 1000 / 60} minutes)`);
    console.log(`✓ SESSION_TOKEN_RETENTION_PERIOD: ${retentionPeriod}s (${retentionPeriod / 86400} days)`);
    
    // Validate the storage type
    const validTypes = ['memory', 'redis', 'database', 'file'];
    if (!validTypes.includes(storageType.toLowerCase())) {
      console.warn(`⚠ Unknown storage type '${storageType}', valid types: ${validTypes.join(', ')}`);
    } else {
      console.log(`✓ Storage type '${storageType}' is valid`);
    }
    
    // Validate intervals
    if (cleanupInterval < 60000) { // Less than 1 minute
      console.warn(`⚠ Cleanup interval ${cleanupInterval}ms is very short, consider increasing`);
    }
    
    if (retentionPeriod < 3600) { // Less than 1 hour
      console.warn(`⚠ Token retention period ${retentionPeriod}s is very short, consider increasing`);
    }
    
    // Show configuration source
    console.log('\nConfiguration can be set via:');
    console.log('  • Environment variables:');
    console.log('    - SESSION_STORAGE_TYPE=memory');
    console.log('    - SESSION_CLEANUP_INTERVAL=3600000');
    console.log('    - SESSION_TOKEN_RETENTION_PERIOD=604800');
    console.log('  • Config file:');
    console.log('    - "SESSION_STORAGE_TYPE": "memory"');
    console.log('    - "SESSION_CLEANUP_INTERVAL": 3600000');
    console.log('    - "SESSION_TOKEN_RETENTION_PERIOD": 604800');
    
  } catch (error) {
    console.log(`ℹ Session configuration not found, using defaults`);
    console.log('  • SESSION_STORAGE_TYPE: memory');
    console.log('  • SESSION_CLEANUP_INTERVAL: 3600000ms (1 hour)');
    console.log('  • SESSION_TOKEN_RETENTION_PERIOD: 604800s (7 days)');
  }
}

// Run examples if this file is executed directly
if (require.main === module) {
  console.log('Session Storage Configuration Examples\n');
  
  validateConfiguration();
  setupStorageFromConfiguration();
  setupStorageManually();
  
  initializeApplication()
    .then(() => {
      console.log('\n🎉 All examples completed successfully!');
    })
    .catch(error => {
      console.error('\n💥 Examples failed:', error.message);
      process.exit(1);
    });
}

module.exports = {
  setupStorageFromConfiguration,
  setupStorageManually,
  setupRedisFromEnv,
  setupDatabaseFromEnv,
  setupFileFromEnv,
  initializeApplication,
  validateConfiguration
};
