import fs from "node:fs/promises";
import { logger } from "dkcutter/utils";
import { getVersionsFile } from "./versions";

async function generateMatrix() {
  logger.info("Reading versions.json to generate matrix...");

  try {
    const { versionsData: data } = await getVersionsFile();

    logger.info(
      `Found versions: ${data.versions.map((v) => `${v.postgres_version}`).join(", ")}.`,
    );

    const githubOutput = process.env.GITHUB_OUTPUT;
    if (!githubOutput) {
      logger.error(
        "GITHUB_OUTPUT environment variable not set. Skipping output.",
      );
      process.exit(1);
    }

    const outputJson = JSON.stringify(data.versions);
    await fs.appendFile(githubOutput, `versions=${outputJson}\n`);
  } catch (error) {
    logger.error(
      `Failed to generate matrix: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }
}

generateMatrix();
