#!/usr/bin/env bash
# Database Migration Script: content -> comment field
# This script migrates the comments table schema from 'content' to 'comment' field
# while preserving ownership and permissions for deployment

set -euo pipefail

# Configuration
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIRS=("${PROJECT_ROOT}/data" "${PROJECT_ROOT}/../servertest-app/data")

echo "🔄 Starting database schema migration: content -> comment field"
echo "📍 Project root: ${PROJECT_ROOT}"

# Function to migrate a single database
migrate_database() {
    local db_path="$1"
    local data_dir="$(dirname "$db_path")"
    
    echo "🗄️  Migrating database: $db_path"
    
    # Check if database exists (with sudo)
    if ! sudo test -f "$db_path"; then
        echo "⚠️  Database not found: $db_path"
        return 0
    fi
    
    # Get current ownership and permissions
    local db_owner=$(sudo stat -c '%u:%g' "$db_path")
    local db_perms=$(sudo stat -c '%a' "$db_path")
    local dir_owner=$(sudo stat -c '%u:%g' "$data_dir")
    local dir_perms=$(sudo stat -c '%a' "$data_dir")
    
    echo "📊 Current ownership and permissions:"
    echo "  - Database: $db_owner ($db_perms)"
    echo "  - Directory: $dir_owner ($dir_perms)"
    
    # Check current schema
    local has_content_field=$(sudo sqlite3 "$db_path" "PRAGMA table_info(comments);" | grep -c "content" || echo "0")
    local has_comment_field=$(sudo sqlite3 "$db_path" "PRAGMA table_info(comments);" | grep -c "comment" || echo "0")
    
    if [ "$has_comment_field" -gt "0" ]; then
        echo "✅ Database already has correct schema (comment field exists)"
        return 0
    fi
    
    if [ "$has_content_field" -eq "0" ]; then
        echo "⚠️  Database has no content or comment field - may need initialization"
        return 0
    fi
    
    # Create backup
    local backup_path="${db_path}.backup.$(date +%Y%m%d_%H%M%S)"
    echo "💾 Creating backup: $backup_path"
    sudo cp "$db_path" "$backup_path"
    sudo chown "$db_owner" "$backup_path"
    sudo chmod "$db_perms" "$backup_path"
    
    # Get existing data
    local data_count=$(sudo sqlite3 "$db_path" "SELECT COUNT(*) FROM comments;" 2>/dev/null || echo "0")
    echo "📊 Found $data_count existing records"
    
    # Perform migration using SQLite's ALTER TABLE
    echo "🔄 Performing schema migration..."
    
    # SQLite doesn't support renaming columns directly, so we need to:
    # 1. Create new table with correct schema
    # 2. Copy data from old table
    # 3. Drop old table
    # 4. Rename new table
    
    sudo sqlite3 "$db_path" <<EOF
-- Create new table with correct schema
CREATE TABLE comments_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment TEXT NOT NULL,
    author TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Copy data from old table (content -> comment)
INSERT INTO comments_new (id, comment, author, created_at, updated_at)
SELECT id, content, author, created_at, updated_at FROM comments;

-- Drop old table
DROP TABLE comments;

-- Rename new table
ALTER TABLE comments_new RENAME TO comments;

-- Verify the migration
.echo on
PRAGMA table_info(comments);
SELECT COUNT(*) as migrated_records FROM comments;
EOF
    
    # Restore ownership and permissions
    echo "🔐 Restoring ownership and permissions..."
    sudo chown "$db_owner" "$db_path"
    sudo chmod "$db_perms" "$db_path"
    sudo chown "$dir_owner" "$data_dir"
    sudo chmod "$dir_perms" "$data_dir"
    
    # Verify migration
    local new_comment_field=$(sudo sqlite3 "$db_path" "PRAGMA table_info(comments);" | grep -c "comment" || echo "0")
    local migrated_count=$(sudo sqlite3 "$db_path" "SELECT COUNT(*) FROM comments;" 2>/dev/null || echo "0")
    
    if [ "$new_comment_field" -gt "0" ] && [ "$migrated_count" -eq "$data_count" ]; then
        echo "✅ Migration successful!"
        echo "  - Schema updated: content -> comment"
        echo "  - Records migrated: $migrated_count"
        echo "  - Ownership preserved: $db_owner"
        echo "  - Permissions preserved: $db_perms"
    else
        echo "❌ Migration failed - restoring backup"
        sudo cp "$backup_path" "$db_path"
        sudo chown "$db_owner" "$db_path"
        sudo chmod "$db_perms" "$db_path"
        exit 1
    fi
}

# Migrate all database locations
for data_dir in "${DATA_DIRS[@]}"; do
    if [ -d "$data_dir" ]; then
        echo "📁 Processing directory: $data_dir"
        migrate_database "$data_dir/database.sqlite"
    else
        echo "⚠️  Directory not found: $data_dir"
    fi
done

echo "🎉 Database migration completed successfully!"
echo "💡 Backups created with timestamp for rollback if needed"
