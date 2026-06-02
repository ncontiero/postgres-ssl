#!/bin/bash
set -e

# Usage: bash ./tests/test-docker-extensions.sh <postgres-version> <template-dir>
POSTGRES_VERSION=$1
TEMPLATE_DIR=$2

if [ -z "$POSTGRES_VERSION" ] || [ -z "$TEMPLATE_DIR" ]; then
  echo "Error: POSTGRES_VERSION or TEMPLATE_DIR is not specified."
  echo "Usage: bash ./tests/test-docker-extensions.sh <postgres-version> <template-dir>"
  exit 1
fi

MAJOR_VERSION=$(echo "$POSTGRES_VERSION" | cut -d. -f1)
IMAGE_NAME="postgres-ext-test:${POSTGRES_VERSION}"
CONTAINER_NAME="pg-ext-test-${POSTGRES_VERSION}"

echo "Building extension image from ${TEMPLATE_DIR}..."
# We pass PostGIS as a test to verify the dynamic extension building logic
PG_PKG="postgresql-${MAJOR_VERSION}-postgis-3"

docker build \
  --build-arg POSTGRES_VERSION="${POSTGRES_VERSION}" \
  --build-arg PG_APT_PACKAGES="${PG_PKG}" \
  --build-arg PG_DB_EXTENSIONS="postgis" \
  -t "$IMAGE_NAME" "./$TEMPLATE_DIR"

if [ "$MAJOR_VERSION" -lt 18 ]; then
  CERTS_DIR="/var/lib/postgresql/data/certs"
  MOUNT_PATH="/var/lib/postgresql/data"
else
  CERTS_DIR="/var/lib/postgresql/${MAJOR_VERSION}/docker/certs"
  MOUNT_PATH="/var/lib/postgresql"
fi

echo "Starting Postgres Extension container ($CONTAINER_NAME)..."
docker run -d --name "$CONTAINER_NAME" \
  -e POSTGRES_PASSWORD=test_password \
  -e RAILWAY_ENVIRONMENT=true \
  -e RAILWAY_VOLUME_MOUNT_PATH="$MOUNT_PATH" \
  "$IMAGE_NAME"

trap 'echo "Cleaning up container..."; docker rm -f "$CONTAINER_NAME" > /dev/null' EXIT

echo "Waiting for Postgres to initialize..."
MAX_RETRIES=20
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
  echo "ERROR: Postgres failed to start!"
  echo "--- Logs ---"
  docker logs "$CONTAINER_NAME"
  exit 1
fi

echo "Verifying SSL Certificate auto-generation at $CERTS_DIR..."
if ! docker exec "$CONTAINER_NAME" ls -l "$CERTS_DIR/server.crt" > /dev/null; then
  echo "ERROR: server.crt was not generated!"
  exit 1
fi

echo "Verifying Extension installation (PostGIS)..."
if ! docker exec "$CONTAINER_NAME" psql -U postgres -c "\dx" | grep -q "postgis"; then
  echo "ERROR: PostGIS extension was not created!"
  docker exec "$CONTAINER_NAME" psql -U postgres -c "\dx"
  exit 1
fi

echo "All extension tests passed successfully!"
