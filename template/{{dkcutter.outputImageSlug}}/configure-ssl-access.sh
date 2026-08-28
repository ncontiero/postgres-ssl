#!/bin/bash

set -e

PG_HBA_FILE=${1:-"$PGDATA/pg_hba.conf"}
MANAGED_BLOCK_BEGIN="# BEGIN postgres-ssl managed TLS requirement"
MANAGED_BLOCK_END="# END postgres-ssl managed TLS requirement"

case "${SSL_REQUIRE:-false}" in
  true) ssl_require=true ;;
  false|'') ssl_require=false ;;
  *)
    echo "ERROR: SSL_REQUIRE must be 'true' or 'false'." >&2
    exit 1
    ;;
esac

# During the first startup, wrapper.sh runs before initdb creates pg_hba.conf.
# init-ssl.sh calls this script again after the file has been initialized.
if [ ! -f "$PG_HBA_FILE" ]; then
  exit 0
fi

work_dir=$(mktemp -d "$(dirname "$PG_HBA_FILE")/.configure-ssl-access.XXXXXX")
clean_hba="$work_dir/pg_hba.clean"
next_hba="$work_dir/pg_hba.conf"

cleanup() {
  rm -rf -- "$work_dir"
}

trap cleanup EXIT

# Remove our existing block first so enabling, disabling, and repeated starts
# all produce the same deterministic file. Refuse malformed markers instead of
# accidentally discarding user-managed access rules.
if ! awk \
  -v block_begin="$MANAGED_BLOCK_BEGIN" \
  -v block_end="$MANAGED_BLOCK_END" '
    $0 == block_begin {
      if (in_managed_block) exit 2
      in_managed_block = 1
      next
    }
    $0 == block_end {
      if (!in_managed_block) exit 2
      in_managed_block = 0
      next
    }
    !in_managed_block { print }
    END { if (in_managed_block) exit 2 }
  ' "$PG_HBA_FILE" > "$clean_hba"; then
  echo "ERROR: Managed SSL_REQUIRE markers in '$PG_HBA_FILE' are malformed." >&2
  exit 1
fi

if [ "$ssl_require" = true ]; then
  {
    printf '%s\n' "$MANAGED_BLOCK_BEGIN"
    printf '%s\n' 'hostnossl all all all reject'
    printf '%s\n' 'hostnossl replication all all reject'
    printf '%s\n' "$MANAGED_BLOCK_END"
    cat "$clean_hba"
  } > "$next_hba"
else
  cp "$clean_hba" "$next_hba"
fi

if cmp -s "$PG_HBA_FILE" "$next_hba"; then
  echo "SSL_REQUIRE is ${ssl_require}; pg_hba.conf is already configured."
  exit 0
fi

chmod --reference="$PG_HBA_FILE" "$next_hba"
chown --reference="$PG_HBA_FILE" "$next_hba"
mv -f -- "$next_hba" "$PG_HBA_FILE"

echo "SSL_REQUIRE is ${ssl_require}; pg_hba.conf was updated."
