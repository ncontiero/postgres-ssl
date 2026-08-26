import type { VersionsFile } from "./types";

import path from "node:path";
import { readJsonFile } from "dkcutter/utils";
import { validateVersionsFile } from "./versions-schema";

type ReadJson = (filePath: string) => Promise<unknown>;

interface GetVersionsFileOptions {
  readJson?: ReadJson;
  versionsPath?: string;
}

export async function getVersionsFile(
  options: GetVersionsFileOptions = {},
): Promise<{
  versionsData: VersionsFile;
  versionsPath: string;
}> {
  const {
    readJson = (filePath) => readJsonFile<unknown>(filePath),
    versionsPath = path.resolve(process.cwd(), "versions.json"),
  } = options;

  try {
    const rawVersionsData = await readJson(versionsPath);
    const versionsData = validateVersionsFile(rawVersionsData);
    return { versionsPath, versionsData };
  } catch (error) {
    throw new Error(
      `Failed to read versions.json: ${error instanceof Error ? error.message : error}`,
      { cause: error },
    );
  }
}
