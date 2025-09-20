#!/usr/bin/env bash
# Database Initialization Script for RODiT Authentication API
# This script ensures that the required directory structure exists
# and initializes the SQLite database for the API server.

set -euo pipefail

# Configuration
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${PROJECT_ROOT}/data"
LOGS_DIR="${PROJECT_ROOT}/logs"
NGINX_LOGS_DIR="${LOGS_DIR}/nginx"
DB_PATH="${DATA_DIR}/database.sqlite"

echo "🚀 Starting database initialization for servertest-rodit..."
echo "📍 Project root: ${PROJECT_ROOT}"

# Create directories with proper permissions
echo "📁 Creating directory structure..."
mkdir -p "${DATA_DIR}" "${LOGS_DIR}" "${NGINX_LOGS_DIR}"

# Set directory permissions to be writable by container users (may fail due to ownership)
chmod 755 "${DATA_DIR}" "${LOGS_DIR}" 2>/dev/null || echo "⚠️  Could not set directory permissions (may be owned by container user)"
chmod 775 "${NGINX_LOGS_DIR}" 2>/dev/null || echo "⚠️  Could not set nginx log permissions (may be owned by container user)"

echo "✓ Created directories:"
echo "  - Data: ${DATA_DIR}"
echo "  - Logs: ${LOGS_DIR}"
echo "  - Nginx logs: ${NGINX_LOGS_DIR}"

# Check if we can access the data directory
if [ ! -r "${DATA_DIR}" ]; then
    echo "⚠️  Cannot read data directory ${DATA_DIR} (likely owned by container user)"
    echo "💡 This is normal for deployed systems where containers own the data directory"
    echo "🚀 Assuming database exists and is managed by the container application"
    echo "✅ Database initialization check completed"
    exit 0
fi

# Check if database already exists
if [ -f "${DB_PATH}" ]; then
    echo "⚠️  Database already exists at ${DB_PATH}"
    echo "🔍 Checking database accessibility and schema..."
    
    # Check if we can access the database
    if ! sqlite3 "${DB_PATH}" "SELECT 1;" >/dev/null 2>&1; then
        echo "❌ Cannot access existing database (permission denied)"
        echo "💡 Database is likely owned by container user - this is normal for deployed systems"
        echo "🚀 The database exists and will be used by the container application"
        echo "✅ Database initialization check completed"
        exit 0
    fi
    
    # Verify the schema is correct
    SCHEMA_CHECK=$(sqlite3 "${DB_PATH}" "PRAGMA table_info(comments);" | grep -c "comment" || echo "0")
    if [ "$SCHEMA_CHECK" -eq "0" ]; then
        echo "❌ Database has incorrect schema (missing 'comment' field)"
        echo "🔄 Database needs to be recreated with correct schema"
        echo "⚠️  Manual intervention required - database is owned by container user"
        exit 1
    else
        echo "✅ Database schema is correct"
        # Show some database stats if accessible
        COMMENT_COUNT=$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM comments;" 2>/dev/null || echo "unknown")
        echo "📊 Comments in database: ${COMMENT_COUNT}"
        echo "🎉 Database is ready for use!"
        exit 0
    fi
fi

# Initialize SQLite database with standardized schema
echo "🗄️  Initializing SQLite database at ${DB_PATH}..."

# Create the database and tables using sqlite3 command
sqlite3 "${DB_PATH}" <<EOF
-- Comments table for CRUDA operations (using standardized 'comment' field)
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

-- Insert a test comment to verify schema
INSERT INTO comments (comment, author) VALUES ('Database initialized successfully', 'system');

-- Verify tables and schema
.echo on
.tables
PRAGMA table_info(comments);
SELECT COUNT(*) as total_comments FROM comments;
EOF

# Set proper permissions for database file
chmod 664 "${DB_PATH}"  # Read/write for owner and group
echo "✓ Set database file permissions (664)"

# Verify database was created successfully
if [ -f "${DB_PATH}" ] && [ -s "${DB_PATH}" ]; then
    DB_SIZE=$(stat -c%s "${DB_PATH}")
    echo "✅ Database initialization completed successfully!"
    echo "📊 Database details:"
    echo "  - File: ${DB_PATH}"
    echo "  - Size: ${DB_SIZE} bytes"
    echo "  - Permissions: $(stat -c%A "${DB_PATH}")"
    
    # Test database connectivity
    TEST_RESULT=$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM comments;" 2>/dev/null || echo "ERROR")
    if [ "$TEST_RESULT" != "ERROR" ]; then
        echo "  - Test query result: ${TEST_RESULT} comments"
        echo "🎉 Database is ready for use!"
    else
        echo "❌ Database test query failed"
        exit 1
    fi
else
    echo "❌ Database creation failed"
    exit 1
fi
