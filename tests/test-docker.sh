#!/bin/bash

# Calling this file with `sh` overrides its Bash shebang. Re-execute it with
# Bash before the interpreter reaches Bash-specific syntax used below.
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -e

# Usage: ./tests/test-docker.sh <postgres-version>
POSTGRES_VERSION=$1

if [ -z "$POSTGRES_VERSION" ]; then
  echo "Error: POSTGRES_VERSION is not specified."
  echo "Usage: bash ./tests/test-docker.sh <postgres-version>"
  exit 1
fi

IMAGE_NAME="postgres-test:${POSTGRES_VERSION}"
CONTAINER_NAME="pg-test-${POSTGRES_VERSION}"
CONTENDER_NAME="pg-test-${POSTGRES_VERSION}-contender"
NEXT_CONTAINER_NAME="pg-test-${POSTGRES_VERSION}-next"
VOLUME_NAME="pg-test-${POSTGRES_VERSION}-data"
MISMATCH_VOLUME_NAME="pg-test-${POSTGRES_VERSION}-mismatch"
PRIVATE_DOMAIN="postgres.railway.internal"
PUBLIC_DOMAIN="postgres-test.proxy.rlwy.net"

MAJOR_VERSION=$(echo "$POSTGRES_VERSION" | cut -d. -f1)

if [ "$MAJOR_VERSION" -lt 18 ]; then
  MOUNT_PATH="/var/lib/postgresql/data"
  DATA_PATH="$MOUNT_PATH"
else
  MOUNT_PATH="/var/lib/postgresql"
  DATA_PATH="${MOUNT_PATH}/${MAJOR_VERSION}/docker"
fi
CERTS_DIR="${DATA_PATH}/certs"

if ! docker info > /dev/null 2>&1; then
  echo "ERROR: Docker is not running or the current user cannot access its daemon." >&2
  exit 1
fi

if ! docker image inspect "$IMAGE_NAME" > /dev/null 2>&1; then
  echo "ERROR: Required local image '$IMAGE_NAME' was not found." >&2
  if [ -f "$POSTGRES_VERSION/Dockerfile" ]; then
    echo "Build it first with:" >&2
    echo "  docker build -t $IMAGE_NAME $POSTGRES_VERSION" >&2
  else
    echo "Generate its build context and build it before running this test." >&2
  fi
  exit 1
fi

cleanup() {
  echo "Cleaning up containers and volume..."
  docker rm -f "$NEXT_CONTAINER_NAME" "$CONTENDER_NAME" "$CONTAINER_NAME" > /dev/null 2>&1 || true
  docker volume rm "$MISMATCH_VOLUME_NAME" "$VOLUME_NAME" > /dev/null 2>&1 || true
}

wait_for_postgres() {
  local container_name=$1
  local max_retries=${2:-15}
  local retry_count=0

  while [ "$retry_count" -lt "$max_retries" ]; do
    if docker exec "$container_name" pg_isready -U postgres -t 2 > /dev/null 2>&1; then
      return 0
    fi

    if [ "$(docker inspect -f '{{.State.Status}}' "$container_name" 2>/dev/null)" = "exited" ]; then
      return 1
    fi

    sleep 2
    retry_count=$((retry_count + 1))
    echo -n "."
  done

  return 1
}

verify_certificate_chain() {
  local container_name=$1
  local ca_file=$2
  local certificate_file=$3
  local attempt

  # X.509 timestamps have one-second precision. Retry briefly so a clock
  # adjustment around issuance does not make this integration check flaky.
  for attempt in 1 2 3 4 5; do
    if docker exec "$container_name" openssl verify \
      -purpose sslserver -CAfile "$ca_file" "$certificate_file" \
      > /dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  docker exec "$container_name" openssl verify \
    -purpose sslserver -CAfile "$ca_file" "$certificate_file"
}

trap cleanup EXIT

echo "Verifying Railway mount and PGDATA validation..."
if INVALID_OUTPUT=$(docker run --rm \
  -e POSTGRES_PASSWORD=test_password \
  -e RAILWAY_ENVIRONMENT=true \
  -e RAILWAY_VOLUME_MOUNT_PATH="${MOUNT_PATH}/invalid" \
  "$IMAGE_NAME" 2>&1); then
  echo "ERROR: The image accepted an invalid Railway volume mount path."
  exit 1
