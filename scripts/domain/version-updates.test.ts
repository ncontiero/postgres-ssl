import type { VersionsFile } from "../shared/types";

import { describe, expect, test } from "bun:test";
import {
  findLatestMinorVersion,
  updateVersionEntries,
} from "./version-updates";

function createVersionsFile(): VersionsFile {
  return {
    versions: [
      {
        postgres_version: "18.4",
        postgres_major_version: "18",
        is_latest: true,
        extension_template: "with-extensions",
        platforms: ["linux/amd64", "linux/arm64"],
      },
      {
        postgres_version: "17.10",
        postgres_major_version: "17",
        is_latest: false,
        extension_template: "with-extensions-older",
        platforms: ["linux/amd64", "linux/arm64"],
      },
    ],
  };
}

describe("findLatestMinorVersion", () => {
  test("returns the latest minor version using numerical order", () => {
    expect(findLatestMinorVersion(18, ["18.1", "18.2", "18.10", "18.3"])).toBe(
      "18.10",
    );
  });

  test("ignores suffixes and invalid formats", () => {
    expect(
      findLatestMinorVersion(18, [
        "18.1",
        "18.2",
        "18.2-alpine",
        "18.rc1",
        "18-bullseye",
      ]),
    ).toBe("18.2");
  });

  test("returns null when the major version is absent", () => {
    expect(findLatestMinorVersion(18, ["17.1", "16.5"])).toBeNull();
  });
});

describe("updateVersionEntries", () => {
  test("updates multiple majors and reports structured changes", () => {
    const result = updateVersionEntries(createVersionsFile(), [
      "18.5",
      "17.11",
    ]);

    expect(
      result.versionsData.versions.map((entry) => entry.postgres_version),
    ).toEqual(["18.5", "17.11"]);
    expect(result.changes).toEqual([
      {
        majorVersion: "18",
        nextVersion: "18.5",
        previousVersion: "18.4",
      },
      {
        majorVersion: "17",
        nextVersion: "17.11",
        previousVersion: "17.10",
      },
    ]);
    expect(result.missingMajors).toEqual([]);
    expect(result.ignoredDowngrades).toEqual([]);
  });

  test("prevents downgrades and reports the ignored candidate", () => {
    const versionsData = createVersionsFile();
    const result = updateVersionEntries(versionsData, ["18.3", "17.10"]);

    expect(result.versionsData.versions[0].postgres_version).toBe("18.4");
    expect(result.changes).toEqual([]);
    expect(result.ignoredDowngrades).toEqual([
      {
        currentVersion: "18.4",
        majorVersion: "18",
        registryVersion: "18.3",
      },
    ]);
  });

  test("reports majors without corresponding tags", () => {
    const result = updateVersionEntries(createVersionsFile(), ["18.4"]);

    expect(result.missingMajors).toEqual(["17"]);
    expect(result.changes).toEqual([]);
  });

  test("does not mutate inputs and preserves all entry metadata", () => {
    const versionsData = createVersionsFile();
    const originalVersions = structuredClone(versionsData);
    const tags = ["18.5", "17.10", "18.5-alpine"];
    const originalTags = [...tags];

    const result = updateVersionEntries(versionsData, tags);

    expect(versionsData).toEqual(originalVersions);
    expect(tags).toEqual(originalTags);
    expect(result.versionsData).not.toBe(versionsData);
    expect(result.versionsData.versions[0]).not.toBe(versionsData.versions[0]);
    expect(result.versionsData.versions[0].platforms).not.toBe(
      versionsData.versions[0].platforms,
    );
    expect(result.versionsData.versions[0]).toMatchObject({
      extension_template: "with-extensions",
      is_latest: true,
      platforms: ["linux/amd64", "linux/arm64"],
      postgres_major_version: "18",
      postgres_version: "18.5",
    });
  });
});
