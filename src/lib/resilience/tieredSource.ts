/**
 * Three-tier data resolution: live → cache → mock, with an honest provenance badge.
 *
 * Lifted and generalized from the independently-written three-tier fallbacks in
 * `market-radar` (`Three-Tier Data Resolution`), `courtvision-ai`,
 * `finance-cockpit`, `chainsight-ai`, `deltafin`, `decision-brief`,
 * `medpsy-clinical-trial-agent`, and `metal-tokenization-traceability`
 * (`Three-Tier Data Fallback with Honest Badges`) — nine repos that each
 * reimplemented the same ladder.
 *
 * The pattern exists because a dashboard that silently shows mock data is worse
 * than one that shows nothing: the reader cannot tell a real number from a
 * placeholder. So every result carries the tier it came from, and the caller is
 * expected to render that badge.
 *
 * Design rules, all learned from the donor implementations:
 *
 * - **The badge is not optional.** `resolveTiered` cannot return a value without
 *   a `tier`. There is no code path that yields an unlabelled number.
 * - **Mock is opt-in.** If no `mock` tier is supplied and live+cache both fail,
 *   the call rejects. Fabricating data is never the default.
 * - **A cache hit is still degraded.** `stale: true` when the cached value is
 *   older than `maxCacheAge`, so a reader can distinguish "cached a second ago"
 *   from "cached last Tuesday".
 * - **Errors are collected, not swallowed.** Every tier's failure is reported on
 *   the result, so a silent fallback still leaves a diagnosable trail.
 */

/** Which tier actually produced the value. */
export type SourceTier = "live" | "cache" | "mock";

/** A resolved value plus honest provenance. */
export interface TieredResult<T> {
  readonly value: T;
  /** Which tier produced `value`. Render this. */
  readonly tier: SourceTier;
  /**
   * True when the value should be presented as degraded: any cache or mock hit,
   * or a cache hit older than `maxCacheAge`.
   */
  readonly degraded: boolean;
  /** True only for a cache hit older than `maxCacheAge`. */
  readonly stale: boolean;
  /** Age of the cached value in ms, when the cache tier reported one. */
  readonly ageMs?: number;
  /** Why each attempted tier failed, in attempt order. Empty on a live hit. */
  readonly failures: readonly TierFailure[];
  /** Short human-readable provenance, e.g. `"cache (stale, 3h)"`. */
  readonly badge: string;
}

/** One tier's failure. */
export interface TierFailure {
  readonly tier: SourceTier;
  readonly error: Error;
}

/** A cached value with the time it was recorded. */
export interface CachedValue<T> {
  readonly value: T;
  /** Epoch ms when this value was cached. */
  readonly cachedAt: number;
}

export interface TieredSourceOptions<T> {
  /** The authoritative source. Tried first. */
  readonly live: () => Promise<T>;
  /**
   * Cached fallback. Return `null`/`undefined` for a miss rather than throwing,
   * though a throw is also treated as a miss and recorded.
   */
  readonly cache?: () => Promise<CachedValue<T> | T | null | undefined>;
  /**
   * Last-resort placeholder. Omit to make exhaustion an error — which is the
   * right choice for anything a person will read as a real figure.
   */
  readonly mock?: () => Promise<T> | T;
  /**
   * A cache hit older than this (ms) is flagged `stale`. Defaults to 5 minutes.
   * A stale hit is still returned; staleness is reported, not fatal.
   */
  readonly maxCacheAge?: number;
  /**
   * Reject a cache hit older than this (ms) outright and fall through to mock.
   * Off by default — most callers would rather show old data with a badge.
   */
  readonly maxCacheAgeHard?: number;
  /** Called once per tier failure. Wire to your logger. */
  readonly onFailure?: (failure: TierFailure) => void;
}

/** Raised when every configured tier failed. */
export class AllTiersFailedError extends Error {
  readonly failures: readonly TierFailure[];

