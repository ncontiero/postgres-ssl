#!/bin/bash

# Exit as soon as any command fails to prevent starting a database in a bad state.
set -e

EXPECTED_VOLUME_MOUNT_PATH="/var/lib/postgresql/data"
EXPECTED_POSTGRES_MAJOR="17"
SSL_RENEWAL_DAYS=30
SSL_RENEWAL_SECONDS=$((SSL_RENEWAL_DAYS * 86400))

# ==============================================================================
# FUNCTION DEFINITIONS
# ==============================================================================

# Validates that the environment is set up correctly, specifically for Railway deployments.
# Checks for correct volume mount paths to prevent data loss.
validate_environment() {
  echo "Validating environment..."

  # Keep all path comparisons and derived paths consistent. PostgreSQL accepts
  # trailing slashes, but leaving them in PGDATA makes boundary checks and
  # operational tooling unnecessarily ambiguous.
  while [ "${PGDATA%/}" != "$PGDATA" ] && [ -n "${PGDATA%/}" ]; do
    PGDATA="${PGDATA%/}"
  done
  export PGDATA

  # Check if running on Railway and if the volume mount path is correct.
  if [ -n "$RAILWAY_ENVIRONMENT" ] && [ "$RAILWAY_VOLUME_MOUNT_PATH" != "$EXPECTED_VOLUME_MOUNT_PATH" ]; then
    echo "ERROR: Railway volume not mounted to the correct path." >&2
    echo "Expected: '$EXPECTED_VOLUME_MOUNT_PATH', but got: '$RAILWAY_VOLUME_MOUNT_PATH'." >&2
    echo "Please update the volume mount path and redeploy." >&2
    exit 1
  fi

  # Check a real directory boundary instead of a textual prefix, which would
  # incorrectly accept paths such as /var/lib/postgresql/data-invalid.
  case "$PGDATA" in
    "$EXPECTED_VOLUME_MOUNT_PATH"|"$EXPECTED_VOLUME_MOUNT_PATH"/*) ;;
    *)
      echo "ERROR: PGDATA is outside the expected volume mount path." >&2
      echo "Expected: '$EXPECTED_VOLUME_MOUNT_PATH' or one of its subdirectories, but PGDATA is: '$PGDATA'." >&2
      echo "Please update the PGDATA variable and redeploy." >&2
      exit 1
      ;;
  esac
}

# Refuses to start an image against files created by another PostgreSQL major.
# Changing an image tag does not perform a major-version data upgrade.
validate_data_version() {
  local version_file="$PGDATA/PG_VERSION"
  local data_major

  [ -f "$version_file" ] || return 0
  data_major=$(tr -d '[:space:]' < "$version_file")

  if [ "$data_major" != "$EXPECTED_POSTGRES_MAJOR" ]; then
    echo "ERROR: PostgreSQL major version mismatch." >&2
    echo "This image runs PostgreSQL $EXPECTED_POSTGRES_MAJOR, but PGDATA contains version '${data_major:-unknown}'." >&2
    echo "Changing the image tag does not upgrade the database files. Restore the previous image or run a major-version upgrade." >&2
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

certificate_has_required_sans() {
  local cert_file=$1
  local dns_name
  local certificate_sans

  if ! certificate_sans=$(openssl x509 -noout -ext subjectAltName -in "$cert_file" 2>/dev/null); then
    return 1
  fi

  for dns_name in localhost "${RAILWAY_PRIVATE_DOMAIN:-}" "${RAILWAY_TCP_PROXY_DOMAIN:-}"; do
    if [ -n "$dns_name" ] \
      && ! printf '%s\n' "$certificate_sans" \
        | tr ',' '\n' \
        | sed 's/^[[:space:]]*//' \
        | grep -Fqx "DNS:$dns_name"; then
      return 1
    fi
  done

  return 0
}

certificate_matches_private_key() {
  local certificate=$1
  local private_key=$2
  local certificate_public_key
  local private_public_key

  certificate_public_key=$(openssl x509 -pubkey -noout -in "$certificate" 2>/dev/null) || return 1
  private_public_key=$(openssl pkey -pubout -in "$private_key" 2>/dev/null) || return 1

  [ "$certificate_public_key" = "$private_public_key" ]
}

certificate_material_is_valid() {
  local ssl_dir=$1
  local root_crt="$ssl_dir/root.crt"
  local root_key="$ssl_dir/root.key"
  local server_crt="$ssl_dir/server.crt"
  local server_key="$ssl_dir/server.key"

  [ -s "$root_crt" ] \
    && [ -s "$root_key" ] \
    && [ -s "$server_crt" ] \
    && [ -s "$server_key" ] \
    && openssl x509 -noout -ext basicConstraints -in "$root_crt" 2>/dev/null | grep -q "CA:TRUE" \
    && openssl x509 -noout -ext basicConstraints -in "$server_crt" 2>/dev/null | grep -q "CA:FALSE" \
    && openssl verify -CAfile "$root_crt" "$root_crt" > /dev/null 2>&1 \
    && openssl verify -purpose sslserver -CAfile "$root_crt" "$server_crt" > /dev/null 2>&1 \
    && certificate_matches_private_key "$root_crt" "$root_key" \
    && certificate_matches_private_key "$server_crt" "$server_key"
}

# Checks the status of SSL certificates and regenerates them if necessary.
check_and_regenerate_certs() {
  echo "Checking SSL certificate status..."
  local ssl_dir="$PGDATA/certs"
  local cert_file="$ssl_dir/server.crt"
  local conf_file="$PGDATA/postgresql.conf"
  local init_script="/docker-entrypoint-initdb.d/init-ssl.sh"

  # Case 1: An initialized database has incomplete, mismatched, or invalid
  # certificate material.
  if [ -f "$conf_file" ] && ! certificate_material_is_valid "$ssl_dir"; then
    echo "WARNING: Invalid SSL certificate material was found. Regenerating certificates..."
    bash "$init_script"
    return
  fi

  # Case 2: Certificate exists but does not cover all required hostnames.
  if [ -f "$cert_file" ] && ! certificate_has_required_sans "$cert_file"; then
    echo "WARNING: The certificate does not contain all required SANs. Regenerating certificates..."
    bash "$init_script"
    return
  fi

  # Case 3: Server certificate exists but is expired or will expire within the
  # configured renewal window.
  if [ -f "$cert_file" ] && ! openssl x509 -checkend "$SSL_RENEWAL_SECONDS" -noout -in "$cert_file"; then
    echo "WARNING: Certificate has expired or will expire soon. Regenerating certificates..."
    bash "$init_script"
    return
  fi

  # Case 4: CA certificate is expired or will expire within the renewal window.
  # init-ssl.sh rotates a CA close to expiry and otherwise preserves it.
  if [ -f "$ssl_dir/root.crt" ] && ! openssl x509 -checkend "$SSL_RENEWAL_SECONDS" -noout -in "$ssl_dir/root.crt"; then
    echo "WARNING: Certificate Authority has expired or will expire soon. Regenerating certificates..."
    bash "$init_script"
    return
  fi

  echo "SSL certificate check passed."
}

# ==============================================================================
# MAIN EXECUTION
# ==============================================================================

validate_environment
validate_data_version

# The official entrypoint also treats arguments beginning with '-' as options
# for the postgres server. Administrative commands such as bash or psql do not
# need to hold the runtime lock.
case "${1:-}" in
  postgres|-*) acquire_runtime_lock ;;
esac

bash /usr/local/bin/configure-ssl-access.sh "$PGDATA/pg_hba.conf"
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
