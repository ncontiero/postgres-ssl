#!/bin/bash

set -e

ca_certificate="$PGDATA/certs/root.crt"

if [ ! -s "$ca_certificate" ]; then
  echo "ERROR: SSL CA certificate was not found at '$ca_certificate'." >&2
  exit 1
fi

if ! openssl x509 -in "$ca_certificate" -noout > /dev/null 2>&1; then
  echo "ERROR: '$ca_certificate' is not a valid X.509 certificate." >&2
  exit 1
fi

# Write only the public certificate to stdout so callers can safely redirect it
# to a client trust file. Private keys are never read by this command.
cat -- "$ca_certificate"
