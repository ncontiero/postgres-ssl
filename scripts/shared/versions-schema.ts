import type { VersionEntry, VersionsFile } from "./types";
import { VERSION_REGEX } from "./consts";

const MAJOR_VERSION_REGEX = /^[1-9]\d*$/;
const PLATFORM_REGEX =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/;
const TEMPLATE_NAME_REGEX = /^[a-z\d][\w.-]*$/i;

interface ParsedEntry {
  extensionTemplate?: string;
  index: number;
  isLatest?: boolean;
  majorVersion?: string;
  postgresVersion?: string;
}

export class VersionsValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[], options?: ErrorOptions) {
    super(`Invalid versions.json:\n- ${issues.join("\n- ")}`, options);
    this.name = "VersionsValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  entry: Record<string, unknown>,
  key: keyof VersionEntry,
  path: string,
  issues: string[],
): string | undefined {
  const value = entry[key];
  if (typeof value !== "string") {
    issues.push(`${path}.${key} must be a string`);
    return undefined;
  }

  return value;
}

function validatePlatforms(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${path}.platforms must be a non-empty array`);
    return;
  }

  const seenPlatforms = new Set<string>();
  for (const [index, platform] of value.entries()) {
    const platformPath = `${path}.platforms[${index}]`;
    if (typeof platform !== "string" || !PLATFORM_REGEX.test(platform)) {
      issues.push(`${platformPath} must be a valid os/architecture platform`);
      continue;
    }

    if (seenPlatforms.has(platform)) {
      issues.push(
        `${path}.platforms contains duplicate platform '${platform}'`,
      );
    }
    seenPlatforms.add(platform);
  }
}

function validateEntry(
  value: unknown,
  index: number,
  issues: string[],
): ParsedEntry {
  const path = `versions[${index}]`;
  const parsedEntry: ParsedEntry = { index };

  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return parsedEntry;
  }

  const postgresVersion = readString(value, "postgres_version", path, issues);
  const majorVersion = readString(
    value,
    "postgres_major_version",
    path,
    issues,
  );

  if (postgresVersion !== undefined) {
    parsedEntry.postgresVersion = postgresVersion;
    if (!VERSION_REGEX.test(postgresVersion)) {
      issues.push(`${path}.postgres_version must use the major.minor format`);
    }
  }

  if (majorVersion !== undefined) {
    parsedEntry.majorVersion = majorVersion;
    if (!MAJOR_VERSION_REGEX.test(majorVersion)) {
      issues.push(`${path}.postgres_major_version must be a positive integer`);
    }
  }

  if (
    postgresVersion !== undefined &&
    VERSION_REGEX.test(postgresVersion) &&
    majorVersion !== undefined &&
    MAJOR_VERSION_REGEX.test(majorVersion) &&
    postgresVersion.split(".")[0] !== majorVersion
  ) {
    issues.push(
      `${path}.postgres_major_version must match postgres_version '${postgresVersion}'`,
    );
  }

  if (typeof value.is_latest !== "boolean") {
    issues.push(`${path}.is_latest must be a boolean`);
  } else {
    parsedEntry.isLatest = value.is_latest;
  }

  validatePlatforms(value.platforms, path, issues);

  if (Object.hasOwn(value, "extension_template")) {
    if (
      typeof value.extension_template !== "string" ||
      !TEMPLATE_NAME_REGEX.test(value.extension_template)
    ) {
      issues.push(`${path}.extension_template must be a valid template name`);
    } else {
      parsedEntry.extensionTemplate = value.extension_template;
    }
  }

  return parsedEntry;
}

function validateCrossEntryRules(
  entries: ParsedEntry[],
  issues: string[],
): void {
  const majorVersions = new Map<string, number>();
  const extensionTemplates = new Map<string, number>();

  for (const entry of entries) {
    if (entry.majorVersion && MAJOR_VERSION_REGEX.test(entry.majorVersion)) {
      const previousIndex = majorVersions.get(entry.majorVersion);
      if (previousIndex !== undefined) {
        issues.push(
          `versions[${entry.index}].postgres_major_version duplicates major '${entry.majorVersion}' from versions[${previousIndex}]`,
        );
      } else {
        majorVersions.set(entry.majorVersion, entry.index);
      }
    }

    if (entry.extensionTemplate) {
      const previousIndex = extensionTemplates.get(entry.extensionTemplate);
      if (previousIndex !== undefined) {
        issues.push(
          `versions[${entry.index}].extension_template duplicates '${entry.extensionTemplate}' from versions[${previousIndex}]`,
        );
      } else {
        extensionTemplates.set(entry.extensionTemplate, entry.index);
      }
    }
  }

  const latestEntries = entries.filter((entry) => entry.isLatest === true);
  if (latestEntries.length !== 1) {
    issues.push(
      "versions must contain exactly one entry with is_latest set to true",
    );
    return;
  }

  const validMajorVersions = entries
    .map((entry) => entry.majorVersion)
    .filter((majorVersion): majorVersion is string =>
      majorVersion === undefined
        ? false
        : MAJOR_VERSION_REGEX.test(majorVersion),
    )
    .map(Number);
  const latestEntry = latestEntries[0];

  if (
    latestEntry.majorVersion &&
    validMajorVersions.length > 0 &&
    Number(latestEntry.majorVersion) !== Math.max(...validMajorVersions)
  ) {
    issues.push(
      `versions[${latestEntry.index}].is_latest must identify the highest configured major version`,
    );
  }
}

export function validateVersionsFile(value: unknown): VersionsFile {
  if (!isRecord(value) || !Array.isArray(value.versions)) {
    throw new VersionsValidationError(["versions must be a non-empty array"]);
  }

  if (value.versions.length === 0) {
    throw new VersionsValidationError(["versions must be a non-empty array"]);
  }

  const issues: string[] = [];
  const entries = value.versions.map((entry, index) =>
    validateEntry(entry, index, issues),
  );
  validateCrossEntryRules(entries, issues);

  if (issues.length > 0) {
    throw new VersionsValidationError(issues);
  }

  return value as unknown as VersionsFile;
}
