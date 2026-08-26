import type { VersionsFile } from "../shared/types";

import { describe, expect, test } from "bun:test";
import { generateMatrix } from "./generate-matrix";

const versionsData: VersionsFile = {
  versions: [
    {
      postgres_version: "18.6",
      postgres_major_version: "18",
      is_latest: true,
      platforms: ["linux/amd64", "linux/arm64"],
    },
  ],
};

const commandLogger = { info: () => {} };
const readVersions = () =>
  Promise.resolve({ versionsData, versionsPath: "/project/versions.json" });

describe("generateMatrix", () => {
  test("writes the versions matrix to the configured GitHub output", async () => {
    const writes: Array<{ data: string; path: string }> = [];

    await generateMatrix({
      appendFile: (path, data) => {
        writes.push({ data, path });
        return Promise.resolve();
      },
      commandLogger,
      outputPath: "/tmp/github-output",
      readVersions,
    });

    expect(writes).toEqual([
      {
        data: `versions=${JSON.stringify(versionsData.versions)}\n`,
        path: "/tmp/github-output",
      },
    ]);
  });

  test("rejects when the GitHub output path is absent", async () => {
    await expect(
      generateMatrix({
        commandLogger,
        outputPath: "",
        readVersions,
      }),
    ).rejects.toThrow("GITHUB_OUTPUT environment variable is not set");
  });

  test("propagates read and write failures", async () => {
    const readError = new Error("read failed");
    await expect(
      generateMatrix({
        commandLogger,
        outputPath: "/tmp/github-output",
        readVersions: () => Promise.reject(readError),
      }),
    ).rejects.toBe(readError);

    const writeError = new Error("write failed");
    await expect(
      generateMatrix({
        appendFile: () => Promise.reject(writeError),
        commandLogger,
        outputPath: "/tmp/github-output",
        readVersions,
      }),
    ).rejects.toBe(writeError);
  });
});