  constructor(failures: readonly TierFailure[]) {
    const detail = failures
      .map((f) => `${f.tier}: ${f.error.message}`)
      .join("; ");
    super(`all data tiers failed (${detail || "no tiers configured"})`);
    this.name = "AllTiersFailedError";
    this.failures = failures;
  }
}

const DEFAULT_MAX_CACHE_AGE = 5 * 60 * 1000;

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function isCachedValue<T>(v: CachedValue<T> | T): v is CachedValue<T> {
  return (
    typeof v === "object" &&
    v !== null &&
    "value" in v &&
    "cachedAt" in v &&
    typeof (v as CachedValue<T>).cachedAt === "number"
  );
}

function humanAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function makeBadge(
  tier: SourceTier,
  stale: boolean,
  ageMs: number | undefined,
): string {
  if (tier === "live") return "live";
  if (tier === "mock") return "mock data — not real";
  const parts: string[] = [];
  if (stale) parts.push("stale");
  if (ageMs !== undefined) parts.push(humanAge(ageMs));
  return parts.length ? `cache (${parts.join(", ")})` : "cache";
}

/**
 * Resolve a value through live → cache → mock, returning provenance alongside it.
 *
 * @throws {AllTiersFailedError} when every configured tier fails. Supply `mock`
 *   only if a placeholder is genuinely acceptable to the reader.
 *
 * @example
 * const price = await resolveTiered({
 *   live:  () => fetchSpotPrice("LME-CU"),
 *   cache: () => readCache("LME-CU"),
 *   maxCacheAge: 60_000,
 * });
 * render(price.value, { badge: price.badge, muted: price.degraded });
 */
export async function resolveTiered<T>(
  options: TieredSourceOptions<T>,
): Promise<TieredResult<T>> {
  const {
    live,
    cache,
    mock,
    maxCacheAge = DEFAULT_MAX_CACHE_AGE,
    maxCacheAgeHard,
    onFailure,
  } = options;
  const failures: TierFailure[] = [];

  const fail = (tier: SourceTier, cause: unknown): void => {
    const failure: TierFailure = { tier, error: toError(cause) };
    failures.push(failure);
    onFailure?.(failure);
  };

  try {
    const value = await live();
    return {
      value,
      tier: "live",
      degraded: false,
      stale: false,
      failures: [],
      badge: makeBadge("live", false, undefined),
    };
  } catch (cause) {
    fail("live", cause);
  }

  if (cache) {
    try {
      const hit = await cache();
      if (hit === null || hit === undefined) {
        fail("cache", new Error("cache miss"));
      } else {
        const cached = isCachedValue<T>(hit)
          ? hit
          : { value: hit as T, cachedAt: Number.NaN };
        const ageMs = Number.isFinite(cached.cachedAt)
          ? Math.max(0, Date.now() - cached.cachedAt)
          : undefined;

        if (
          maxCacheAgeHard !== undefined &&
          ageMs !== undefined &&
          ageMs > maxCacheAgeHard
        ) {
          fail(
            "cache",
            new Error(
              `cached value age ${ageMs}ms exceeds hard limit ${maxCacheAgeHard}ms`,
            ),
          );
        } else {
          const stale = ageMs !== undefined && ageMs > maxCacheAge;
          return {
            value: cached.value,
            tier: "cache",
            degraded: true,
            stale,
            ageMs,
            failures: [...failures],
            badge: makeBadge("cache", stale, ageMs),
          };
        }
      }
    } catch (cause) {
      fail("cache", cause);
    }
  }

  if (mock) {
    try {
      const value = await mock();
      return {
        value,
        tier: "mock",
        degraded: true,
        stale: false,
        failures: [...failures],
        badge: makeBadge("mock", false, undefined),
      };
    } catch (cause) {
      fail("mock", cause);
    }
  }

  throw new AllTiersFailedError(failures);
}
