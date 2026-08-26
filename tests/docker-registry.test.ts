import { describe, expect, test } from "bun:test";
import { getAllPostgresTags } from "../scripts/infrastructure/docker-registry";

type Fetch = typeof globalThis.fetch;

function createFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): Fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(input.toString(), init))) as Fetch;
}

function createOptions(fetcher: Fetch) {
  return {
    fetcher,
    sleep: () => Promise.resolve(),
  };
}

describe("getAllPostgresTags", () => {
  test("authenticates anonymously and follows Registry pagination", async () => {
    const requestedUrls: string[] = [];
    const authorizationHeaders: Array<string | null> = [];
    const fetcher = createFetch((url, init) => {
      requestedUrls.push(url);

      if (url.startsWith("https://auth.docker.io/token")) {
        return Response.json({ token: "registry-token" });
      }

      authorizationHeaders.push(
        new Headers(init?.headers).get("authorization"),
      );
      if (url.includes("last=17.1")) {
        return Response.json({ tags: ["18.1", "18.2"] });
      }

      return Response.json(
        { tags: ["16.1", "17.1"] },
        {
          headers: {
            Link: '<ignored>; rel="previous", </v2/library/postgres/tags/list?n=1000&last=17.1>; type="application/json"; rel="next"',
          },
        },
      );
    });

    await expect(getAllPostgresTags(createOptions(fetcher))).resolves.toEqual([
      "16.1",
      "17.1",
      "18.1",
      "18.2",
    ]);
    expect(requestedUrls).toHaveLength(3);
    expect(requestedUrls[2]).toBe(
      "https://registry-1.docker.io/v2/library/postgres/tags/list?n=1000&last=17.1",
    );
    expect(authorizationHeaders).toEqual([
      "Bearer registry-token",
      "Bearer registry-token",
    ]);
  });

  test("retries transient statuses with exponential backoff", async () => {
    const delays: number[] = [];
    let registryAttempts = 0;
    const fetcher = createFetch((url) => {
      if (url.startsWith("https://auth.docker.io/token")) {
        return Response.json({ token: "registry-token" });
      }

      registryAttempts += 1;
      if (registryAttempts === 1) {
        return new Response(null, {
          status: 503,
          statusText: "Service Unavailable",
        });
      }
      return Response.json({ tags: ["18.6"] });
    });

    await expect(
      getAllPostgresTags({
        ...createOptions(fetcher),
        sleep: (delay) => {
          delays.push(delay);
          return Promise.resolve();
        },
      }),
    ).resolves.toEqual(["18.6"]);
    expect(registryAttempts).toBe(2);
    expect(delays).toEqual([500]);
  });

  test("respects Retry-After on rate limiting", async () => {
    const delays: number[] = [];
    let registryAttempts = 0;
    const fetcher = createFetch((url) => {
      if (url.startsWith("https://auth.docker.io/token")) {
        return Response.json({ token: "registry-token" });
      }

      registryAttempts += 1;
      if (registryAttempts === 1) {
        return new Response(null, {
          headers: { "Retry-After": "2" },
          status: 429,
          statusText: "Too Many Requests",
        });
      }
      return Response.json({ tags: ["18.6"] });
    });

    await getAllPostgresTags({
      ...createOptions(fetcher),
      sleep: (delay) => {
        delays.push(delay);
        return Promise.resolve();
      },
    });
    expect(delays).toEqual([2_000]);
  });

  test("reports the final transient HTTP error after exhausting retries", async () => {
    let registryAttempts = 0;
    const fetcher = createFetch((url) => {
      if (url.startsWith("https://auth.docker.io/token")) {
        return Response.json({ token: "registry-token" });
      }

      registryAttempts += 1;
      return new Response(null, {
        status: 503,
        statusText: "Service Unavailable",
      });
    });

    await expect(
      getAllPostgresTags({
        ...createOptions(fetcher),
        maxAttempts: 2,
      }),
    ).rejects.toThrow(
      "Docker Registry tags page 1 failed after 2 attempts: 503 Service Unavailable",
    );
    expect(registryAttempts).toBe(2);
  });

  test("does not retry definitive HTTP errors", async () => {
    let registryAttempts = 0;
    const fetcher = createFetch((url) => {
      if (url.startsWith("https://auth.docker.io/token")) {
        return Response.json({ token: "registry-token" });
      }

      registryAttempts += 1;
      return new Response(null, { status: 403, statusText: "Forbidden" });
    });

    await expect(getAllPostgresTags(createOptions(fetcher))).rejects.toThrow(
      "Docker Registry tags page 1 failed on attempt 1: 403",
    );
    expect(registryAttempts).toBe(1);
  });

  test("renews the token once after an unauthorized tags response", async () => {
    let authAttempts = 0;
    const authorizationHeaders: Array<string | null> = [];
    const fetcher = createFetch((url, init) => {
      if (url.startsWith("https://auth.docker.io/token")) {
        authAttempts += 1;
        return Response.json({ token: `registry-token-${authAttempts}` });
      }

      const authorization = new Headers(init?.headers).get("authorization");
      authorizationHeaders.push(authorization);
      if (authorization === "Bearer registry-token-1") {
        return new Response(null, {
          status: 401,
          statusText: "Unauthorized",
        });
      }
      return Response.json({ tags: ["18.6"] });
    });

    await expect(getAllPostgresTags(createOptions(fetcher))).resolves.toEqual([
      "18.6",
    ]);
    expect(authAttempts).toBe(2);
    expect(authorizationHeaders).toEqual([
      "Bearer registry-token-1",
      "Bearer registry-token-2",
    ]);
  });

  test("rejects invalid authentication and tags payloads", async () => {
    const invalidJsonFetch = createFetch(
      () => new Response("not-json", { status: 200 }),
    );
    await expect(
      getAllPostgresTags(createOptions(invalidJsonFetch)),
    ).rejects.toThrow("Docker Registry authentication returned invalid JSON");

    const missingTokenFetch = createFetch(() => Response.json({}));
    await expect(
      getAllPostgresTags(createOptions(missingTokenFetch)),
    ).rejects.toThrow("token is missing");

    const invalidTagsFetch = createFetch((url) =>
      url.startsWith("https://auth.docker.io/token")
        ? Response.json({ token: "registry-token" })
        : Response.json({ tags: ["18.6", null] }),
    );
    await expect(
      getAllPostgresTags(createOptions(invalidTagsFetch)),
    ).rejects.toThrow("tags must be an array of non-empty strings");
  });

  test("detects circular pagination", async () => {
    const fetcher = createFetch((url) => {
      if (url.startsWith("https://auth.docker.io/token")) {
        return Response.json({ token: "registry-token" });
      }

      return Response.json(
        { tags: ["18.6"] },
        { headers: { Link: `<${url}>; rel="next"` } },
      );
    });

    await expect(getAllPostgresTags(createOptions(fetcher))).rejects.toThrow(
      "pagination cycle detected on page 2",
    );
  });

  test("retries network errors and reports exhausted attempts", async () => {
    let registryAttempts = 0;
    const delays: number[] = [];
    const fetcher = createFetch((url) => {
      if (url.startsWith("https://auth.docker.io/token")) {
        return Response.json({ token: "registry-token" });
      }

      registryAttempts += 1;
      throw new TypeError("DNS lookup failed");
    });

    await expect(
      getAllPostgresTags({
        ...createOptions(fetcher),
        sleep: (delay) => {
          delays.push(delay);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("failed after 3 attempts due to a network error");
    expect(registryAttempts).toBe(3);
    expect(delays).toEqual([500, 1_000]);
  });

  test("aborts requests that exceed the timeout", async () => {
    const fetcher = createFetch((url, init) => {
      if (url.startsWith("https://auth.docker.io/token")) {
        return Response.json({ token: "registry-token" });
      }

      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason);
        });
      });
    });

    await expect(
      getAllPostgresTags({
        ...createOptions(fetcher),
        maxAttempts: 1,
        requestTimeoutMs: 5,
      }),
    ).rejects.toThrow("failed after 1 attempts due to a network error");
  });
});
