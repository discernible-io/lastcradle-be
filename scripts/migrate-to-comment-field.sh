#!/usr/bin/env bash
# Database Migration Script for RODiT Authentication API
# This script migrates the existing 'content' column to 'comment' column

set -euo pipefail

# Configuration
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${PROJECT_ROOT}/data"
DB_PATH="${DATA_DIR}/database.sqlite"

echo "🔄 Migrating database schema from 'content' to 'comment' field..."

# Check if database exists
if [ ! -f "${DB_PATH}" ]; then
    echo "❌ Database file not found at ${DB_PATH}"
    echo "Run init-database.sh first to create the database"
    exit 1
fi

# Create backup
BACKUP_PATH="${DB_PATH}.backup.$(date +%Y%m%d_%H%M%S)"
cp "${DB_PATH}" "${BACKUP_PATH}"
echo "📋 Created backup at ${BACKUP_PATH}"

# Perform migration
echo "📝 Migrating comments table schema..."

sqlite3 "${DB_PATH}" <<EOF
-- Show current table structure
.echo on
PRAGMA table_info(comments);

-- Create new table with correct schema
CREATE TABLE comments_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment TEXT NOT NULL,
    author TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Copy data from old table to new table
-- Map 'content' field to 'comment' field
INSERT INTO comments_new (id, comment, author, created_at, updated_at)
SELECT id, content, author, created_at, updated_at FROM comments;

-- Drop old table
DROP TABLE comments;

-- Rename new table to original name
ALTER TABLE comments_new RENAME TO comments;

-- Show updated table structure
PRAGMA table_info(comments);

-- Show migrated data
SELECT COUNT(*) as total_comments FROM comments;
EOF

echo "✅ Database migration completed successfully!"
echo "🗄️  Database file: ${DB_PATH}"
echo "💾 Backup file: ${BACKUP_PATH}"
echo ""
echo "Summary of changes:"
echo "  - Renamed 'content' column to 'comment'"
echo "  - Preserved all existing data"
echo "  - Maintained table structure and constraints"
