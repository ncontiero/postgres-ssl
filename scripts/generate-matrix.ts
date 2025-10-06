import fs from 'fs-extra';

import { logger } from "../hooks/utils/logger";

// The Docker Hub API endpoint for the official postgres image tags.
const DOCKER_HUB_API_URL =
  "https://hub.docker.com/v2/repositories/library/postgres/tags/?page_size=100";
const POSTGRES_MAJOR_VERSIONS = [13, 14, 15, 16, 17, 18];

/**
 * Interface for the Docker Hub API response for a single tag.
 */
interface DockerTag {
  name: string; 
}

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
function findLatestMinorVersion(
  majorVersion: number,
  tags: string[],
): string | null {
  // Regex to match "major.minor" formats (e.g., 16.1, 15.5) and avoid variants like "16-alpine".
  const versionRegex = /^[1-9]\d*\.\d+$/;

  const relevantVersions = tags
    .filter(
      (tag) => tag.startsWith(`${majorVersion}.`) && versionRegex.test(tag),
    )
    .sort((a, b) => {
      // Custom sort to handle version numbers correctly (e.g., 16.10 > 16.2)
      const aMinor = Number.parseInt(a.split(".")[1], 10);
      const bMinor = Number.parseInt(b.split(".")[1], 10);
      return bMinor - aMinor; // Sort in descending order
    });

  return relevantVersions.length > 0 ? relevantVersions[0] : null;
}

/**
 * Main function to generate the version matrix.
 */
async function generateMatrix() {
  logger.info(
    `Generating matrix for major versions: ${POSTGRES_MAJOR_VERSIONS.join(", ")}`,
  );

  const allTags = await getAllPostgresTags();
  if (allTags.length === 0) {
    logger.error("Could not fetch any tags. Aborting.");
    process.exit(1);
  }

  const finalVersions: string[] = [];

  for (const major of POSTGRES_MAJOR_VERSIONS) {
    const latestVersion = findLatestMinorVersion(major, allTags);
    if (latestVersion) {
      finalVersions.push(latestVersion);
      logger.info(`Found latest minor for major ${major}: ${latestVersion}`);
    } else {
      logger.warn(`Could not find any minor version for major ${major}.`);
    }
  }

  finalVersions.push("latest");
  logger.info(`Final version matrix: [${finalVersions.join(", ")}]`);

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (!githubOutput) {
    logger.error(
      "GITHUB_OUTPUT environment variable not set. Skipping output."
    );
    process.exit(1);
  }

  const outputJson = JSON.stringify(finalVersions);
  await fs.appendFile(githubOutput, `versions=${outputJson}\n`);
}

generateMatrix();
