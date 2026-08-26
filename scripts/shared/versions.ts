import type { VersionsFile } from "./types";

import path from "node:path";
import { readJsonFile } from "dkcutter/utils";

export async function getVersionsFile(): Promise<{
  versionsData: VersionsFile;
  versionsPath: string;
}> {
  const versionsPath = path.resolve(process.cwd(), "versions.json");

  try {
    const versionsData = await readJsonFile<VersionsFile>(versionsPath);
    return { versionsPath, versionsData };
  } catch (error) {
    throw new Error(
      `Failed to read versions.json: ${error instanceof Error ? error.message : error}`,
      { cause: error },
    );
  }
}
