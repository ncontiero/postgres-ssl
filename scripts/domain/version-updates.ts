import type { VersionEntry, VersionsFile } from "../shared/types";
import { VERSION_REGEX } from "../shared/consts";

export interface VersionChange {
  majorVersion: string;
  nextVersion: string;
  previousVersion: string;
}

export interface IgnoredDowngrade {
  currentVersion: string;
  majorVersion: string;
  registryVersion: string;
}

export interface VersionUpdateResult {
  changes: VersionChange[];
  ignoredDowngrades: IgnoredDowngrade[];
  missingMajors: string[];
  versionsData: VersionsFile;
}

function comparePostgresVersions(left: string, right: string): number {
  const [leftMajor, leftMinor] = left.split(".").map(Number);
  const [rightMajor, rightMinor] = right.split(".").map(Number);

  return leftMajor - rightMajor || leftMinor - rightMinor;
}

function cloneVersionEntry(entry: VersionEntry): VersionEntry {
  return {
    ...entry,
    platforms: [...entry.platforms],
  };
}

/**
 * Finds the latest minor version for a major from official image tags.
 */
export function findLatestMinorVersion(
  majorVersion: number,
  tags: string[],
): string | null {
  let latestVersion: string | null = null;

  for (const tag of tags) {
    if (!tag.startsWith(`${majorVersion}.`) || !VERSION_REGEX.test(tag)) {
      continue;
    }

    if (
      latestVersion === null ||
      comparePostgresVersions(tag, latestVersion) > 0
    ) {
      latestVersion = tag;
    }
  }

  return latestVersion;
}

/**
 * Calculates version updates without mutating either input.
 */
export function updateVersionEntries(
  versionsData: VersionsFile,
  tags: string[],
): VersionUpdateResult {
  const changes: VersionChange[] = [];
  const ignoredDowngrades: IgnoredDowngrade[] = [];
  const missingMajors: string[] = [];

  const versions = versionsData.versions.map((entry) => {
    const updatedEntry = cloneVersionEntry(entry);
    const majorVersion = entry.postgres_major_version;
    const latestVersion = findLatestMinorVersion(Number(majorVersion), tags);

    if (latestVersion === null) {
      missingMajors.push(majorVersion);
      return updatedEntry;
    }

    const comparison = comparePostgresVersions(
      latestVersion,
      entry.postgres_version,
    );

    if (comparison < 0) {
      ignoredDowngrades.push({
        currentVersion: entry.postgres_version,
        majorVersion,
        registryVersion: latestVersion,
      });
      return updatedEntry;
    }

    if (comparison === 0) return updatedEntry;

    changes.push({
      majorVersion,
      nextVersion: latestVersion,
      previousVersion: entry.postgres_version,
    });
    updatedEntry.postgres_version = latestVersion;
    return updatedEntry;
  });

  return {
    changes,
    ignoredDowngrades,
    missingMajors,
    versionsData: { versions },
  };
}
