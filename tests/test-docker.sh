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

echo "Starting Postgres container ($CONTAINER_NAME) using image $IMAGE_NAME..."
# Start the container
docker run -d --name "$CONTAINER_NAME" -e POSTGRES_PASSWORD=test_password "$IMAGE_NAME"

# Setup a trap to ensure the container is ALWAYS deleted when the script exits, even on failure
trap 'echo "Cleaning up container..."; docker rm -f "$CONTAINER_NAME" > /dev/null' EXIT

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

MAJOR_VERSION=$(echo "$POSTGRES_VERSION" | cut -d. -f1)

if [ "$MAJOR_VERSION" -lt 18 ]; then
  CERTS_DIR="/var/lib/postgresql/data/certs"
else
  CERTS_DIR="/var/lib/postgresql/${MAJOR_VERSION}/docker/certs"
fi

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

echo "All integration tests passed successfully!"
