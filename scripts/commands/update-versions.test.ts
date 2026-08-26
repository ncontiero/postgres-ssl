import type { VersionsFile } from "../shared/types";

import { describe, expect, test } from "bun:test";
import { updateVersions } from "./update-versions";

function createVersionsData(): VersionsFile {
  return {
    versions: [
      {
        postgres_version: "18.4",
        postgres_major_version: "18",
        is_latest: true,
        platforms: ["linux/amd64"],
      },
      {
        postgres_version: "17.10",
        postgres_major_version: "17",
        is_latest: false,
        platforms: ["linux/amd64"],
      },
    ],
  };
}

function createLogger() {
  const info: string[] = [];
  const warn: string[] = [];

  return {
    commandLogger: {
      info: (message: string) => info.push(message),
      warn: (message: string) => warn.push(message),
    },
    info,
    warn,
  };
}

describe("updateVersions", () => {
  test("writes the updated configuration once when versions change", async () => {
    const versionsData = createVersionsData();
    const writes: Array<{ data: VersionsFile; path: string }> = [];
    const { commandLogger, info } = createLogger();

    await updateVersions({
      commandLogger,
      fetchTags: () => Promise.resolve(["18.5", "17.11"]),
      readVersions: () =>
        Promise.resolve({
          versionsData,
          versionsPath: "/project/versions.json",
        }),
      writeVersions: (path, data) => {
        writes.push({ data, path });
        return Promise.resolve();
      },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("/project/versions.json");
    expect(
      writes[0].data.versions.map((entry) => entry.postgres_version),
    ).toEqual(["18.5", "17.11"]);
    expect(
      versionsData.versions.map((entry) => entry.postgres_version),
    ).toEqual(["18.4", "17.10"]);
    expect(info).toContain("versions.json updated successfully.");
  });

  test("does not write when every version is current", async () => {
    let writes = 0;
    const { commandLogger, info } = createLogger();

    await updateVersions({
      commandLogger,
      fetchTags: () => Promise.resolve(["18.4", "17.10"]),
      readVersions: () =>
        Promise.resolve({
          versionsData: createVersionsData(),
          versionsPath: "/project/versions.json",
        }),
      writeVersions: () => {
        writes += 1;
        return Promise.resolve();
      },
    });

    expect(writes).toBe(0);
    expect(info).toContain("No updates found for versions.json.");
  });

  test("rejects an empty tag list and propagates Registry failures", async () => {
    const { commandLogger } = createLogger();
    const readVersions = () =>
      Promise.resolve({
        versionsData: createVersionsData(),
        versionsPath: "/project/versions.json",
      });

    await expect(
      updateVersions({
        commandLogger,
        fetchTags: () => Promise.resolve([]),
        readVersions,
      }),
    ).rejects.toThrow("Could not fetch any tags");

    const registryError = new Error("Registry unavailable");
    await expect(
      updateVersions({
        commandLogger,
        fetchTags: () => Promise.reject(registryError),
        readVersions,
      }),
    ).rejects.toBe(registryError);
  });

  test("logs missing majors and ignored downgrades", async () => {
    const { commandLogger, warn } = createLogger();

    await updateVersions({
      commandLogger,
      fetchTags: () => Promise.resolve(["18.3"]),
      readVersions: () =>
        Promise.resolve({
          versionsData: createVersionsData(),
          versionsPath: "/project/versions.json",
        }),
    });

    expect(warn).toEqual([
      "Could not find any minor version for major 17.",
      "Ignoring downgrade for major 18 from 18.4 to 18.3",
    ]);
  });
});