fi

if ! printf '%s\n' "$INVALID_OUTPUT" | grep -q "Railway volume not mounted to the correct path"; then
  echo "ERROR: Invalid Railway mount path did not produce the expected error."
  echo "$INVALID_OUTPUT"
  exit 1
fi

if INVALID_OUTPUT=$(docker run --rm \
  -e POSTGRES_PASSWORD=test_password \
  -e PGDATA="${MOUNT_PATH}-invalid" \
  "$IMAGE_NAME" 2>&1); then
  echo "ERROR: The image accepted PGDATA with an invalid path prefix."
  exit 1
fi

if ! printf '%s\n' "$INVALID_OUTPUT" | grep -q "PGDATA is outside the expected volume mount path"; then
  echo "ERROR: Invalid PGDATA did not produce the expected boundary error."
  echo "$INVALID_OUTPUT"
  exit 1
fi

echo "Verifying PostgreSQL major-version compatibility..."
if [ "$MAJOR_VERSION" = "18" ]; then
  INCOMPATIBLE_MAJOR=17
else
  INCOMPATIBLE_MAJOR=18
fi

docker volume create "$MISMATCH_VOLUME_NAME" > /dev/null
docker run --rm \
  --entrypoint bash \
  -v "$MISMATCH_VOLUME_NAME:$MOUNT_PATH" \
  "$IMAGE_NAME" \
  -c "mkdir -p '$DATA_PATH' && echo '$INCOMPATIBLE_MAJOR' > '$DATA_PATH/PG_VERSION'"

if MISMATCH_OUTPUT=$(docker run --rm \
  -e POSTGRES_PASSWORD=test_password \
  -e RAILWAY_ENVIRONMENT=true \
  -e RAILWAY_VOLUME_MOUNT_PATH="$MOUNT_PATH" \
  -e PGDATA="$DATA_PATH" \
  -v "$MISMATCH_VOLUME_NAME:$MOUNT_PATH" \
  "$IMAGE_NAME" 2>&1); then
  echo "ERROR: The image started with data from PostgreSQL $INCOMPATIBLE_MAJOR."
  exit 1
fi

if ! printf '%s\n' "$MISMATCH_OUTPUT" | grep -q "This image runs PostgreSQL $MAJOR_VERSION, but PGDATA contains version '$INCOMPATIBLE_MAJOR'"; then
  echo "ERROR: Major-version mismatch did not produce the expected error."
  echo "$MISMATCH_OUTPUT"
  exit 1
fi

docker volume rm "$MISMATCH_VOLUME_NAME" > /dev/null

docker volume create "$VOLUME_NAME" > /dev/null

echo "Starting Postgres container ($CONTAINER_NAME) using image $IMAGE_NAME..."
# Start the container
docker run -d --name "$CONTAINER_NAME" \
  -e POSTGRES_PASSWORD=test_password \
  -e RAILWAY_ENVIRONMENT=true \
  -e RAILWAY_VOLUME_MOUNT_PATH="$MOUNT_PATH" \
  -e RAILWAY_PRIVATE_DOMAIN="$PRIVATE_DOMAIN" \
  -e RAILWAY_TCP_PROXY_DOMAIN="$PUBLIC_DOMAIN" \
  -e PGDATA="${DATA_PATH}/" \
  -v "$VOLUME_NAME:$MOUNT_PATH" \
  "$IMAGE_NAME"

echo "Waiting for Postgres to initialize (can take a few seconds)..."
if ! wait_for_postgres "$CONTAINER_NAME"; then
  echo ""
  echo "ERROR: Postgres failed to start or become ready in time!"
  echo "--- Container Logs ---"
  docker logs "$CONTAINER_NAME"
  exit 1
fi
echo ""

echo "Postgres is healthy and ready!"

SERVER_VERSION=$(docker exec "$CONTAINER_NAME" psql \
  --username postgres \
  --dbname postgres \
  --tuples-only \
  --no-align \
  -c "SHOW server_version")
