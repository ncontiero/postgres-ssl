import type { VersionsFile } from "./types";

import path from "node:path";
import { readJsonFile } from "dkcutter/utils";
import { validateVersionsFile } from "./versions-schema";

export async function getVersionsFile(): Promise<{
  versionsData: VersionsFile;
  versionsPath: string;
}> {
  const versionsPath = path.resolve(process.cwd(), "versions.json");

  try {
    const rawVersionsData = await readJsonFile<unknown>(versionsPath);
    const versionsData = validateVersionsFile(rawVersionsData);
    return { versionsPath, versionsData };
  } catch (error) {
    throw new Error(
      `Failed to read versions.json: ${error instanceof Error ? error.message : error}`,
      { cause: error },
    );
  }
}
