// Resilience primitives vendored from cubiczan-resilience, plus a local
// `ioRetry` adapter for non-fetch I/O (ethers RPC, axios). See ioRetry.ts.

export { ResilienceError, isResilienceError } from "./errors";
export type { ResilienceErrorKind, ResilienceErrorOptions } from "./errors";
export { retry, computeBackoff } from "./retry";
export type { RetryOptions } from "./retry";
export { withTimeout } from "./timeout";
export { safeFetch } from "./safeFetch";
export type { SafeFetchOptions, AllowlistHook } from "./safeFetch";
export { ioRetry, fixedBackoffMs } from "./ioRetry";
export type { IoRetryOptions } from "./ioRetry";
