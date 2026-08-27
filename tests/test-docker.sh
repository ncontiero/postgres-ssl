#!/bin/bash

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

MAJOR_VERSION=$(echo "$POSTGRES_VERSION" | cut -d. -f1)

if [ "$MAJOR_VERSION" -lt 18 ]; then
  MOUNT_PATH="/var/lib/postgresql/data"
  CERTS_DIR="${MOUNT_PATH}/certs"
else
  MOUNT_PATH="/var/lib/postgresql"
  CERTS_DIR="${MOUNT_PATH}/${MAJOR_VERSION}/docker/certs"
fi

cleanup() {
  echo "Cleaning up containers and volume..."
  docker rm -f "$NEXT_CONTAINER_NAME" "$CONTENDER_NAME" "$CONTAINER_NAME" > /dev/null 2>&1 || true
  docker volume rm "$VOLUME_NAME" > /dev/null 2>&1 || true
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

trap cleanup EXIT

docker volume create "$VOLUME_NAME" > /dev/null

echo "Starting Postgres container ($CONTAINER_NAME) using image $IMAGE_NAME..."
# Start the container
docker run -d --name "$CONTAINER_NAME" \
  -e POSTGRES_PASSWORD=test_password \
  -e RAILWAY_ENVIRONMENT=true \
  -e RAILWAY_VOLUME_MOUNT_PATH="$MOUNT_PATH" \
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

echo "Verifying SSL Certificate auto-generation..."
if ! docker exec "$CONTAINER_NAME" ls -l "$CERTS_DIR/server.crt" > /dev/null; then
  echo "ERROR: server.crt was not generated at $CERTS_DIR!"
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

if ! grep -q "Refusing to start another Postgres process on the same volume" <<< "$CONTENDER_OUTPUT"; then
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

echo "Starting the next deployment while the current one still holds the volume..."
docker run -d --name "$NEXT_CONTAINER_NAME" \
  -e POSTGRES_PASSWORD=test_password \
  -e RAILWAY_ENVIRONMENT=true \
  -e RAILWAY_VOLUME_MOUNT_PATH="$MOUNT_PATH" \
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

if [ "$NEXT_CERT_FINGERPRINT" != "$CERT_FINGERPRINT" ]; then
  echo "ERROR: The SSL certificate changed during the deployment handoff."
  exit 1
fi

echo "Deployment handoff preserved the database state and SSL certificate."

echo "All integration tests passed successfully!"
