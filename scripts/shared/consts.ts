export const DOCKER_AUTH_API_URL =
  "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/postgres:pull";

export const DOCKER_REGISTRY_TAGS_API_URL =
  "https://registry-1.docker.io/v2/library/postgres/tags/list?n=1000";

// Regex to match "major.minor" formats (e.g., 16.1, 15.5) and avoid variants like "16-alpine".
export const VERSION_REGEX = /^[1-9]\d*\.\d+$/;
