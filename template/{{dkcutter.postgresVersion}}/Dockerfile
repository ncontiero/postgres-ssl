# Generated: {{ dkcutter.now.toLocaleDateString() }}
# postgres version: {{ dkcutter.postgresVersion }}
ARG POSTGRES_VERSION={{ dkcutter.postgresVersion }}
FROM postgres:${POSTGRES_VERSION}

# ==============================================================================
# 1. SYSTEM DEPENDENCIES
# Install essential packages required for the entrypoint scripts and general use.
# - openssl: For generating self-signed SSL certificates.
# - sudo: Allows the 'postgres' user to perform specific root actions.
# ==============================================================================
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openssl \
        sudo \
    && rm -rf /var/lib/apt/lists/*

# ==============================================================================
# 2. POSTGRESQL EXTENSION MANAGEMENT
# This section allows for the dynamic installation of PostgreSQL extensions
# by specifying them as build arguments.
# ==============================================================================

# --- Step 2.1: Define Build Arguments ---
# These arguments are used to configure the extension installation process.
# They can be passed during the `docker build` command.
#
# Example usage:
# --build-arg PG_EXTENSION_REPOS="https://packagecloud.io/timescale/timescaledb/debian/ trixie main"
# --build-arg PG_EXTENSION_REPO_KEYS="https://packagecloud.io/timescale/timescaledb/gpgkey"
# --build-arg PG_APT_PACKAGES="postgresql-18-postgis-3,timescaledb-2-postgresql-18"
ARG PG_EXTENSION_REPOS=""
ARG PG_EXTENSION_REPO_KEYS=""
ARG PG_APT_PACKAGES=""

# --- Step 2.2: Install Custom Extensions ---
# It only runs if PG_APT_PACKAGES are specified.
# Dependencies for adding custom repos are only installed if PG_EXTENSION_REPOS are also provided.
RUN \
    # If no packages are specified, there's nothing to do.
    if [ -z "$PG_APT_PACKAGES" ]; then \
        echo "No extension packages specified. Skipping."; \
        exit 0; \
    fi; \
    set -e; \
    \
    if [ -n "$PG_EXTENSION_REPOS" ]; then \
        apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
        \
        # Create a temporary file to hold the GPG key URLs.
        echo "$PG_EXTENSION_REPO_KEYS" | tr ',' '\n' > /tmp/keys.txt; \
        \
        # Loop through each repository URL provided.
        i=1; \
        echo "$PG_EXTENSION_REPOS" | tr ',' '\n' | while read -r repo_raw; do \
            # Clean leading/trailing whitespace from the repo URL.
            repo_clean=$(echo "$repo_raw" | xargs); \
            # Remove 'deb ' prefix if the user accidentally included it.
            repo_final=$(echo "$repo_clean" | sed 's/^deb //'); \
            # Get the corresponding key URL from the temporary file.
            key_url=$(sed "${i}q;d" /tmp/keys.txt); \
            \
            if [ -n "$repo_final" ] && [ -n "$key_url" ]; then \
                repo_name="custom-repo-${i}"; \
                echo "Adding repo: $repo_final"; \
                # Download the GPG key and add it to the trusted keyrings.
                curl -fsSL "$key_url" | gpg --dearmor -o "/usr/share/keyrings/${repo_name}.gpg"; \
                # Create the APT source list file for the new repository.
                echo "deb [signed-by=/usr/share/keyrings/${repo_name}.gpg] $repo_final" > "/etc/apt/sources.list.d/${repo_name}.list"; \
            fi; \
            i=$((i+1)); \
        done; \
        # Clean up the temporary key file.
        rm /tmp/keys.txt; \
    fi; \
    \
    echo "Updating apt cache with new repositories..."; \
    apt-get update; \
    \
    # Convert the comma-separated package list into a space-separated list.
    packages=$(echo "$PG_APT_PACKAGES" | tr ',' ' '); \
    \
    echo "Installing packages: $packages"; \
    apt-get install -y --no-install-recommends $packages; \
    \
    # Clean up the APT cache to reduce final image size.
    rm -rf /var/lib/apt/lists/*;

# --- Step 2.3: Set Environment Variables for Runtime ---
# Pass the build-time arguments for enabling extensions to runtime environment
# variables, which will be used by the `init-extensions.sh` script.
ARG PG_DB_EXTENSIONS=""
ARG PG_SHARED_PRELOAD_LIBRARIES=""
ENV PG_DB_EXTENSIONS=$PG_DB_EXTENSIONS
ENV PG_SHARED_PRELOAD_LIBRARIES=$PG_SHARED_PRELOAD_LIBRARIES

# ==============================================================================
# 3. PERMISSIONS & SCRIPTS
# Configure permissions and copy the necessary initialization and wrapper scripts.
# ==============================================================================

# --- Step 3.1: Configure Sudo ---
# Allow the 'postgres' user to run specific commands as root without a password.
# This is required by `init-ssl.sh` to create the SSL directory and set its
# ownership, and by openssl to generate certificates.
RUN echo "postgres ALL=(root) NOPASSWD: /usr/bin/mkdir, /bin/chown, /usr/bin/openssl" > /etc/sudoers.d/postgres

# --- Step 3.2: Copy Scripts ---
# Copy the initialization scripts into the container.
# - `init-*.sh` scripts are placed in `docker-entrypoint-initdb.d` to be
#   executed automatically when the database is first created.
# - `wrapper.sh` becomes the new entrypoint to handle certificate checks.
# The `--chmod` flag ensures they are executable.
COPY --chmod=755 ./init-ssl.sh /docker-entrypoint-initdb.d/init-ssl.sh
COPY --chmod=755 ./init-extensions.sh /docker-entrypoint-initdb.d/init-extensions.sh
COPY --chmod=755 ./wrapper.sh /usr/local/bin/wrapper.sh

ENTRYPOINT ["wrapper.sh"]

# Default command to start PostgreSQL server.
# - `-p 5432`: Listens on the standard PostgreSQL port.
# - `-c listen_addresses=*`: Allows connections from any IP address.
CMD ["postgres", "-p", "5432", "-c", "listen_addresses=*"]
