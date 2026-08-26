import type { DKCutter } from "dkcutter";
import type { VersionsFile } from "../shared/types";

import { describe, expect, test } from "bun:test";
import { generateExtensions } from "./generate-extensions";

function createVersionsData(): VersionsFile {
  return {
    versions: [
      {
        postgres_version: "18.6",
        postgres_major_version: "18",
        is_latest: true,
        extension_template: "with-extensions",
        platforms: ["linux/amd64"],
      },
      {
        postgres_version: "17.11",
        postgres_major_version: "17",
        is_latest: false,
        platforms: ["linux/amd64"],
      },
      {
        postgres_version: "16.15",
        postgres_major_version: "16",
        is_latest: false,
        extension_template: "with-extensions-older",
        platforms: ["linux/amd64"],
      },
    ],
  };
}

const commandLogger = { info: () => {} };

describe("generateExtensions", () => {
  test("generates only configured templates in versions order", async () => {
    const generatedTemplates: DKCutter[] = [];
    const versionsData = createVersionsData();

    await generateExtensions({
      commandLogger,
      generateTemplate: (options) => {
        generatedTemplates.push(options);
        return Promise.resolve({});
      },
      readVersions: () =>
        Promise.resolve({
          versionsData,
          versionsPath: "/project/versions.json",
        }),
      templateDirectory: "/project",
    });

    expect(generatedTemplates).toEqual([
      {
        extraContext: {
          outputImageSlug: "with-extensions",
          postgresVersion: "18.6",
        },
        options: { default: true, overwrite: true },
        template: "/project",
      },
      {
        extraContext: {
          outputImageSlug: "with-extensions-older",
          postgresVersion: "16.15",
        },
        options: { default: true, overwrite: true },
        template: "/project",
      },
    ]);
  });

  test("does not generate anything without extension templates", async () => {
    const versionsData = createVersionsData();
    versionsData.versions.forEach((version) => {
      delete version.extension_template;
    });
    let calls = 0;

    await generateExtensions({
      commandLogger,
      generateTemplate: () => {
        calls += 1;
        return Promise.resolve({});
      },
      readVersions: () =>
        Promise.resolve({
          versionsData,
          versionsPath: "/project/versions.json",
        }),
    });

    expect(calls).toBe(0);
  });

  test("propagates template generation failures", async () => {
    const generationError = new Error("generation failed");

    await expect(
      generateExtensions({
        commandLogger,
        generateTemplate: () => Promise.reject(generationError),
        readVersions: () =>
          Promise.resolve({
            versionsData: createVersionsData(),
            versionsPath: "/project/versions.json",
          }),
      }),
    ).rejects.toBe(generationError);
  });
});
