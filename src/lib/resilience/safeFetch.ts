// Vendored from cubiczan-resilience (typescript/src/safeFetch.ts).
// Import extensions stripped to match this repo's CommonJS/node moduleResolution.
//
// Provided for any future outbound `fetch`-based call. The CogniTrader audit
// sites (ethers BSC RPC, axios CMC client) do not use the global `fetch`, so
// they are wrapped via the `ioRetry` adapter instead; this primitive is kept
// for parity with the shared library and for new fetch call-sites.

import { ResilienceError } from "./errors";
import { retry } from "./retry";

/**
 * SSRF allowlist hook. Return `true` to allow the request to `url`, `false`
 * to reject it before any network I/O happens.
 */
export type AllowlistHook = (url: URL) => boolean;

export interface SafeFetchOptions extends RequestInit {
  /** Per-attempt timeout in milliseconds (AbortController). Default 10_000. */
  readonly timeoutMs?: number;
  /** Maximum number of attempts including the first. Default 3. */
  readonly maxAttempts?: number;
  /** Base backoff delay in milliseconds. Default 250. */
  readonly baseDelayMs?: number;
  /** Upper bound on a single backoff delay. Default 30_000. */
  readonly maxDelayMs?: number;
  /**
   * SSRF guard. Either an explicit hook, or an array of allowed hostnames
   * (exact, case-insensitive match).
   */
  readonly allowlist?: AllowlistHook | readonly string[];
  /** Override the fetch implementation (used by tests). */
  readonly fetchImpl?: typeof fetch;
  /** Override jitter source. Default Math.random. */
  readonly random?: () => number;
  /** Observability hook fired before each backoff sleep. */
  readonly onRetry?: (info: {
    error: unknown;
    attempt: number;
    delayMs: number;
  }) => void;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function buildAllowlistHook(
  allowlist: AllowlistHook | readonly string[] | undefined,
): AllowlistHook | undefined {
  if (allowlist === undefined) return undefined;
  if (typeof allowlist === "function") return allowlist;
  const allowed = new Set(allowlist.map((h) => h.toLowerCase()));
  return (url: URL) => allowed.has(url.hostname.toLowerCase());
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/**
 * `fetch` wrapped with per-attempt timeout, exponential backoff + jitter on
 * 429/5xx and network errors, fail-fast on other 4xx, and an optional SSRF
 * allowlist. Returns the `Response` on success, or throws a typed
 * {@link ResilienceError} after exhausting retries.
 */
export async function safeFetch(
  url: string | URL,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const {
    timeoutMs = 10_000,
    maxAttempts = 3,
    baseDelayMs = 250,
    maxDelayMs = 30_000,
    allowlist,
    fetchImpl,
    random,
    onRetry,
    ...requestInit
  } = options;

  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new ResilienceError(
      "network",
      "global fetch is unavailable; pass options.fetchImpl",
      { attempts: 0 },
    );
  }

  const target = url instanceof URL ? url : new URL(url);

  // SSRF guard runs once, before any network I/O — fail closed when blocked.
  const allowHook = buildAllowlistHook(allowlist);
  if (allowHook && !allowHook(target)) {
    throw new ResilienceError(
      "ssrf",
      `host "${target.hostname}" is not in the allowlist`,
      { attempts: 0 },
    );
  }

  const callerSignal = requestInit.signal ?? undefined;

  return retry<Response>(
    async () => {
      // Per-attempt AbortController; linked to the caller's signal if present.
      const controller = new AbortController();
      const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
      if (callerSignal) {
        if (callerSignal.aborted) controller.abort(callerSignal.reason);
        else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }

      const timer = setTimeout(() => {
        controller.abort(
          new ResilienceError("timeout", `request timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      if (typeof timer === "object" && timer !== null && "unref" in timer) {
        (timer as { unref: () => void }).unref();
      }

      try {
        const response = await doFetch(target, {
          ...requestInit,
          signal: controller.signal,
        });

        if (!response.ok && isRetryableStatus(response.status)) {
          throw new ResilienceError(
            "http",
            `request failed with retryable status ${response.status}`,
            { status: response.status },
          );
        }
        // 4xx (except retryable) and 2xx/3xx are returned to the caller.
        return response;
      } catch (error) {
        if (callerSignal?.aborted) {
          throw new ResilienceError("aborted", "request aborted by caller", {
            cause: callerSignal.reason,
          });
        }
        if (error instanceof ResilienceError) throw error;
        throw new ResilienceError("network", "network request failed", {
          cause: error,
        });
      } finally {
        clearTimeout(timer);
        if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
      }
    },
    {
      maxAttempts,
      baseDelayMs,
      maxDelayMs,
      ...(random ? { random } : {}),
      ...(onRetry ? { onRetry } : {}),
      ...(callerSignal ? { signal: callerSignal } : {}),
      shouldRetry: (error) => {
        if (!(error instanceof ResilienceError)) return true;
        if (error.kind === "ssrf" || error.kind === "aborted") return false;
        if (error.kind === "http") {
          return error.status !== undefined && isRetryableStatus(error.status);
        }
        return true; // timeout, network
      },
    },
  );
}
