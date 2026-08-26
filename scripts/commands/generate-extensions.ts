import { dkcutter } from "dkcutter";
import { logger } from "dkcutter/utils";
import { getVersionsFile } from "../shared/versions";

interface GenerateExtensionsOptions {
  generateTemplate?: typeof dkcutter;
  readVersions?: typeof getVersionsFile;
  templateDirectory?: string;
}

export async function generateExtensions(
  options: GenerateExtensionsOptions = {},
): Promise<void> {
  const {
    generateTemplate = dkcutter,
    readVersions = getVersionsFile,
    templateDirectory = process.cwd(),
  } = options;

  logger.info("Reading versions.json to generate extension templates...");
  const { versionsData } = await readVersions();

  for (const version of versionsData.versions) {
    if (!version.extension_template) continue;

    logger.info(
      `Generating template '${version.extension_template}' for Postgres ${version.postgres_version}`,
    );

    await generateTemplate({
      template: templateDirectory,
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
