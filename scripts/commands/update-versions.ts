import { logger, writeJsonFile } from "dkcutter/utils";
import { updateVersionEntries } from "../domain/version-updates";
import { getAllPostgresTags } from "../infrastructure/docker-registry";
import { getVersionsFile } from "../shared/versions";

export async function updateVersions(): Promise<void> {
  const { versionsData, versionsPath } = await getVersionsFile();

  logger.info("Fetching all tags from Docker Registry...");
  const allTags = await getAllPostgresTags();
  logger.info(`Successfully fetched ${allTags.length} total tags.`);
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
