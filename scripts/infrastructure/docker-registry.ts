import {
  DOCKER_AUTH_API_URL,
  DOCKER_REGISTRY_TAGS_API_URL,
} from "../shared/consts";

type Fetch = typeof globalThis.fetch;
type Sleep = (milliseconds: number) => Promise<void>;

interface DockerAuthResponse {
  access_token?: unknown;
  token?: unknown;
}

interface DockerRegistryTagsResponse {
  tags?: unknown;
}

interface RequestResult {
  attempt: number;
  response: Response;
}

export interface DockerRegistryClientOptions {
  baseRetryDelayMs?: number;
  fetcher?: Fetch;
  maxAttempts?: number;
  maxRetryDelayMs?: number;
  now?: () => number;
  requestTimeoutMs?: number;
  sleep?: Sleep;
}

interface ResolvedClientOptions {
  baseRetryDelayMs: number;
  fetcher: Fetch;
  maxAttempts: number;
  maxRetryDelayMs: number;
  now: () => number;
  requestTimeoutMs: number;
  sleep: Sleep;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const LINK_URL_REGEX = /^\s*<([^>]+)>/;
const LINK_REL_REGEX = /(?:^|;)\s*rel\s*=\s*"?([^";]+)"?/i;
const RELATION_SEPARATOR_REGEX = /\s+/;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resolveOptions(
  options: DockerRegistryClientOptions,
): ResolvedClientOptions {
  const resolved = {
    baseRetryDelayMs: options.baseRetryDelayMs ?? 500,
    fetcher: options.fetcher ?? globalThis.fetch,
    maxAttempts: options.maxAttempts ?? 3,
    maxRetryDelayMs: options.maxRetryDelayMs ?? 30_000,
    now: options.now ?? Date.now,
    requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
    sleep: options.sleep ?? defaultSleep,
  };

  if (resolved.maxAttempts < 1) {
    throw new Error("Docker Registry maxAttempts must be at least 1");
  }
  if (resolved.requestTimeoutMs < 1) {
    throw new Error("Docker Registry requestTimeoutMs must be at least 1");
  }

  return resolved;
}

function getRetryAfterDelay(
  response: Response,
  attempt: number,
  options: ResolvedClientOptions,
): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, options.maxRetryDelayMs);
    }

    const retryAt = Date.parse(retryAfter);
    if (!Number.isNaN(retryAt)) {
      return Math.min(
        Math.max(0, retryAt - options.now()),
        options.maxRetryDelayMs,
      );
    }
  }

  return Math.min(
    options.baseRetryDelayMs * 2 ** (attempt - 1),
    options.maxRetryDelayMs,
  );
}

async function requestWithRetry(
  url: string,
  init: RequestInit,
  context: string,
  options: ResolvedClientOptions,
): Promise<RequestResult> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      const response = await options.fetcher(url, {
        ...init,
        signal: AbortSignal.timeout(options.requestTimeoutMs),
      });

      if (!RETRYABLE_STATUSES.has(response.status)) {
        return { attempt, response };
      }

      if (attempt === options.maxAttempts) {
        throw new Error(
          `${context} failed after ${attempt} attempts: ${response.status} ${response.statusText} (${url})`,
        );
      }

      const delay = getRetryAfterDelay(response, attempt, options);
      await response.body?.cancel();
      await options.sleep(delay);
    } catch (error) {
      lastError = error;
      if (
        error instanceof Error &&
        error.message.startsWith(`${context} failed after`)
      ) {
        throw error;
      }

      if (attempt === options.maxAttempts) {
        throw new Error(
          `${context} failed after ${attempt} attempts due to a network error (${url}): ${error instanceof Error ? error.message : error}`,
          { cause: error },
        );
      }

      const delay = Math.min(
        options.baseRetryDelayMs * 2 ** (attempt - 1),
        options.maxRetryDelayMs,
      );
      await options.sleep(delay);
    }
  }

  throw new Error(`${context} failed`, { cause: lastError });
}

function assertSuccessfulResponse(
  result: RequestResult,
  context: string,
  url: string,
): void {
  if (!result.response.ok) {
    throw new Error(
      `${context} failed on attempt ${result.attempt}: ${result.response.status} ${result.response.statusText} (${url})`,
    );
  }
}

async function readJson(response: Response, context: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${context} returned invalid JSON`, { cause: error });
  }
}

async function getRegistryToken(
  options: ResolvedClientOptions,
): Promise<string> {
  const result = await requestWithRetry(
    DOCKER_AUTH_API_URL,
    { headers: { Accept: "application/json" } },
    "Docker Registry authentication",
    options,
  );
  assertSuccessfulResponse(
    result,
    "Docker Registry authentication",
    DOCKER_AUTH_API_URL,
  );

  const data = (await readJson(
    result.response,
    "Docker Registry authentication",
  )) as DockerAuthResponse;
  const token = data?.token ?? data?.access_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(
      "Docker Registry authentication returned an invalid payload: token is missing",
    );
  }

  return token;
}

function getNextPageUrl(response: Response, currentUrl: string): string | null {
  const link = response.headers.get("link");
  if (!link) return null;

  for (const item of link.split(",")) {
    const urlMatch = item.match(LINK_URL_REGEX);
    const relation = item.match(LINK_REL_REGEX)?.[1];
    if (
      urlMatch &&
      relation
        ?.split(RELATION_SEPARATOR_REGEX)
        .some((relationName) => relationName.toLowerCase() === "next")
    ) {
      return new URL(urlMatch[1], currentUrl).toString();
    }
  }

  return null;
}

async function readTags(response: Response, page: number): Promise<string[]> {
  const data = (await readJson(
    response,
    `Docker Registry tags page ${page}`,
  )) as DockerRegistryTagsResponse;

  if (
    !data ||
    !Array.isArray(data.tags) ||
    !data.tags.every((tag) => typeof tag === "string" && tag.length > 0)
  ) {
    throw new Error(
      `Docker Registry tags page ${page} returned an invalid payload: tags must be an array of non-empty strings`,
    );
  }

  return data.tags;
}

/**
 * Fetches every tag for the official Postgres image using anonymous pull access.
 */
export async function getAllPostgresTags(
  clientOptions: DockerRegistryClientOptions = {},
): Promise<string[]> {
  const options = resolveOptions(clientOptions);
  const allTags: string[] = [];
  const visitedUrls = new Set<string>();
  let token = await getRegistryToken(options);
  let tokenRefreshed = false;
  let page = 1;
  let url: string | null = DOCKER_REGISTRY_TAGS_API_URL;

  while (url) {
    const currentUrl = url;
    if (visitedUrls.has(currentUrl)) {
      throw new Error(
        `Docker Registry pagination cycle detected on page ${page}: ${currentUrl}`,
      );
    }
    visitedUrls.add(currentUrl);

    let result = await requestWithRetry(
      currentUrl,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
      `Docker Registry tags page ${page}`,
      options,
    );

    if (result.response.status === 401 && !tokenRefreshed) {
      await result.response.body?.cancel();
      token = await getRegistryToken(options);
      tokenRefreshed = true;
      result = await requestWithRetry(
        currentUrl,
        {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
          },
        },
        `Docker Registry tags page ${page} after token refresh`,
        options,
      );
    }

    assertSuccessfulResponse(
      result,
      `Docker Registry tags page ${page}`,
      currentUrl,
    );
    allTags.push(...(await readTags(result.response, page)));
    url = getNextPageUrl(result.response, currentUrl);
    page += 1;
  }

  return allTags;
}
