// Local adapter over the vendored `retry` primitive.
//
// The CogniTrader audit requires retry-with-exponential-backoff (3 attempts,
// 1s / 2s / 4s) around external I/O that does NOT go through `fetch` — namely
// ethers.js BSC RPC calls and the axios CoinMarketCap client. `safeFetch` only
// wraps the global `fetch`, so this helper reuses the same `retry` engine but
// pins a deterministic fixed-exponential backoff (no jitter) to match the
// exact 1s/2s/4s schedule the audit calls for.

import { retry } from "./retry";

const BASE_DELAY_MS = 1_000;
const MAX_ATTEMPTS = 3;

/** Deterministic 1s, 2s, 4s, ... backoff (the audit's required schedule). */
export function fixedBackoffMs(attempt: number): number {
  return BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t === "object" && t !== null && "unref" in t) {
      (t as { unref: () => void }).unref();
    }
  });

export interface IoRetryOptions {
  /** Human label used in the retry log line. */
  readonly label?: string;
  /** Maximum attempts including the first. Default 3. */
  readonly maxAttempts?: number;
  /** Decide whether a thrown error is retryable. Default: retry everything. */
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Fired before each backoff sleep (e.g. to log / rotate an RPC endpoint). */
  readonly onRetry?: (info: {
    error: unknown;
    attempt: number;
    delayMs: number;
  }) => void;
}

/**
 * Run `fn` with retry + fixed exponential backoff (1s/2s/4s, 3 attempts).
 *
 * `fn` receives the 1-based attempt number, which the BSC client uses to
 * rotate through fallback RPC endpoints. The deterministic delay schedule is
 * supplied via a custom sleep that ignores `retry`'s jittered delay.
 */
export async function ioRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: IoRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  let pendingAttempt = 1;

  return retry<T>(
    (attempt) => {
      pendingAttempt = attempt;
      return fn(attempt);
    },
    {
      maxAttempts,
      ...(options.shouldRetry ? { shouldRetry: options.shouldRetry } : {}),
      onRetry: (info) => options.onRetry?.(info),
      // Override the jittered delay with the deterministic 1s/2s/4s schedule.
      sleep: () => sleep(fixedBackoffMs(pendingAttempt)),
    },
  );
}
