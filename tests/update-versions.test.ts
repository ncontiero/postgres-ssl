import { describe, expect, test } from "bun:test";
import { findLatestMinorVersion } from "../scripts/update-versions";

describe("findLatestMinorVersion", () => {
  test("should return the latest minor version correctly", () => {
    const tags = ["18.1", "18.2", "18.10", "18.3"];
    const result = findLatestMinorVersion(18, tags);
    expect(result).toBe("18.10");
  });

  test("should ignore versions with suffixes or invalid formats", () => {
    // 18.2-alpine should be ignored
    const tags = ["18.1", "18.2", "18.2-alpine", "18.rc1", "18-bullseye"];
    const result = findLatestMinorVersion(18, tags);
    expect(result).toBe("18.2");
  });

  test("should return null if the major version is not found", () => {
    const tags = ["17.1", "16.5", "15.4"];
    const result = findLatestMinorVersion(18, tags);
    expect(result).toBeNull();
  });

  test("should ensure numerical order (e.g., 18.20 is greater than 18.9)", () => {
    const tags = ["18.2", "18.9", "18.20", "18.11"];
    const result = findLatestMinorVersion(18, tags);
    expect(result).toBe("18.20");
  });
});
