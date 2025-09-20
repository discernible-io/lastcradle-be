#!/usr/bin/env bash
# Database Initialization Script for RODiT Authentication API
# This script ensures that the required directory structure exists
# and initializes the SQLite database for the API server.

set -euo pipefail

# Configuration
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${PROJECT_ROOT}/data"
LOGS_DIR="${PROJECT_ROOT}/logs"
DB_PATH="${DATA_DIR}/database.sqlite"

# Create directories if they don't exist
mkdir -p "${DATA_DIR}" "${LOGS_DIR}"
echo "✓ Created directories: ${DATA_DIR}, ${LOGS_DIR}"

# Initialize SQLite database with basic structure
echo "🚀 Initializing SQLite database at ${DB_PATH}..."

# Create the database and tables using sqlite3 command
sqlite3 "${DB_PATH}" <<EOF
-- Comments table for CRUDA operations
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment TEXT NOT NULL,
    author TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sessions table for session management
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    data TEXT,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Metrics table for performance tracking
CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT,
    method TEXT,
    response_time INTEGER,
    status_code INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Verify tables were created
.tables
EOF

echo "✓ Database initialization completed successfully!"
echo "📁 Data directory: ${DATA_DIR}"
echo "📁 Logs directory: ${LOGS_DIR}"
echo "🗄️  Database file: ${DB_PATH}"

# Set proper permissions
chmod 644 "${DB_PATH}"
echo "✓ Set database permissions"
