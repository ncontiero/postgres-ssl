#!/bin/bash

# exit as soon as any of these commands fail, this prevents starting a database without certificates
set -e

# ==============================================================================
# 1. SETUP VARIABLES
# Define all file paths and constants used in the script.
# ==============================================================================
SSL_DIR="$PGDATA/certs"
POSTGRES_CONF_FILE="$PGDATA/postgresql.conf"

# Certificate Authority (CA) files
SSL_ROOT_KEY="$SSL_DIR/root.key"
SSL_ROOT_CRT="$SSL_DIR/root.crt"

# Server certificate files
SSL_SERVER_KEY="$SSL_DIR/server.key"
SSL_SERVER_CRT="$SSL_DIR/server.crt"

# openssl extension configuration file
SSL_V3_EXT="$SSL_DIR/v3.ext"

DEFAULT_SSL_CERT_DAYS=820
DEFAULT_SSL_CA_CERT_DAYS=3650
MAX_SSL_CERT_DAYS=36500
CA_REUSE_MIN_SECONDS=$((32 * 86400))

SSL_CERT_DAYS="${SSL_CERT_DAYS:-$DEFAULT_SSL_CERT_DAYS}"
SSL_CA_CERT_DAYS="${SSL_CA_CERT_DAYS:-$DEFAULT_SSL_CA_CERT_DAYS}"

