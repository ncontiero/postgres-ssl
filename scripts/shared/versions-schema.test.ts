import type { VersionsFile } from "./types";

import { describe, expect, test } from "bun:test";
import {
  validateVersionsFile,
  VersionsValidationError,
} from "./versions-schema";

function createValidVersionsFile(): VersionsFile {
  return {
    versions: [
      {
        postgres_version: "18.6",
        postgres_major_version: "18",
        is_latest: true,
        extension_template: "with-extensions",
        platforms: ["linux/amd64", "linux/arm64"],
      },
      {
        postgres_version: "17.11",
        postgres_major_version: "17",
        is_latest: false,
        extension_template: "with-extensions-older",
        platforms: ["linux/amd64", "linux/arm64/v8"],
      },
    ],
  };
}

function expectValidationIssue(value: unknown, issue: string): void {
  expect(() => validateVersionsFile(value)).toThrow(issue);
}

describe("validateVersionsFile", () => {
  test("accepts a valid versions file", () => {
    const versionsFile = createValidVersionsFile();

    expect(validateVersionsFile(versionsFile)).toBe(versionsFile);
  });

  test("requires a non-empty versions array", () => {
    expectValidationIssue({}, "versions must be a non-empty array");
    expectValidationIssue(
      { versions: [] },
      "versions must be a non-empty array",
    );
  });

  test("validates required entry fields and their types", () => {
    expectValidationIssue(
      { versions: [{}] },
      "versions[0].postgres_version must be a string",
    );
    expectValidationIssue(
      { versions: [null] },
      "versions[0] must be an object",
    );
  });

  test("validates version formats and matching major versions", () => {
    const invalidFormat = createValidVersionsFile();
    invalidFormat.versions[0].postgres_version = "18-alpine";
    expectValidationIssue(
      invalidFormat,
      "versions[0].postgres_version must use the major.minor format",
    );

    const mismatchedMajor = createValidVersionsFile();
    mismatchedMajor.versions[0].postgres_major_version = "17";
    expectValidationIssue(
      mismatchedMajor,
      "versions[0].postgres_major_version must match postgres_version '18.6'",
    );
  });

  test("requires exactly one latest entry for the highest major version", () => {
    const noLatest = createValidVersionsFile();
    noLatest.versions[0].is_latest = false;
    expectValidationIssue(
      noLatest,
      "versions must contain exactly one entry with is_latest set to true",
    );

    const wrongLatest = createValidVersionsFile();
    wrongLatest.versions[0].is_latest = false;
    wrongLatest.versions[1].is_latest = true;
    expectValidationIssue(
      wrongLatest,
      "versions[1].is_latest must identify the highest configured major version",
    );
  });

  test("rejects duplicate majors and extension templates", () => {
    const duplicateValues = createValidVersionsFile();
    duplicateValues.versions[1].postgres_version = "18.5";
    duplicateValues.versions[1].postgres_major_version = "18";
    duplicateValues.versions[1].extension_template = "with-extensions";

    expect(() => validateVersionsFile(duplicateValues)).toThrow(
      VersionsValidationError,
    );
    expectValidationIssue(
      duplicateValues,
      "versions[1].postgres_major_version duplicates major '18'",
    );
    expectValidationIssue(
      duplicateValues,
      "versions[1].extension_template duplicates 'with-extensions'",
    );
  });

  test("validates platforms and template names", () => {
    const invalidValues = createValidVersionsFile();
    invalidValues.versions[0].platforms = ["amd64", "amd64"];
    invalidValues.versions[0].extension_template = "";

    expectValidationIssue(
      invalidValues,
      "versions[0].platforms[0] must be a valid os/architecture platform",
    );
    expectValidationIssue(
      invalidValues,
      "versions[0].extension_template must be a valid template name",
    );

    const duplicatePlatform = createValidVersionsFile();
    duplicatePlatform.versions[0].platforms = ["linux/amd64", "linux/amd64"];
    expectValidationIssue(
      duplicatePlatform,
      "versions[0].platforms contains duplicate platform 'linux/amd64'",
    );
  });
});
