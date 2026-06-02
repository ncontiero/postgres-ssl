import { dkcutter } from "dkcutter";
import { logger } from "dkcutter/utils";
import { getVersionsFile } from "./versions";

async function generateExtensions() {
  logger.info("Reading versions.json to generate extension templates...");

  try {
    const { versionsData } = await getVersionsFile();

    for (const version of versionsData.versions) {
      if (version.extension_template) {
        logger.info(
          `Generating template '${version.extension_template}' for Postgres ${version.postgres_version}`,
        );

        await dkcutter({
          template: process.cwd(),
          options: {
            default: true,
            overwrite: true,
          },
          extraContext: {
            postgresVersion: version.postgres_version,
            outputImageSlug: version.extension_template,
          },
        });
      }
    }
  } catch (error) {
    logger.error(
      `Failed to generate extension templates: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }
}

generateExtensions();
