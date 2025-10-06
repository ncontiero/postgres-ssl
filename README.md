# SSL-enabled Postgres DB image

This repository contains the logic to build SSL-enabled Postgres images.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/h1x7es?referralCode=7y-eBI)

> [!IMPORTANT]
> **Note on Volume Mount Point Change for PostgreSQL 18+**
>
> For images based on **PostgreSQL 18 or newer**, the volume mount point has been changed from `/var/lib/postgresql/data` to `/var/lib/postgresql`.
>
> - **PostgreSQL 18+**: Use `-v my-volume:/var/lib/postgresql`
> - **PostgreSQL 17 and older**: Use `-v my-volume:/var/lib/postgresql/data`
>
> The [Railway template](https://railway.com/deploy/h1x7es?referralCode=7y-eBI) uses version 18 by default, so this note is especially relevant for users of that platform.

## How does it work?

The Dockerfiles contained in this repository start with the official Postgres
image as base. Then the `init-ssl.sh` script is copied into the
`docker-entrypoint-initdb.d/` directory to be executed upon initialization.

## Certificate expiry

By default, the cert expiry is set to 820 days. You can control this by
configuring the `SSL_CERT_DAYS` environment variable as needed.

## Certificate renewal

When a redeploy or restart is done the certificates expiry is checked, if it has
expired or will expire in 30 days a new certificate is automatically generated.

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

## A note about ports

By default, this image is hardcoded to listen on port `5432` regardless of what
is set in the `PGPORT` environment variable. We did this to allow connections
to the postgres service over the `RAILWAY_TCP_PROXY_PORT`. If you need to
change this behavior, feel free to build your own image without passing the
`--port` parameter to the `CMD` command in the Dockerfile.

## References and inspirations

- <https://github.com/railwayapp-templates/postgres-ssl>

## License

This project is licensed under the **MIT** License - see the [LICENSE](./LICENSE) file for details