case "$SERVER_VERSION" in
  "$POSTGRES_VERSION"|"$POSTGRES_VERSION "*) ;;
  *)
    echo "ERROR: Expected PostgreSQL $POSTGRES_VERSION, but the image contains '$SERVER_VERSION'."
    exit 1
    ;;
esac

NORMALIZED_PGDATA=$(docker exec "$CONTAINER_NAME" psql \
  --username postgres \
  --dbname postgres \
  --tuples-only \
  --no-align \
  -c "SHOW data_directory")
if [ "$NORMALIZED_PGDATA" != "$DATA_PATH" ]; then
  echo "ERROR: PGDATA trailing slash was not normalized."
  exit 1
fi

echo "Verifying SSL Certificate auto-generation..."
if ! docker exec "$CONTAINER_NAME" ls -l "$CERTS_DIR/server.crt" > /dev/null; then
  echo "ERROR: server.crt was not generated at $CERTS_DIR!"
  exit 1
fi

echo "Verifying Railway domains in the certificate SANs..."
for DNS_NAME in localhost "$PRIVATE_DOMAIN" "$PUBLIC_DOMAIN"; do
  if ! docker exec "$CONTAINER_NAME" openssl x509 \
    -checkhost "$DNS_NAME" \
    -noout \
    -in "$CERTS_DIR/server.crt" > /dev/null; then
    echo "ERROR: server.crt does not cover '$DNS_NAME'."
    exit 1
  fi
done

if ! docker exec "$CONTAINER_NAME" openssl x509 \
  -noout -ext basicConstraints -in "$CERTS_DIR/server.crt" \
  | grep -q "CA:FALSE"; then
  echo "ERROR: The server certificate can act as a Certificate Authority."
  exit 1
fi

if ! verify_certificate_chain \
  "$CONTAINER_NAME" \
  "$CERTS_DIR/root.crt" \
  "$CERTS_DIR/server.crt"; then
  echo "ERROR: The server certificate is not valid for TLS server use."
  exit 1
fi

if ! docker exec "$CONTAINER_NAME" openssl x509 \
  -noout -ext basicConstraints -in "$CERTS_DIR/root.crt" \
  | grep -q "CA:TRUE"; then
  echo "ERROR: The root certificate is not a Certificate Authority."
  exit 1
fi

echo "Verifying SSL Key permissions (must be -rw-------)..."
if ! docker exec "$CONTAINER_NAME" stat -c "%A" "$CERTS_DIR/server.key" | grep -q "\-rw-------"; then
  echo "ERROR: SSL Key permissions are incorrect at $CERTS_DIR!"
  docker exec "$CONTAINER_NAME" ls -l "$CERTS_DIR/server.key"
  exit 1
fi

echo "Verifying that a concurrent container cannot use the same volume..."
if CONTENDER_OUTPUT=$(docker run --name "$CONTENDER_NAME" \
  -e POSTGRES_PASSWORD=test_password \
  -e RAILWAY_ENVIRONMENT=true \
  -e RAILWAY_VOLUME_MOUNT_PATH="$MOUNT_PATH" \
  -e RUNTIME_LOCK_WAIT_SECONDS=1 \
  -v "$VOLUME_NAME:$MOUNT_PATH" \
  "$IMAGE_NAME" 2>&1); then
  echo "ERROR: A second Postgres container started with the same volume!"
  exit 1
fi

if ! printf '%s\n' "$CONTENDER_OUTPUT" | grep -q "Refusing to start another Postgres process on the same volume"; then
  echo "ERROR: The competing container did not fail because of the runtime lock."
  echo "--- Competing Container Output ---"
  echo "$CONTENDER_OUTPUT"
  exit 1
fi

echo "Preparing persistent state for the deployment handoff..."
docker exec "$CONTAINER_NAME" psql \
  -v ON_ERROR_STOP=1 \
  --username postgres \
  --dbname postgres \
  -c "CREATE TABLE railway_handoff_test (value text NOT NULL); INSERT INTO railway_handoff_test VALUES ('preserved');" \
  > /dev/null

CERT_FINGERPRINT=$(docker exec "$CONTAINER_NAME" openssl x509 \
  -noout -fingerprint -sha256 -in "$CERTS_DIR/server.crt")
