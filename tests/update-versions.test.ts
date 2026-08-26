import { describe, expect, test } from "bun:test";
import {
  findLatestMinorVersion,
  getAllPostgresTags,
} from "../scripts/update-versions";

describe("getAllPostgresTags", () => {
  test("authenticates anonymously and follows Registry pagination", async () => {
    const requestedUrls: string[] = [];
    const fetcher = ((input: string | URL | Request) => {
      const url = input.toString();
      requestedUrls.push(url);

      if (url.startsWith("https://auth.docker.io/token")) {
        return Promise.resolve(Response.json({ token: "registry-token" }));
      }

      if (url.includes("last=17.1")) {
        return Promise.resolve(Response.json({ tags: ["18.1", "18.2"] }));
      }

      return Promise.resolve(
        Response.json(
          { tags: ["16.1", "17.1"] },
          {
            headers: {
              Link: '</v2/library/postgres/tags/list?n=1000&last=17.1>; rel="next"',
            },
          },
        ),
      );
    }) as typeof fetch;

    await expect(getAllPostgresTags(fetcher)).resolves.toEqual([
      "16.1",
      "17.1",
      "18.1",
      "18.2",
    ]);
    expect(requestedUrls).toHaveLength(3);
    expect(requestedUrls[2]).toBe(
      "https://registry-1.docker.io/v2/library/postgres/tags/list?n=1000&last=17.1",
    );
  });

  test("reports Registry errors with the HTTP status", async () => {
    const fetcher = ((input: string | URL | Request) => {
      if (input.toString().startsWith("https://auth.docker.io/token")) {
        return Promise.resolve(Response.json({ token: "registry-token" }));
      }

      return Promise.resolve(
        new Response(null, { status: 403, statusText: "Forbidden" }),
      );
    }) as typeof fetch;

    await expect(getAllPostgresTags(fetcher)).rejects.toThrow(
      "Failed to fetch tags: 403 Forbidden",
    );
  });
});

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
