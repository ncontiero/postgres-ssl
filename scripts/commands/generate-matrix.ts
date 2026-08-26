import fs from "node:fs/promises";
import { logger } from "dkcutter/utils";
import { getVersionsFile } from "../shared/versions";

interface GenerateMatrixOptions {
  appendFile?: typeof fs.appendFile;
  outputPath?: string;
  readVersions?: typeof getVersionsFile;
}

export async function generateMatrix(
  options: GenerateMatrixOptions = {},
): Promise<void> {
  const {
    appendFile = fs.appendFile,
    outputPath = process.env.GITHUB_OUTPUT,
    readVersions = getVersionsFile,
  } = options;

  logger.info("Reading versions.json to generate matrix...");
  const { versionsData } = await readVersions();

  logger.info(
    `Found versions: ${versionsData.versions.map((version) => version.postgres_version).join(", ")}.`,
  );

  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT environment variable is not set");
  }

  const outputJson = JSON.stringify(versionsData.versions);
  await appendFile(outputPath, `versions=${outputJson}\n`);
}
