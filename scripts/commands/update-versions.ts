import { logger, writeJsonFile } from "dkcutter/utils";
import { updateVersionEntries } from "../domain/version-updates";
import {
  DOCKER_AUTH_API_URL,
  DOCKER_REGISTRY_TAGS_API_URL,
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

export async function updateVersions(): Promise<void> {
  const { versionsData, versionsPath } = await getVersionsFile();

  const allTags = await getAllPostgresTags();
  if (allTags.length === 0) {
    throw new Error("Could not fetch any tags");
  }

  const result = updateVersionEntries(versionsData, allTags);

  for (const change of result.changes) {
    logger.info(
      `Updating major ${change.majorVersion} from ${change.previousVersion} to ${change.nextVersion}`,
    );
  }

  for (const majorVersion of result.missingMajors) {
    logger.warn(`Could not find any minor version for major ${majorVersion}.`);
  }

  for (const downgrade of result.ignoredDowngrades) {
    logger.warn(
      `Ignoring downgrade for major ${downgrade.majorVersion} from ${downgrade.currentVersion} to ${downgrade.registryVersion}`,
    );
  }

  if (result.changes.length > 0) {
    await writeJsonFile(versionsPath, result.versionsData);
    logger.info("versions.json updated successfully.");
  } else {
    logger.info("No updates found for versions.json.");
  }
}
