#!/bin/bash
# This script fixes the SQLite database access issue

# Find out where the application expects to find the database
echo "Looking for any clues about database location in source code..."
grep -r "sqlite" --include="*.js" ~/servertestapi-rodit/

# Create database directory structure and initialize SQLite database file
echo "Creating and initializing SQLite database file with proper permissions..."
mkdir -p ~/servertestapi-app/data
touch ~/servertestapi-app/data/rodit.db

# Initialize the database with a schema (basic SQLite DB structure)
echo "Initializing database schema..."
cat > /tmp/init.sql << 'EOF'
-- Basic schema initialization
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Insert some default configuration
INSERT OR IGNORE INTO app_config (key, value) VALUES ('initialized', 'true');
EOF

# Use sqlite3 to initialize the database
sqlite3 ~/servertestapi-app/data/rodit.db < /tmp/init.sql

# Make sure permissions are correct (owner and group can read/write)
echo "Setting appropriate permissions..."
chmod 666 ~/servertestapi-app/data/rodit.db
chmod 777 ~/servertestapi-app/data

# Restart the container
echo "Restarting container..."
podman restart servertestapi-container

# Check logs after restart
echo "Container logs after restart:"
sleep 5
podman logs servertestapi-container
