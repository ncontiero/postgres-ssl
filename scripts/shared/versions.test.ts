import type { VersionsFile } from "./types";

import path from "node:path";
import { describe, expect, test } from "bun:test";
import { getVersionsFile } from "./versions";
import { VersionsValidationError } from "./versions-schema";

const validVersionsData: VersionsFile = {
  versions: [
    {
      postgres_version: "18.6",
      postgres_major_version: "18",
      is_latest: true,
      platforms: ["linux/amd64"],
    },
  ],
};

describe("getVersionsFile", () => {
  test("reads and validates the default versions path", async () => {
    let receivedPath = "";

    const result = await getVersionsFile({
      readJson: (filePath) => {
        receivedPath = filePath;
        return Promise.resolve(validVersionsData);
      },
    });

    expect(receivedPath).toBe(path.resolve(process.cwd(), "versions.json"));
    expect(result).toEqual({
      versionsData: validVersionsData,
      versionsPath: receivedPath,
    });
  });

  test("uses an explicitly configured versions path", async () => {
    const result = await getVersionsFile({
      readJson: () => Promise.resolve(validVersionsData),
      versionsPath: "/custom/versions.json",
    });

    expect(result.versionsPath).toBe("/custom/versions.json");
  });

  test("wraps read failures and preserves their cause", async () => {
    const readError = new Error("file not found");

    try {
      await getVersionsFile({
        readJson: () => Promise.reject(readError),
        versionsPath: "/missing/versions.json",
      });
      throw new Error("Expected getVersionsFile to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Failed to read versions.json: file not found",
      );
      expect((error as Error).cause).toBe(readError);
    }
  });

  test("wraps validation failures and preserves their cause", async () => {
    try {
      await getVersionsFile({
        readJson: () => Promise.resolve({ versions: [] }),
      });
      throw new Error("Expected getVersionsFile to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBeInstanceOf(VersionsValidationError);
    }
  });
});
