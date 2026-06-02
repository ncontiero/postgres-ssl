import { describe, expect, test } from "bun:test";
import { VERSION_REGEX } from "../scripts/consts";

describe("VERSION_REGEX", () => {
  test("should accept versions in major.minor format", () => {
    expect(VERSION_REGEX.test("18.4")).toBe(true);
    expect(VERSION_REGEX.test("17.10")).toBe(true);
    expect(VERSION_REGEX.test("9.6")).toBe(true);
    expect(VERSION_REGEX.test("10.0")).toBe(true);
  });

  test("should reject versions with suffixes", () => {
    expect(VERSION_REGEX.test("18.4-alpine")).toBe(false);
    expect(VERSION_REGEX.test("17.10-bullseye")).toBe(false);
    expect(VERSION_REGEX.test("18.rc1")).toBe(false);
    expect(VERSION_REGEX.test("latest")).toBe(false);
  });

  test("should reject versions with only major number", () => {
    expect(VERSION_REGEX.test("18")).toBe(false);
    expect(VERSION_REGEX.test("17")).toBe(false);
  });

  test("should reject patch versions (major.minor.patch)", () => {
    expect(VERSION_REGEX.test("18.4.1")).toBe(false);
    expect(VERSION_REGEX.test("17.10.2")).toBe(false);
  });
});
