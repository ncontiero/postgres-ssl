import type { VersionsFile } from "./types";

import path from "node:path";
import { logger, readJsonFile } from "dkcutter/utils";

export async function getVersionsFile() {
  const versionsPath = path.resolve(process.cwd(), "versions.json");

  try {
    const versionsData = await readJsonFile<VersionsFile>(versionsPath);
    return { versionsPath, versionsData };
  } catch (error) {
    logger.error(
      `Failed to read versions.json: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }
}
