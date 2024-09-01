#!/bin/bash

sqlite3 /app/data/database.sqlite <<EOF
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;
$(sqlite3 /app/data/database.sqlite "SELECT 'DELETE FROM ' || name || ';' FROM sqlite_master WHERE type = 'table' AND name NOT IN ('sqlite_sequence', 'sqlite_master');")
COMMIT;
PRAGMA foreign_keys = ON;
VACUUM;
EOF

echo "All tables have been cleared."
