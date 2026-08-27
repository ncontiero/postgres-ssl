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
  docker rm -f "$CONTENDER_NAME" "$CONTAINER_NAME" > /dev/null 2>&1 || true
  docker volume rm "$VOLUME_NAME" > /dev/null 2>&1 || true
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
# Retry loop for pg_isready (up to 30 seconds)
MAX_RETRIES=15
RETRY_COUNT=0
IS_READY=false

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  if docker exec "$CONTAINER_NAME" pg_isready -U postgres -t 2 > /dev/null 2>&1; then
    IS_READY=true
    break
  fi
  sleep 2
  RETRY_COUNT=$((RETRY_COUNT + 1))
  echo -n "."
done
echo ""

if [ "$IS_READY" = false ]; then
  echo "ERROR: Postgres failed to start or become ready in time!"
  echo "--- Container Logs ---"
  docker logs "$CONTAINER_NAME"
  exit 1
fi

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

echo "All integration tests passed successfully!"
