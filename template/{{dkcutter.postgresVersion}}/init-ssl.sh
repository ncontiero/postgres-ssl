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
SSL_SERVER_CSR="$SSL_DIR/server.csr"
SSL_SERVER_CRT="$SSL_DIR/server.crt"

# openssl extension configuration file
SSL_V3_EXT="$SSL_DIR/v3.ext"

# ==============================================================================
# 2. CREATE SSL DIRECTORY
# The directory needs to be created by a user with root-level privileges,
# then its ownership is transferred to the 'postgres' user.
# ==============================================================================
echo "Creating SSL certificate directory..."
sudo mkdir -p "$SSL_DIR"
sudo chown postgres:postgres "$SSL_DIR"

# ==============================================================================
# 3. GENERATE CERTIFICATE AUTHORITY (CA)
# This self-signed certificate will act as the root CA to sign the server cert.
# ==============================================================================
echo "Generating Certificate Authority..."
openssl req \
  -new \
  -x509 \
  -days "${SSL_CERT_DAYS:-820}" \
  -nodes \
  -text \
  -out "$SSL_ROOT_CRT" \
  -keyout "$SSL_ROOT_KEY" \
  -subj "/CN=root-ca"

# Protect the CA private key by removing read/write/execute permissions for group and others.
chmod og-rwx "$SSL_ROOT_KEY"

# ==============================================================================
# 4. GENERATE SERVER CERTIFICATE AND KEY
# Create the server's private key and a certificate signing request (CSR).
# ==============================================================================
echo "Generating server key and certificate signing request (CSR)..."
openssl req \
  -new \
  -nodes \
  -text \
  -out "$SSL_SERVER_CSR" \
  -keyout "$SSL_SERVER_KEY" \
  -subj "/CN=localhost"

# Protect the server's private key.
chmod og-rwx "$SSL_SERVER_KEY"

# ==============================================================================
# 5. CREATE OPENSLL EXTENSIONS FILE
# This configuration file is needed to define the Subject Alternative Name (SAN),
# allowing the certificate to be valid for 'localhost'.
# ==============================================================================
echo "Creating openssl v3 extensions file..."
cat >| "$SSL_V3_EXT" <<EOF
[v3_req]
authorityKeyIdentifier = keyid, issuer
basicConstraints = critical, CA:TRUE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment
subjectAltName = DNS:localhost
EOF

# ==============================================================================
# 6. SIGN THE SERVER CERTIFICATE
# Use the root CA to sign the server's CSR, creating the final server certificate.
# ==============================================================================
echo "Signing the server certificate with the CA..."
openssl x509 \
  -req \
  -in "$SSL_SERVER_CSR" \
  -extfile "$SSL_V3_EXT" \
  -extensions v3_req \
  -text \
  -days "${SSL_CERT_DAYS:-820}" \
  -CA "$SSL_ROOT_CRT" \
  -CAkey "$SSL_ROOT_KEY" \
  -CAcreateserial \
  -out "$SSL_SERVER_CRT"

# ==============================================================================
# 7. CONFIGURE POSTGRESQL
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

echo "SSL initialization complete."
