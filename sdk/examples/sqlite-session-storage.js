/**
 * Example: Using SQLite Session Storage with RODiT SDK
 * 
 * This example demonstrates how to configure persistent SQLite session storage
 * using the existing express-session interface pattern.
 */

const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const { RoditClient, setExpressSessionStore } = require('@rodit/rodit-auth-be');
const config = require('config');

async function setupWithSQLiteSessions() {
  const app = express();
  
  // ============================================================================
  // STEP 1: Configure SQLite Session Store
  // ============================================================================
  
  // Get database path from configuration
  const dbPath = config.get('API_DEFAULT_OPTIONS.DB_PATH', '/app/data/database.sqlite');
  
  // Create SQLite store for sessions
  // The store will create a 'sessions' table in the database
  const sqliteStore = new SQLiteStore({
    db: 'sessions.db',        // Database file name (can be same as main DB)
    dir: './data',            // Directory to store the database
    table: 'sessions',        // Table name for sessions
    // Alternatively, use the same database file:
    // db: dbPath.split('/').pop(),
    // dir: dbPath.substring(0, dbPath.lastIndexOf('/')),
  });
  
  // ============================================================================
  // STEP 2: Inject Store into SDK's Session Manager
  // ============================================================================
  
  // This must be done BEFORE creating the RoditClient instance
  setExpressSessionStore(sqliteStore);
  
  console.log('✅ SQLite session store configured');
  console.log(`   Database: ${dbPath}`);
  console.log(`   Table: sessions`);
  
  // ============================================================================
  // STEP 3: Initialize RoditClient (will now use SQLite for sessions)
  // ============================================================================
  
  const roditClient = await RoditClient.create('portal');
  app.locals.roditClient = roditClient;
  
  console.log('✅ RoditClient initialized with SQLite sessions');
  
  // ============================================================================
  // STEP 4: Configure Express Middleware
  // ============================================================================
  
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  
  // ============================================================================
  // STEP 5: Setup Routes
  // ============================================================================
  
  // Login endpoint (creates a session stored in SQLite)
  app.post('/api/login', (req, res) => {
    return roditClient.login_client(req, res);
  });
  
  // Protected endpoint (validates session from SQLite)
  app.get('/api/protected', 
    (req, res, next) => roditClient.authenticate(req, res, next),
    (req, res) => {
      res.json({
        message: 'Access granted',
        user: req.user,
        session: req.session
      });
    }
  );
  
  // Logout endpoint (invalidates session in SQLite)
  app.post('/api/logout',
    (req, res, next) => roditClient.authenticate(req, res, next),
    (req, res) => {
      return roditClient.logout_client(req, res);
    }
  );
  
  // Session info endpoint (for debugging)
  app.get('/api/session/info', async (req, res) => {
    const sessionManager = roditClient.getSessionManager();
    const activeCount = await sessionManager.getActiveSessionCount();
    
    res.json({
      activeSessionCount: activeCount,
      storage: 'SQLite (connect-sqlite3)',
      persistent: true
    });
  });
  
  // ============================================================================
  // STEP 6: Start Server
  // ============================================================================
  
  const port = config.get('SERVERPORT', 3000);
  app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`📊 Session storage: SQLite (persistent)`);
    console.log(`💾 Sessions will survive server restarts`);
  });
  
  return app;
}

// ============================================================================
// Alternative: Using the Same Database File
// ============================================================================

async function setupWithSharedDatabase() {
  const app = express();
  
  // Use the same database file that stores comments, metrics, etc.
  const dbPath = config.get('API_DEFAULT_OPTIONS.DB_PATH', '/app/data/database.sqlite');
  const dbDir = dbPath.substring(0, dbPath.lastIndexOf('/'));
  const dbFile = dbPath.split('/').pop();
  
  const sqliteStore = new SQLiteStore({
    db: dbFile,              // Use the same database file
    dir: dbDir,              // Same directory
    table: 'sessions',       // Sessions table (created by init-database.sh)
  });
  
  setExpressSessionStore(sqliteStore);
  
  const roditClient = await RoditClient.create('portal');
  app.locals.roditClient = roditClient;
  
  console.log('✅ Using shared database for sessions');
  console.log(`   Database: ${dbPath}`);
  console.log(`   Tables: comments, sessions, metrics`);
  
  // ... rest of setup
  
  return app;
}

// ============================================================================
// Graceful Shutdown (Important for SQLite)
// ============================================================================

function setupGracefulShutdown(server, store) {
  const shutdown = async (signal) => {
    console.log(`\n⚠️  ${signal} received, closing gracefully...`);
    
    // Close HTTP server
    server.close(() => {
      console.log('✅ HTTP server closed');
    });
    
    // Close SQLite store connection if available
    if (store && typeof store.close === 'function') {
      await store.close();
      console.log('✅ SQLite session store closed');
    }
    
    process.exit(0);
  };
  
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// ============================================================================
// Export
// ============================================================================

module.exports = {
  setupWithSQLiteSessions,
  setupWithSharedDatabase,
  setupGracefulShutdown
};

// ============================================================================
// Usage
// ============================================================================

if (require.main === module) {
  setupWithSQLiteSessions().catch(error => {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  });
}
