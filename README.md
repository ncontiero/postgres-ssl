# SSL-enabled Postgres DB image

This repository contains the logic to build SSL-enabled Postgres images.

## Railway Templates

We offer two distinct templates for Railway deployments, depending on your needs:

### 1. Standard PostgreSQL (Pre-built Image)

This is the fastest way to get started. It uses our pre-built image from the GitHub Container Registry (`ghcr.io`). Use this if you just need a standard PostgreSQL database with SSL enabled.

[![Deploy Standard Postgres on Railway](https://railway.com/button.svg)](https://railway.com/deploy/postgresql?referralCode=7y-eBI)

### 2. PostgreSQL with Custom Extensions (Build from Source)

This template builds the image directly on Railway using a specific `Dockerfile` from this repository, allowing you to install and enable custom PostgreSQL extensions via Docker build arguments. Due to volume mount point changes in PostgreSQL 18, we provide two directories:

- **PostgreSQL 18+**: Uses the `with-extensions` directory.
- **PostgreSQL 17 and older**: Uses the `with-extensions-older` directory.

[![Deploy Postgres with Extensions on Railway](https://railway.com/button.svg)](https://railway.com/deploy/postgresql-with-extensions?referralCode=7y-eBI)

---

> [!IMPORTANT]
> **Note on Volume Mount Point Change for PostgreSQL 18+**
>
> For images based on **PostgreSQL 18 or newer**, the volume mount point has been changed from `/var/lib/postgresql/data` to `/var/lib/postgresql`.
>
> - **PostgreSQL 18+**: Use `-v my-volume:/var/lib/postgresql`
> - **PostgreSQL 17 and older**: Use `-v my-volume:/var/lib/postgresql/data`
>
> Both Railway templates (Standard and With Extensions) use PostgreSQL 18 by default, so this note is especially relevant for users of that platform.

## How does it work?

This image uses a custom `wrapper.sh` script as its main `ENTRYPOINT` to add several powerful features on top of the official Postgres image.

The startup process is as follows:

1. The `wrapper.sh` script runs first.
2. It performs several checks:
   - **Environment Validation**: For Railway deployments, it verifies that volume mounts are set correctly to prevent data loss.
   - **Certificate Renewal**: It checks if the SSL certificate is missing, expired, or about to expire (within 30 days) and automatically regenerates it by calling `init-ssl.sh`.
3. It prepares the final `postgres` startup command, injecting `shared_preload_libraries` if they are defined.
4. Finally, it executes the original `docker-entrypoint.sh` script from the base Postgres image, which handles the standard database initialization.
5. If the database is being created for the first time, `docker-entrypoint.sh` will execute all scripts in `/docker-entrypoint-initdb.d`, including `init-ssl.sh` and `init-extensions.sh`, to set up SSL and enable extensions.

## Flexible Extension Management

This image simplifies PostgreSQL extension management by handling all necessary steps during the **build process** of your Docker image. This ensures a consistent and reproducible environment with all extensions pre-installed and enabled.

If you prefer, you can separate the installation of extension _packages_ (build-time) from the _enabling_ of extensions within the database (runtime) by omitting the `PG_DB_EXTENSIONS` and `PG_SHARED_PRELOAD_LIBRARIES` arguments during build and setting them as environment variables at runtime.

### Build-Time Arguments

Use these `ARG` variables when building your Docker image to install packages and enable extensions.

- `POSTGRES_VERSION`: Specifies the base PostgreSQL version to use when building the image. This overrides the default major version of the selected template folder (e.g., you can set it to `18.2` or `17.4`). **Warning:** Ensure the major version you specify matches the directory you are building from (`with-extensions` for 18+, `with-extensions-older` for 17 and older) to avoid volume mount path errors and validation failures.
- `PG_EXTENSION_REPOS`: A comma-separated list of APT repository URLs to add (e.g., `https://packagecloud.io/timescale/timescaledb/debian/ trixie main`).
- `PG_EXTENSION_REPO_KEYS`: A comma-separated list of GPG key URLs corresponding to `PG_EXTENSION_REPOS`.
- `PG_APT_PACKAGES`: A comma-separated list of APT package names for the extensions (e.g., `postgresql-18-postgis-3,timescaledb-2-postgresql-18`).
- `PG_DB_EXTENSIONS`: A comma-separated list of extension names to enable in the database (e.g., `postgis,pg_cron,timescaledb`).
- `PG_SHARED_PRELOAD_LIBRARIES`: A comma-separated list of shared libraries to preload (e.g., `timescaledb`).

### Example

To build an image with TimescaleDB and PostGIS, enable them, and preload `timescaledb`, all at build-time:

```bash
docker build . \
  --build-arg PG_EXTENSION_REPOS="https://packagecloud.io/timescale/timescaledb/debian/ trixie main" \
  --build-arg PG_EXTENSION_REPO_KEYS="https://packagecloud.io/timescale/timescaledb/gpgkey" \
  --build-arg PG_APT_PACKAGES="postgresql-18-postgis-3,timescaledb-2-postgresql-18" \
  --build-arg PG_DB_EXTENSIONS="postgis,timescaledb" \
  --build-arg PG_SHARED_PRELOAD_LIBRARIES="timescaledb" \
  -t my-postgres-with-extensions:latest
```

Then, you can run the container:

```bash
docker run -d \
  -e POSTGRES_DB=mydb \
  -e POSTGRES_USER=myuser \
  -e POSTGRES_PASSWORD=mypassword \
  -p 5432:5432 \
  my-postgres-with-extensions:latest
```

> [!WARNING]
> **Important Note for Custom Extensions:**
>
> To leverage the custom extension installation and enabling mechanism, you **must** build the image from source. You can use the **PostgreSQL with Custom Extensions** Railway template or build manually using the `Dockerfiles` provided within this repository (e.g., `with-extensions/Dockerfile`, or `with-extensions-older/Dockerfile`).
>
> Using pre-built images from the GitHub Container Registry (e.g., `ghcr.io/ncontiero/postgres-ssl:latest`) will **not** include your custom extensions, as those images are built without these build-time arguments.

## SSL Certificate Management

### Certificate Expiry

By default, the self-signed SSL certificate expiry is set to **820 days**. You can control this by passing the `SSL_CERT_DAYS` build argument.

### Automatic Certificate Renewal

The `wrapper.sh` entrypoint script automatically handles certificate renewal. On every container start, it checks if the certificate has expired or will expire within the next **30 days**. If so, it regenerates the certificate, ensuring uninterrupted SSL-encrypted connections. Because the configuration logic is idempotent, this process will not cause duplicate entries in `postgresql.conf`.

## Advanced Behavior & Platform Specifics

The `wrapper.sh` script includes some advanced logic to improve robustness, especially on platforms like Railway.

- **Railway Volume Validation**: On Railway, the wrapper verifies that `RAILWAY_VOLUME_MOUNT_PATH` is set to the expected path (which is `/var/lib/postgresql` for PostgreSQL 18+ or `/var/lib/postgresql/data` for older versions) and that the `PGDATA` variable is correctly located within this path. This prevents common misconfigurations that could lead to data loss.
- **`PGHOST` and `PGPORT` Unsetting**: Before initialization, the wrapper unsets the `PGHOST` and `PGPORT` environment variables. This is a Railway-specific fix to ensure tools like `psql` use the local Unix socket for connections during setup, avoiding conflicts with proxied connection variables.
- **`shared_preload_libraries` Injection**: If you provide `PG_SHARED_PRELOAD_LIBRARIES` as an environment variable (instead of a build argument), the wrapper script will dynamically inject it into the `postgres` startup command, ensuring the libraries are loaded even if they weren't configured in `postgresql.conf`.

## Available image tags

Images are automatically built weekly and tagged with multiple version levels
for flexibility:

- **Major version tags** (e.g., `:17`, `:16`, `:15`): Always points to the
  latest minor version for that major release
- **Minor version tags** (e.g., `:17.6`, `:16.10`): Pins to specific minor
  version for stability
- **Latest tag** (`:latest`): Currently points to PostgreSQL latest

Example usage:

```bash
# Auto-update to latest minor versions (recommended for development)
docker run ghcr.io/ncontiero/postgres-ssl:17

# Pin to specific minor version (recommended for production)
docker run ghcr.io/ncontiero/postgres-ssl:17.6
```

## References and inspirations

- <https://github.com/railwayapp-templates/postgres-ssl>

## License

This project is licensed under the **MIT** License - see the [LICENSE](./LICENSE) file for details
