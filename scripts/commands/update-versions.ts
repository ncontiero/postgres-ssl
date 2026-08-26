import { logger, writeJsonFile } from "dkcutter/utils";
import {
  DOCKER_AUTH_API_URL,
  DOCKER_REGISTRY_TAGS_API_URL,
  VERSION_REGEX,
} from "../shared/consts";
import { getVersionsFile } from "../shared/versions";

interface DockerAuthResponse {
  token?: string;
  access_token?: string;
}

interface DockerRegistryTagsResponse {
  tags?: string[];
}

type Fetch = typeof globalThis.fetch;
const NEXT_LINK_REGEX = /;\s*rel="?next"?\s*$/i;
const LINK_URL_REGEX = /^\s*<([^>]+)>/;

function getNextPageUrl(response: Response, currentUrl: string): string | null {
  const link = response.headers.get("link");
  if (!link) return null;

  const nextLink = link.split(",").find((item) => NEXT_LINK_REGEX.test(item));
  const match = nextLink?.match(LINK_URL_REGEX);

  return match ? new URL(match[1], currentUrl).toString() : null;
}

async function getRegistryToken(fetcher: Fetch): Promise<string> {
  const response = await fetcher(DOCKER_AUTH_API_URL, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to authenticate with Docker Registry: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as DockerAuthResponse;
  const token = data.token ?? data.access_token;
  if (!token) {
    throw new Error(
      "Docker Registry authentication response did not include a token",
    );
  }

  return token;
}

/**
 * Fetches all tags from the Docker Registry for the official postgres image.
 * It handles pagination automatically.
 * @returns A promise that resolves to an array of tag names.
 */
export async function getAllPostgresTags(
  fetcher: Fetch = globalThis.fetch,
): Promise<string[]> {
  const allTags: string[] = [];
  let url: string | null = DOCKER_REGISTRY_TAGS_API_URL;

  logger.info("Fetching all tags from Docker Registry...");
  const token = await getRegistryToken(fetcher);

  while (url) {
    const currentUrl = url;
    const response = await fetcher(currentUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch tags: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as DockerRegistryTagsResponse;
    allTags.push(...(data.tags ?? []));
    url = getNextPageUrl(response, currentUrl);
  }

  logger.info(`Successfully fetched ${allTags.length} total tags.`);
  return allTags;
}

/**
 * Finds the latest minor version for a given major version from a list of tags.
 * @param majorVersion The major version to look for.
 * @param tags A list of all available version tags (e.g., ["16.1", "16.2", "15.5"]).
 * @returns The latest version string (e.g., "16.2") or null if no version is found.
 */
export function findLatestMinorVersion(
  majorVersion: number,
  tags: string[],
): string | null {
  const relevantVersions = tags
    .filter(
      (tag) => tag.startsWith(`${majorVersion}.`) && VERSION_REGEX.test(tag),
    )
    .sort((a, b) => {
      // Custom sort to handle version numbers correctly (e.g., 16.10 > 16.2)
      const aMinor = Number.parseInt(a.split(".")[1], 10);
      const bMinor = Number.parseInt(b.split(".")[1], 10);
      return bMinor - aMinor; // Sort in descending order
    });

  return relevantVersions.length > 0 ? relevantVersions[0] : null;
}

export async function updateVersions() {
  const { versionsData, versionsPath } = await getVersionsFile();

  const allTags = await getAllPostgresTags();
  if (allTags.length === 0) {
    throw new Error("Could not fetch any tags");
  }

  let updated = false;

  for (const entry of versionsData.versions) {
    const currentVersion = entry.postgres_version;
    const majorVersion = Number.parseInt(currentVersion.split(".")[0], 10);

    const latestVersion = findLatestMinorVersion(majorVersion, allTags);
    if (latestVersion && latestVersion !== currentVersion) {
      logger.info(
        `Updating major ${majorVersion} from ${currentVersion} to ${latestVersion}`,
      );
      entry.postgres_version = latestVersion;
      updated = true;
    } else if (latestVersion) {
      logger.info(
        `Major ${majorVersion} is already up to date (${currentVersion})`,
      );
    } else {
      logger.warn(
        `Could not find any minor version for major ${majorVersion}.`,
      );
    }
  }

  if (updated) {
    await writeJsonFile(versionsPath, versionsData);
    logger.info("versions.json updated successfully.");
  } else {
    logger.info("No updates found for versions.json.");
  }
}
