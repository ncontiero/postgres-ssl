#!/bin/bash

# Exit as soon as any command fails to prevent starting a database in a bad state.
set -e

EXPECTED_VOLUME_MOUNT_PATH="/var/lib/postgresql{{ '/data' if dkcutter._postgresMajorVersion < 18 }}"

# ==============================================================================
# FUNCTION DEFINITIONS
# ==============================================================================

# Validates that the environment is set up correctly, specifically for Railway deployments.
# Checks for correct volume mount paths to prevent data loss.
validate_environment() {
  echo "Validating environment..."

  # Check if running on Railway and if the volume mount path is correct.
  if [ -n "$RAILWAY_ENVIRONMENT" ] && [ "$RAILWAY_VOLUME_MOUNT_PATH" != "$EXPECTED_VOLUME_MOUNT_PATH" ]; then
    echo "ERROR: Railway volume not mounted to the correct path." >&2
    echo "Expected: '$EXPECTED_VOLUME_MOUNT_PATH', but got: '$RAILWAY_VOLUME_MOUNT_PATH'." >&2
    echo "Please update the volume mount path and redeploy." >&2
    exit 1
  fi

  # Check if PGDATA is located within the expected volume mount path.
  if [[ ! "$PGDATA" =~ ^"$EXPECTED_VOLUME_MOUNT_PATH" ]]; then
    echo "ERROR: PGDATA does not start with the expected volume mount path." >&2
    echo "Expected to start with: '$EXPECTED_VOLUME_MOUNT_PATH', but PGDATA is: '$PGDATA'." >&2
    echo "Please update the PGDATA variable and redeploy." >&2
    exit 1
  fi
}

# Prevents two Postgres processes from using the same persistent volume during
# an overlapping Railway deployment. Locking the mounted directory itself does
# not create a file inside an empty PGDATA, which would make the official
# entrypoint skip initdb on PostgreSQL 17 and older.
acquire_runtime_lock() {
  local lock_wait_seconds="${RUNTIME_LOCK_WAIT_SECONDS:-300}"

  case "$lock_wait_seconds" in
    ''|*[!0-9]*)
      echo "WARNING: RUNTIME_LOCK_WAIT_SECONDS must be a whole number; using 300." >&2
      lock_wait_seconds=300
      ;;
  esac

  if ! command -v flock >/dev/null 2>&1; then
    echo "ERROR: flock is required to protect the Postgres volume." >&2
    exit 1
  fi

  # File descriptor 9 remains open across exec, keeping the lock for the
  # lifetime of docker-entrypoint.sh and the Postgres process it starts.
  if ! exec 9<"$EXPECTED_VOLUME_MOUNT_PATH"; then
    echo "ERROR: Unable to open the volume mount path '$EXPECTED_VOLUME_MOUNT_PATH' for locking." >&2
    exit 1
  fi

  if flock -n -x 9; then
    echo "Acquired exclusive lock for Postgres volume '$EXPECTED_VOLUME_MOUNT_PATH'."
    return
  fi

  echo "Another Postgres container is still using the volume; waiting up to ${lock_wait_seconds}s..."
  if ! flock -w "$lock_wait_seconds" -x 9; then
    echo "ERROR: The previous Postgres container did not release the volume within ${lock_wait_seconds}s." >&2
    echo "Refusing to start another Postgres process on the same volume." >&2
    exit 1
  fi

  echo "The previous container released the volume; continuing startup."
}

# Checks the status of SSL certificates and regenerates them if necessary.
check_and_regenerate_certs() {
  echo "Checking SSL certificate status..."
  local ssl_dir="$PGDATA/certs"
  local cert_file="$ssl_dir/server.crt"
  local conf_file="$PGDATA/postgresql.conf"
  local init_script="/docker-entrypoint-initdb.d/init-ssl.sh"

  # Case 1: Certificate exists but is not a valid v3 certificate (e.g., missing SAN).
  if [ -f "$cert_file" ] && ! openssl x509 -noout -text -in "$cert_file" | grep -q "DNS:localhost"; then
    echo "WARNING: A valid x509v3 certificate was not found. Regenerating certificates..."
    bash "$init_script"
    return
  fi

  # Case 2: Certificate exists but is expired or will expire within 30 days (2592000 seconds).
  if [ -f "$cert_file" ] && ! openssl x509 -checkend 2592000 -noout -in "$cert_file"; then
    echo "WARNING: Certificate has expired or will expire soon. Regenerating certificates..."
    bash "$init_script"
    return
  fi

  # Case 3: Database is initialized but the certificate is missing.
  if [ -f "$conf_file" ] && [ ! -f "$cert_file" ]; then
    echo "WARNING: Database is initialized but certificate is missing. Generating certificates..."
    bash "$init_script"
    return
  fi

  echo "SSL certificate check passed."
}

# ==============================================================================
# MAIN EXECUTION
# ==============================================================================

validate_environment

# The official entrypoint also treats arguments beginning with '-' as options
# for the postgres server. Administrative commands such as bash or psql do not
# need to hold the runtime lock.
case "${1:-}" in
  postgres|-*) acquire_runtime_lock ;;
esac

check_and_regenerate_certs

# Unset Railway-specific environment variables that can interfere with psql/postgres.
# - PGHOST/PGPORT are used by Railway for proxying but can prevent local tools
#   from using the Unix socket correctly during initialization.
echo "Unsetting Railway-specific proxy variables for initialization..."
unset PGHOST
unset PGPORT

# Prepares the final 'postgres' command by injecting shared_preload_libraries if defined.
if [ "$1" = 'postgres' ] && [ -n "$PG_SHARED_PRELOAD_LIBRARIES" ]; then
  echo "Injecting shared_preload_libraries into startup command..."
  # 'shift' removes 'postgres' from the arguments.
  shift
  # 'set --' rebuilds the argument list with our injected config.
  set -- "postgres" "-c" "shared_preload_libraries=${PG_SHARED_PRELOAD_LIBRARIES}" "$@"
fi

# Execute the official postgres entrypoint script with the (potentially modified) arguments.
# Using 'exec' replaces the shell process with the postgres process, ensuring that
# the database becomes PID 1 and receives signals correctly.
echo "Executing main postgres entrypoint: /usr/local/bin/docker-entrypoint.sh $@"
if [[ "$LOG_TO_STDOUT" == "true" ]]; then
  exec /usr/local/bin/docker-entrypoint.sh "$@" 2>&1
else
  exec /usr/local/bin/docker-entrypoint.sh "$@"
fi
