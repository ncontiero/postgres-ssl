import type { VersionsFile } from "../shared/types";

import { logger, writeJsonFile } from "dkcutter/utils";
import { updateVersionEntries } from "../domain/version-updates";
import { getAllPostgresTags } from "../infrastructure/docker-registry";
import { getVersionsFile } from "../shared/versions";

interface CommandLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

interface UpdateVersionsOptions {
  commandLogger?: CommandLogger;
  fetchTags?: typeof getAllPostgresTags;
  readVersions?: typeof getVersionsFile;
  writeVersions?: (path: string, data: VersionsFile) => Promise<void>;
}

export async function updateVersions(
  options: UpdateVersionsOptions = {},
): Promise<void> {
  const {
    commandLogger = logger,
    fetchTags = getAllPostgresTags,
    readVersions = getVersionsFile,
    writeVersions = writeJsonFile,
  } = options;
  const { versionsData, versionsPath } = await readVersions();

  commandLogger.info("Fetching all tags from Docker Registry...");
  const allTags = await fetchTags();
  commandLogger.info(`Successfully fetched ${allTags.length} total tags.`);
  if (allTags.length === 0) {
    throw new Error("Could not fetch any tags");
  }

  const result = updateVersionEntries(versionsData, allTags);

  for (const change of result.changes) {
    commandLogger.info(
      `Updating major ${change.majorVersion} from ${change.previousVersion} to ${change.nextVersion}`,
    );
  }

  for (const majorVersion of result.missingMajors) {
    commandLogger.warn(
      `Could not find any minor version for major ${majorVersion}.`,
    );
  }

  for (const downgrade of result.ignoredDowngrades) {
    commandLogger.warn(
      `Ignoring downgrade for major ${downgrade.majorVersion} from ${downgrade.currentVersion} to ${downgrade.registryVersion}`,
    );
  }

  if (result.changes.length > 0) {
    await writeVersions(versionsPath, result.versionsData);
    commandLogger.info("versions.json updated successfully.");
  } else {
    commandLogger.info("No updates found for versions.json.");
  }
}
