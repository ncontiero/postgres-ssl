#!/bin/bash

# Exit as soon as any of these commands fail.
set -e

# ==============================================================================
# 1. CONFIGURE SHARED PRELOAD LIBRARIES
# Persists the PG_SHARED_PRELOAD_LIBRARIES environment variable into postgresql.conf.
# This ensures libraries are loaded on future restarts, even if the env var is not present.
# ==============================================================================
echo "Checking for shared_preload_libraries..."
if [ -n "$PG_SHARED_PRELOAD_LIBRARIES" ]; then
    # Checks if the setting already exists to avoid duplicates in the file.
    if ! grep -q "shared_preload_libraries = '$PG_SHARED_PRELOAD_LIBRARIES'" "$PGDATA/postgresql.conf"; then
        echo "Appending shared_preload_libraries to postgresql.conf..."
        echo "shared_preload_libraries = '$PG_SHARED_PRELOAD_LIBRARIES'" >> "$PGDATA/postgresql.conf"
    else
        echo "shared_preload_libraries already configured."
    fi
else
    echo "No PG_SHARED_PRELOAD_LIBRARIES defined. Skipping."
fi

# ==============================================================================
# 2. CREATE EXTENSIONS IN DATABASE
# Iterates through the comma-separated PG_DB_EXTENSIONS environment variable
# and creates each extension in the target database.
# ==============================================================================
echo "Checking for database extensions to enable..."
if [ -n "$PG_DB_EXTENSIONS" ]; then
    echo "$PG_DB_EXTENSIONS" | tr ',' '\n' | while read -r extension; do
        # Trim leading/trailing whitespace
        extension=$(echo "$extension" | xargs)
        if [ -n "$extension" ]; then
            echo "Enabling extension: '$extension'"
            psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "CREATE EXTENSION IF NOT EXISTS \"$extension\" CASCADE;"
        fi
    done
else
    echo "No PG_DB_EXTENSIONS defined. Skipping."
fi

echo "Extension initialization complete."
