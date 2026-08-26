import fs from "node:fs/promises";
import { logger } from "dkcutter/utils";
import { getVersionsFile } from "../shared/versions";

type AppendFile = (filePath: string, data: string) => Promise<void>;
interface CommandLogger {
  info: (message: string) => void;
}

interface GenerateMatrixOptions {
  appendFile?: AppendFile;
  commandLogger?: CommandLogger;
  outputPath?: string;
  readVersions?: typeof getVersionsFile;
}

export async function generateMatrix(
  options: GenerateMatrixOptions = {},
): Promise<void> {
  const {
    appendFile = fs.appendFile,
    commandLogger = logger,
    outputPath = process.env.GITHUB_OUTPUT,
    readVersions = getVersionsFile,
  } = options;

  commandLogger.info("Reading versions.json to generate matrix...");
  const { versionsData } = await readVersions();

  commandLogger.info(
    `Found versions: ${versionsData.versions.map((version) => version.postgres_version).join(", ")}.`,
  );

  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT environment variable is not set");
  }

  const outputJson = JSON.stringify(versionsData.versions);
  await appendFile(outputPath, `versions=${outputJson}\n`);
}
