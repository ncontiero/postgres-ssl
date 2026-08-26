import { describe, expect, test } from "bun:test";
import { getAllPostgresTags } from "../scripts/commands/update-versions";

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
