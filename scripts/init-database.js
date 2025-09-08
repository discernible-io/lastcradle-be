#!/usr/bin/env node

/**
 * Database Initialization Script for RODiT Authentication API
 * 
 * This script ensures that the required directory structure exists
 * and initializes the SQLite database for the API server.
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Configuration
const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');
const DB_PATH = path.join(DATA_DIR, 'database.sqlite');

/**
 * Create directory if it doesn't exist
 */
function ensureDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(`✓ Created directory: ${dirPath}`);
    } else {
        console.log(`✓ Directory exists: ${dirPath}`);
    }
}

/**
 * Initialize SQLite database with basic structure
 */
function initializeDatabase() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                reject(err);
                return;
            }
            
            console.log(`✓ Connected to SQLite database: ${DB_PATH}`);
            
            // Create basic tables that might be needed by the CRUDA module
            db.serialize(() => {
                // Comments table for CRUDA operations
                db.run(`CREATE TABLE IF NOT EXISTS comments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL,
                    author TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`, (err) => {
                    if (err) {
                        console.error('Error creating comments table:', err);
                        reject(err);
                        return;
                    }
                    console.log('✓ Comments table ready');
                });
                
                // Sessions table for session management
                db.run(`CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    user_id TEXT,
                    data TEXT,
                    expires_at DATETIME,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`, (err) => {
                    if (err) {
                        console.error('Error creating sessions table:', err);
                        reject(err);
                        return;
                    }
                    console.log('✓ Sessions table ready');
                });
                
                // Metrics table for performance tracking
                db.run(`CREATE TABLE IF NOT EXISTS metrics (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    endpoint TEXT,
                    method TEXT,
                    response_time INTEGER,
                    status_code INTEGER,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                )`, (err) => {
                    if (err) {
                        console.error('Error creating metrics table:', err);
                        reject(err);
                        return;
                    }
                    console.log('✓ Metrics table ready');
                });
            });
            
            db.close((err) => {
                if (err) {
                    reject(err);
                    return;
                }
                console.log('✓ Database initialization completed');
                resolve();
            });
        });
    });
}

/**
 * Main initialization function
 */
async function main() {
    try {
        console.log('🚀 Starting database initialization...\n');
        
        // Ensure required directories exist
        ensureDirectory(DATA_DIR);
        ensureDirectory(LOGS_DIR);
        
        // Initialize database
        await initializeDatabase();
        
        console.log('\n✅ Database initialization completed successfully!');
        console.log(`📁 Data directory: ${DATA_DIR}`);
        console.log(`📁 Logs directory: ${LOGS_DIR}`);
        console.log(`🗄️  Database file: ${DB_PATH}`);
        
    } catch (error) {
        console.error('\n❌ Database initialization failed:', error);
        process.exit(1);
    }
}

// Run the initialization
if (require.main === module) {
    main();
}

module.exports = { main, ensureDirectory, initializeDatabase };
