import { type DKCutter, dkcutter } from "dkcutter";
import { logger } from "dkcutter/utils";
import { getVersionsFile } from "../shared/versions";

type GenerateTemplate = (options: DKCutter) => Promise<unknown>;
interface CommandLogger {
  info: (message: string) => void;
}

interface GenerateExtensionsOptions {
  commandLogger?: CommandLogger;
  generateTemplate?: GenerateTemplate;
  readVersions?: typeof getVersionsFile;
  templateDirectory?: string;
}

export async function generateExtensions(
  options: GenerateExtensionsOptions = {},
): Promise<void> {
  const {
    commandLogger = logger,
    generateTemplate = dkcutter,
    readVersions = getVersionsFile,
    templateDirectory = process.cwd(),
  } = options;

  commandLogger.info(
    "Reading versions.json to generate extension templates...",
  );
  const { versionsData } = await readVersions();

  for (const version of versionsData.versions) {
    if (!version.extension_template) continue;

    commandLogger.info(
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