ROOT_CERT_FINGERPRINT=$(docker exec "$CONTAINER_NAME" openssl x509 \
  -noout -fingerprint -sha256 -in "$CERTS_DIR/root.crt")

echo "Starting the next deployment while the current one still holds the volume..."
docker run -d --name "$NEXT_CONTAINER_NAME" \
  -e POSTGRES_PASSWORD=test_password \
  -e RAILWAY_ENVIRONMENT=true \
  -e RAILWAY_VOLUME_MOUNT_PATH="$MOUNT_PATH" \
  -e RAILWAY_PRIVATE_DOMAIN="$PRIVATE_DOMAIN" \
  -e RAILWAY_TCP_PROXY_DOMAIN="$PUBLIC_DOMAIN" \
  -e RUNTIME_LOCK_WAIT_SECONDS=30 \
  -v "$VOLUME_NAME:$MOUNT_PATH" \
  "$IMAGE_NAME" \
  > /dev/null

LOCK_WAIT_DETECTED=false
for _ in $(seq 1 20); do
  if docker logs "$NEXT_CONTAINER_NAME" 2>&1 | grep -q "Another Postgres container is still using the volume"; then
    LOCK_WAIT_DETECTED=true
    break
  fi
  sleep 0.25
done

if [ "$LOCK_WAIT_DETECTED" = false ]; then
  echo "ERROR: The next deployment did not wait for the current container's lock."
  echo "--- Next Container Logs ---"
  docker logs "$NEXT_CONTAINER_NAME"
  exit 1
fi

echo "Stopping the current deployment and waiting for the next one to take over..."
docker stop --time 10 "$CONTAINER_NAME" > /dev/null

if ! wait_for_postgres "$NEXT_CONTAINER_NAME" 20; then
  echo ""
  echo "ERROR: The next deployment did not start after the volume lock was released."
  echo "--- Next Container Logs ---"
  docker logs "$NEXT_CONTAINER_NAME"
  exit 1
fi
echo ""

if ! docker logs "$NEXT_CONTAINER_NAME" 2>&1 | grep -q "The previous container released the volume; continuing startup"; then
  echo "ERROR: The next deployment did not report a successful lock handoff."
  docker logs "$NEXT_CONTAINER_NAME"
  exit 1
fi

PRESERVED_VALUE=$(docker exec "$NEXT_CONTAINER_NAME" psql \
  --username postgres \
  --dbname postgres \
  --tuples-only \
  --no-align \
  -c "SELECT value FROM railway_handoff_test LIMIT 1")

if [ "$PRESERVED_VALUE" != "preserved" ]; then
  echo "ERROR: Database state was not preserved during the deployment handoff."
  exit 1
fi

NEXT_CERT_FINGERPRINT=$(docker exec "$NEXT_CONTAINER_NAME" openssl x509 \
  -noout -fingerprint -sha256 -in "$CERTS_DIR/server.crt")
NEXT_ROOT_CERT_FINGERPRINT=$(docker exec "$NEXT_CONTAINER_NAME" openssl x509 \
  -noout -fingerprint -sha256 -in "$CERTS_DIR/root.crt")

if [ "$NEXT_CERT_FINGERPRINT" != "$CERT_FINGERPRINT" ]; then
  echo "ERROR: The SSL certificate changed during the deployment handoff."
  exit 1
fi

if [ "$NEXT_ROOT_CERT_FINGERPRINT" != "$ROOT_CERT_FINGERPRINT" ]; then
  echo "ERROR: The Certificate Authority changed during the deployment handoff."
  exit 1
fi

echo "Deployment handoff preserved the database state and SSL certificate."

echo "Verifying safe server-certificate renewal..."
docker exec "$NEXT_CONTAINER_NAME" \
  bash /docker-entrypoint-initdb.d/init-ssl.sh \
  > /dev/null 2>&1

RENEWED_CERT_FINGERPRINT=$(docker exec "$NEXT_CONTAINER_NAME" openssl x509 \
  -noout -fingerprint -sha256 -in "$CERTS_DIR/server.crt")