normalize_certificate_days() {
  local variable_name=$1
  local value=$2
  local default_value=$3
  local value_length

  case "$value" in
    ''|*[!0-9]*|0)
      echo "WARNING: $variable_name must be a positive whole number; using $default_value." >&2
      printf '%s' "$default_value"
      return
      ;;
  esac

  while [ "${value#0}" != "$value" ]; do
    value=${value#0}
  done

  value_length={% raw %}${#value}{% endraw %}
  if [ -z "$value" ] || [ "$value_length" -gt 5 ] || [ "$value" -gt "$MAX_SSL_CERT_DAYS" ]; then
    echo "WARNING: $variable_name must not exceed $MAX_SSL_CERT_DAYS days; using $default_value." >&2
    printf '%s' "$default_value"
    return
  fi

  printf '%s' "$value"
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

verify_generated_certificate() {
  local ca_certificate=$1
  local server_certificate=$2
  local attempt

  # X.509 timestamps have one-second precision. On some hosts, a certificate
  # verified in the same instant it was issued can briefly appear not yet
  # valid. Keep the time check enabled and publish files only after it passes.
  for attempt in 1 2 3 4 5; do
    if openssl verify -CAfile "$ca_certificate" "$server_certificate" > /dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  openssl verify -CAfile "$ca_certificate" "$server_certificate"
}

ca_is_reusable() {
  [ -s "$SSL_ROOT_CRT" ] \
    && [ -s "$SSL_ROOT_KEY" ] \
    && openssl x509 -checkend "$CA_REUSE_MIN_SECONDS" -noout -in "$SSL_ROOT_CRT" > /dev/null 2>&1 \
    && openssl x509 -noout -ext basicConstraints -in "$SSL_ROOT_CRT" 2>/dev/null | grep -q "CA:TRUE" \
    && openssl verify -CAfile "$SSL_ROOT_CRT" "$SSL_ROOT_CRT" > /dev/null 2>&1 \
    && certificate_matches_private_key "$SSL_ROOT_CRT" "$SSL_ROOT_KEY"
}

server_certificate_days_for_ca() {
  local ca_certificate=$1
  local expires_at
  local expires_epoch
  local now_epoch
  local remaining_days

  expires_at=$(openssl x509 -enddate -noout -in "$ca_certificate" | cut -d= -f2-)
  expires_epoch=$(date -u -d "$expires_at" +%s)
  now_epoch=$(date -u +%s)
  remaining_days=$(((expires_epoch - now_epoch) / 86400))

  if [ "$remaining_days" -lt "$SSL_CERT_DAYS" ]; then
    printf '%s' "$remaining_days"
  else
    printf '%s' "$SSL_CERT_DAYS"
  fi
}

SSL_CERT_DAYS=$(normalize_certificate_days SSL_CERT_DAYS "$SSL_CERT_DAYS" "$DEFAULT_SSL_CERT_DAYS")
SSL_CA_CERT_DAYS=$(normalize_certificate_days SSL_CA_CERT_DAYS "$SSL_CA_CERT_DAYS" "$DEFAULT_SSL_CA_CERT_DAYS")

if [ "$SSL_CA_CERT_DAYS" -lt 33 ]; then
  echo "WARNING: SSL_CA_CERT_DAYS must be at least 33 days; using $DEFAULT_SSL_CA_CERT_DAYS." >&2
  SSL_CA_CERT_DAYS=$DEFAULT_SSL_CA_CERT_DAYS
fi

is_valid_dns_name() {
  local dns_name=$1
  local dns_name_length

  dns_name_length=$(printf '%s' "$dns_name" | wc -c)

  [ "$dns_name_length" -le 253 ] \
    && [[ "$dns_name" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] \
    && [[ "$dns_name" != *..* ]]
}

SSL_SAN="DNS:localhost"
for railway_domain in "${RAILWAY_PRIVATE_DOMAIN:-}" "${RAILWAY_TCP_PROXY_DOMAIN:-}"; do
  if [ -z "$railway_domain" ]; then
    continue
  fi

  if ! is_valid_dns_name "$railway_domain"; then
    echo "ERROR: '$railway_domain' is not a valid DNS name for the server certificate." >&2
    exit 1
  fi

  SSL_SAN="${SSL_SAN},DNS:${railway_domain}"
done

# ==============================================================================
# 2. CREATE SSL DIRECTORY
# ==============================================================================
echo "Creating SSL certificate directory..."
mkdir -p "$SSL_DIR"
SSL_WORK_DIR=$(mktemp -d "$SSL_DIR/.generate.XXXXXX")

cleanup_work_dir() {
  rm -rf -- "$SSL_WORK_DIR"
}

trap cleanup_work_dir EXIT
umask 077

# ==============================================================================
# 3. PREPARE CERTIFICATE AUTHORITY (CA)
# Preserve a valid CA so clients do not need to trust a new root on every
# server-certificate renewal. The server-certificate lifetime is shortened when
# necessary so it never outlives a reusable CA.
# ==============================================================================
REUSE_CA=false
CA_KEY_SOURCE="$SSL_ROOT_KEY"
CA_CRT_SOURCE="$SSL_ROOT_CRT"

if ca_is_reusable; then
  REUSE_CA=true
  echo "Preserving the existing Certificate Authority."
else
  echo "Generating a new Certificate Authority..."
  CA_KEY_SOURCE="$SSL_WORK_DIR/root.key"
  CA_CRT_SOURCE="$SSL_WORK_DIR/root.crt"
  openssl req \
    -new \
    -x509 \
    -days "$SSL_CA_CERT_DAYS" \
    -nodes \
    -text \
    -out "$CA_CRT_SOURCE" \
    -keyout "$CA_KEY_SOURCE" \
    -subj "/CN=root-ca" \
    -addext "basicConstraints = critical, CA:TRUE" \
    -addext "keyUsage = critical, keyCertSign, cRLSign" \
    -addext "subjectKeyIdentifier = hash"
fi

EFFECTIVE_SSL_CERT_DAYS=$(server_certificate_days_for_ca "$CA_CRT_SOURCE")
echo "Server certificate validity: ${EFFECTIVE_SSL_CERT_DAYS} days."

# ==============================================================================
# 4. GENERATE SERVER CERTIFICATE AND KEY
# Create the server's private key and a certificate signing request (CSR).
# ==============================================================================
echo "Generating server key and certificate signing request (CSR)..."
WORK_SERVER_KEY="$SSL_WORK_DIR/server.key"
WORK_SERVER_CSR="$SSL_WORK_DIR/server.csr"
WORK_SERVER_CRT="$SSL_WORK_DIR/server.crt"
WORK_V3_EXT="$SSL_WORK_DIR/v3.ext"

openssl req \
  -new \
  -nodes \
  -text \
  -out "$WORK_SERVER_CSR" \
  -keyout "$WORK_SERVER_KEY" \
  -subj "/CN=localhost"

# ==============================================================================
# 5. CREATE OPENSSL EXTENSIONS FILE
# This configuration file is needed to define the Subject Alternative Name (SAN),
# allowing the certificate to be valid for localhost and the Railway domains.
# ==============================================================================
echo "Creating openssl v3 extensions file..."
cat >| "$WORK_V3_EXT" <<EOF
[v3_req]
authorityKeyIdentifier = keyid, issuer
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${SSL_SAN}
EOF

# ==============================================================================
# 6. SIGN THE SERVER CERTIFICATE
# Use the root CA to sign the server's CSR, creating the final server certificate.
# ==============================================================================
echo "Signing the server certificate with the CA..."
openssl x509 \
  -req \
  -in "$WORK_SERVER_CSR" \
  -extfile "$WORK_V3_EXT" \
  -extensions v3_req \
  -text \
  -days "$EFFECTIVE_SSL_CERT_DAYS" \
  -CA "$CA_CRT_SOURCE" \
  -CAkey "$CA_KEY_SOURCE" \
  -set_serial "0x$(openssl rand -hex 16)" \
  -out "$WORK_SERVER_CRT"

# ==============================================================================
# 7. VALIDATE AND INSTALL CERTIFICATES
# Validate every generated artifact before replacing the active files. Each
# rename is atomic, and the wrapper repairs an interrupted set on the next boot.
# ==============================================================================
echo "Validating generated certificates..."
verify_generated_certificate "$CA_CRT_SOURCE" "$WORK_SERVER_CRT"
certificate_matches_private_key "$WORK_SERVER_CRT" "$WORK_SERVER_KEY"

IFS=',' read -r -a san_entries <<< "$SSL_SAN"
for san_entry in "${san_entries[@]}"; do
  dns_name=${san_entry#DNS:}
  openssl x509 -checkhost "$dns_name" -noout -in "$WORK_SERVER_CRT" > /dev/null
done

chmod 600 "$CA_KEY_SOURCE" "$WORK_SERVER_KEY"
chmod 644 "$CA_CRT_SOURCE" "$WORK_SERVER_CRT"
chmod 600 "$WORK_V3_EXT"

if [ "$(id -u)" = '0' ]; then
  chown postgres:postgres "$CA_KEY_SOURCE" "$CA_CRT_SOURCE" "$WORK_SERVER_KEY" "$WORK_SERVER_CRT" "$WORK_V3_EXT"
fi

if [ "$REUSE_CA" = false ]; then
  mv -f -- "$CA_KEY_SOURCE" "$SSL_ROOT_KEY"
  mv -f -- "$CA_CRT_SOURCE" "$SSL_ROOT_CRT"
fi
mv -f -- "$WORK_SERVER_KEY" "$SSL_SERVER_KEY"
mv -f -- "$WORK_SERVER_CRT" "$SSL_SERVER_CRT"
mv -f -- "$WORK_V3_EXT" "$SSL_V3_EXT"

# ==============================================================================
# 8. CONFIGURE POSTGRESQL
# Append the SSL configuration to postgresql.conf, if not already present.
# ==============================================================================
echo "Checking postgresql.conf for SSL configuration..."
if grep -q "ssl = on" "$POSTGRES_CONF_FILE"; then
  echo "SSL configuration already exists in postgresql.conf."
else
  echo "Appending SSL configuration to postgresql.conf..."
  cat >> "$POSTGRES_CONF_FILE" <<EOF

# SSL Configuration
ssl = on
ssl_cert_file = '$SSL_SERVER_CRT'
ssl_key_file = '$SSL_SERVER_KEY'
ssl_ca_file = '$SSL_ROOT_CRT'
EOF
fi

# ==============================================================================
# 9. ENSURE OWNERSHIP
# Ensure all generated files are owned by the 'postgres' user.
# This is particularly needed when the script is executed by root via wrapper.sh
# ==============================================================================
if [ "$(id -u)" = '0' ]; then
  chown -R postgres:postgres "$SSL_DIR"
fi

echo "SSL initialization complete."
