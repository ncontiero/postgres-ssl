export const DOCKER_HUB_API_URL =
  "https://hub.docker.com/v2/repositories/library/postgres/tags/?page_size=100";

// Regex to match "major.minor" formats (e.g., 16.1, 15.5) and avoid variants like "16-alpine".
export const VERSION_REGEX = /^[1-9]\d*\.\d+$/;
