import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runCommand } from "./run-command";

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

describe("runCommand", () => {
  test("runs a successful command without changing the exit code", async () => {
    let executed = false;
    const errors: string[] = [];

    await runCommand(
      "Command failed",
      () => {
        executed = true;
        return Promise.resolve();
      },
      (message) => errors.push(message),
    );

    expect(executed).toBe(true);
    expect(errors).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  test("logs failures and sets the process exit code", async () => {
    const errors: string[] = [];

    await runCommand(
      "Command failed",
      () => Promise.reject(new Error("unexpected failure")),
      (message) => errors.push(message),
    );

    expect(errors).toEqual(["Command failed: unexpected failure"]);
    expect(process.exitCode).toBe(1);
  });
});
