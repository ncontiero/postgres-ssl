import type { DockerTag } from "./types";
import { logger, writeJsonFile } from "dkcutter/utils";
import { DOCKER_HUB_API_URL, VERSION_REGEX } from "./consts";
import { getVersionsFile } from "./versions";

/**
 * Fetches all tags from the Docker Hub for the official postgres image.
 * It handles pagination automatically.
 * @returns A promise that resolves to an array of tag names.
 */
async function getAllPostgresTags(): Promise<string[]> {
  const allTags: string[] = [];
  let url: string | null = DOCKER_HUB_API_URL;

  logger.info("Fetching all tags from Docker Hub...");

  try {
    while (url) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch tags: ${response.statusText}`);
      }

      const data: any = await response.json();
      const tags: DockerTag[] = data?.results || [];
      tags.forEach((tag) => allTags.push(tag.name));
      url = data.next; // Move to the next page if it exists
    }

    logger.info(`Successfully fetched ${allTags.length} total tags.`);
    return allTags;
  } catch (error) {
    logger.error(
      `Error fetching tags: ${error instanceof Error ? error.message : error}`,
    );
    return []; // Return empty array on failure
  }
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

async function updateVersions() {
  const { versionsData, versionsPath } = await getVersionsFile();

  const allTags = await getAllPostgresTags();
  if (allTags.length === 0) {
    logger.error("Could not fetch any tags. Aborting.");
    process.exit(1);
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

updateVersions();
