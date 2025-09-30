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
echo "⚠️  WARNING: This will DELETE and RECREATE the database"
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

# Remove existing database if present
if [ -f "${DB_PATH}" ]; then
    echo "🗑️  Removing existing database at ${DB_PATH}..."
    rm -f "${DB_PATH}"
    echo "✅ Existing database removed"
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

-- Sessions table will be auto-created by connect-sqlite3 on first use
-- Do not create it manually to avoid schema conflicts

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

-- Verify tables were created
SELECT 'Tables created:' as status;
.tables
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
    
    # Verify all tables were created
    echo ""
    echo "📋 Tables created:"
    sqlite3 "${DB_PATH}" ".tables" | tr '\t' '\n' | sed 's/^/  - /'
    
    # Test each table
    echo ""
    echo "🧪 Testing tables:"
    COMMENTS_COUNT=$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM comments;" 2>/dev/null || echo "ERROR")
    METRICS_COUNT=$(sqlite3 "${DB_PATH}" "SELECT COUNT(*) FROM metrics;" 2>/dev/null || echo "ERROR")
    
    echo "  - comments: ${COMMENTS_COUNT} rows"
    echo "  - sessions: (will be auto-created by connect-sqlite3)"
    echo "  - metrics: ${METRICS_COUNT} rows"
    
    if [ "$COMMENTS_COUNT" != "ERROR" ] && [ "$METRICS_COUNT" != "ERROR" ]; then
        echo ""
        echo "🎉 All tables verified and ready for use!"
        echo "💾 Sessions table will be created automatically on first use"
        echo "💾 Sessions will persist across server restarts"
    else
        echo "❌ One or more table tests failed"
        exit 1
    fi
else
    echo "❌ Database creation failed"
    exit 1
fi