RENEWED_ROOT_CERT_FINGERPRINT=$(docker exec "$NEXT_CONTAINER_NAME" openssl x509 \
  -noout -fingerprint -sha256 -in "$CERTS_DIR/root.crt")

if [ "$RENEWED_CERT_FINGERPRINT" = "$NEXT_CERT_FINGERPRINT" ]; then
  echo "ERROR: The server certificate was not renewed."
  exit 1
fi

if [ "$RENEWED_ROOT_CERT_FINGERPRINT" != "$NEXT_ROOT_CERT_FINGERPRINT" ]; then
  echo "ERROR: The Certificate Authority changed during server-certificate renewal."
  exit 1
fi

if ! verify_certificate_chain \
  "$NEXT_CONTAINER_NAME" \
  "$CERTS_DIR/root.crt" \
  "$CERTS_DIR/server.crt"; then
  echo "ERROR: The renewed server certificate does not validate against the preserved CA."
  exit 1
fi

if docker exec "$NEXT_CONTAINER_NAME" \
  find "$CERTS_DIR" -maxdepth 1 -type d -name '.generate.*' \
  | grep -q .; then
  echo "ERROR: A temporary certificate-generation directory was not cleaned up."
  exit 1
fi

echo "Server-certificate renewal preserved the Certificate Authority."

echo "Verifying safe fallback for invalid certificate settings..."
FALLBACK_ROOT_FINGERPRINT=$RENEWED_ROOT_CERT_FINGERPRINT
FALLBACK_OUTPUT=$(docker exec \
  -e SSL_CERT_DAYS=invalid \
  -e SSL_CA_CERT_DAYS=invalid \
  "$NEXT_CONTAINER_NAME" \
  bash /docker-entrypoint-initdb.d/init-ssl.sh 2>&1)

if ! printf '%s\n' "$FALLBACK_OUTPUT" | grep -q "SSL_CERT_DAYS must be a positive whole number; using 820"; then
  echo "ERROR: Invalid SSL_CERT_DAYS did not fall back to its safe default."
  echo "$FALLBACK_OUTPUT"
  exit 1
fi

if ! printf '%s\n' "$FALLBACK_OUTPUT" | grep -q "SSL_CA_CERT_DAYS must be a positive whole number; using 3650"; then
  echo "ERROR: Invalid SSL_CA_CERT_DAYS did not fall back to its safe default."
  echo "$FALLBACK_OUTPUT"
  exit 1
fi

SHORT_VALIDITY_OUTPUT=$(docker exec \
  -e SSL_CERT_DAYS=30 \
  -e SSL_CA_CERT_DAYS=32 \
  "$NEXT_CONTAINER_NAME" \
  bash /docker-entrypoint-initdb.d/init-ssl.sh 2>&1)

if ! printf '%s\n' "$SHORT_VALIDITY_OUTPUT" | grep -q "SSL_CERT_DAYS must be at least 32 days; using 820"; then
  echo "ERROR: A server-certificate lifetime inside the renewal window did not use the safe default."
  echo "$SHORT_VALIDITY_OUTPUT"
  exit 1
fi

if ! printf '%s\n' "$SHORT_VALIDITY_OUTPUT" | grep -q "SSL_CA_CERT_DAYS must be at least 33 days; using 3650"; then
  echo "ERROR: A CA lifetime without a safe renewal margin did not use the safe default."
  echo "$SHORT_VALIDITY_OUTPUT"
  exit 1
fi

if [ "$(docker exec "$NEXT_CONTAINER_NAME" openssl x509 -noout -fingerprint -sha256 -in "$CERTS_DIR/root.crt")" != "$FALLBACK_ROOT_FINGERPRINT" ]; then
  echo "ERROR: Invalid certificate settings unexpectedly rotated the Certificate Authority."
  exit 1
fi

echo "Verifying renewal with a legacy equal-lifetime Certificate Authority..."
docker exec "$NEXT_CONTAINER_NAME" bash -c '
  set -e
  work_dir=$(mktemp -d)
  trap '\''rm -rf -- "$work_dir"'\'' EXIT
  openssl req -new -x509 -days 820 -nodes \
    -out "$work_dir/root.crt" \
    -keyout "$work_dir/root.key" \
    -subj /CN=legacy-root-ca \
    -addext "basicConstraints = critical, CA:TRUE" \
    -addext "keyUsage = critical, keyCertSign, cRLSign" \
    > /dev/null 2>&1
  install -m 600 "$work_dir/root.key" "$PGDATA/certs/root.key"
  install -m 644 "$work_dir/root.crt" "$PGDATA/certs/root.crt"
'

LEGACY_ROOT_FINGERPRINT=$(docker exec "$NEXT_CONTAINER_NAME" openssl x509 \
  -noout -fingerprint -sha256 -in "$CERTS_DIR/root.crt")

docker exec "$NEXT_CONTAINER_NAME" \
  bash /docker-entrypoint-initdb.d/init-ssl.sh \
  > /dev/null 2>&1

if [ "$(docker exec "$NEXT_CONTAINER_NAME" openssl x509 -noout -fingerprint -sha256 -in "$CERTS_DIR/root.crt")" != "$LEGACY_ROOT_FINGERPRINT" ]; then
  echo "ERROR: A valid legacy Certificate Authority rotated during renewal."
  exit 1
fi

if ! verify_certificate_chain \
  "$NEXT_CONTAINER_NAME" \
  "$CERTS_DIR/root.crt" \
  "$CERTS_DIR/server.crt"; then
  echo "ERROR: The legacy Certificate Authority did not sign the renewed server certificate."
  exit 1
fi

if ! docker exec "$NEXT_CONTAINER_NAME" bash -c '
  root_expiry=$(date -u -d "$(openssl x509 -enddate -noout -in "$PGDATA/certs/root.crt" | cut -d= -f2-)" +%s)
  server_expiry=$(date -u -d "$(openssl x509 -enddate -noout -in "$PGDATA/certs/server.crt" | cut -d= -f2-)" +%s)
  [ "$server_expiry" -le "$root_expiry" ]
'; then
  echo "ERROR: The renewed server certificate outlives its Certificate Authority."
  exit 1
fi

echo "Verifying automatic repair of mismatched certificate material..."
docker exec "$NEXT_CONTAINER_NAME" cp "$CERTS_DIR/root.key" "$CERTS_DIR/server.key"
REPAIR_OUTPUT=$(docker exec "$NEXT_CONTAINER_NAME" wrapper.sh true 2>&1)

if ! printf '%s\n' "$REPAIR_OUTPUT" | grep -q "Invalid SSL certificate material was found"; then
  echo "ERROR: The wrapper did not detect the mismatched server key."
  echo "$REPAIR_OUTPUT"
  exit 1
fi

if ! docker exec "$NEXT_CONTAINER_NAME" bash -c '
  certificate_public_key=$(openssl x509 -pubkey -noout -in "$PGDATA/certs/server.crt")
  private_public_key=$(openssl pkey -pubout -in "$PGDATA/certs/server.key")
  [ "$certificate_public_key" = "$private_public_key" ]
'; then
  echo "ERROR: The wrapper did not repair the mismatched server key."
  exit 1
fi

if [ "$(docker exec "$NEXT_CONTAINER_NAME" openssl x509 -noout -fingerprint -sha256 -in "$CERTS_DIR/root.crt")" != "$LEGACY_ROOT_FINGERPRINT" ]; then
  echo "ERROR: Repairing the server key unexpectedly rotated the Certificate Authority."
  exit 1
fi

if ! docker exec "$NEXT_CONTAINER_NAME" stat -c "%A" "$CERTS_DIR/server.key" | grep -q "\-rw-------"; then
  echo "ERROR: Renewed SSL key permissions are incorrect."
  exit 1
fi

for DNS_NAME in localhost "$PRIVATE_DOMAIN" "$PUBLIC_DOMAIN"; do
  if ! docker exec "$NEXT_CONTAINER_NAME" openssl x509 \
    -checkhost "$DNS_NAME" -noout -in "$CERTS_DIR/server.crt" > /dev/null; then
    echo "ERROR: The repaired server certificate does not cover '$DNS_NAME'."
    exit 1
  fi
done

echo "Legacy CA renewal and certificate repair passed."

echo "All integration tests passed successfully!"
