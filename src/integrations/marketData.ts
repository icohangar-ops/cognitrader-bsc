// ============================================================
// CogniTrader BSC — Tiered Market Data Service
// LIVE (CoinMarketCap REST) → CACHE (disk snapshot) → MOCK
// (deterministic synthetic), with an honest provenance badge on
// every resolved value.
//
// Pattern: cubiczan-resilience `tieredSource` (row 3 of the
// propagation matrix; canonical module `resolveTiered` in
// src/lib/resilience/tieredSource.ts, vendored from
// @cubiczan/resilience typescript-v0.2.0). The badge is not
// optional — no code path here returns an unlabelled value.
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type {
  Candle,
  FearGreedIndex,
  MarketSnapshot,
  OHLCVSeries,
} from '../utils/types';
import { CoinMarketCapClient } from './cmc';
import { getLogger } from '../utils/logger';
import {
  resolveTiered,
  type CachedValue,
  type SourceTier,
  type TieredResult,
} from '../lib/resilience/tieredSource';

/** Default disk-cache directory (gitignored via `state/`). */
export const DEFAULT_MARKET_DATA_CACHE_DIR = path.join('state', 'market-data');

/** File-layout version — bump to invalidate stale cache files after a format change. */
const CACHE_FORMAT = 'market-data-cache-v1';

function readJsonCache<T>(file: string): CachedValue<T> | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
      format?: string;
      cachedAt?: number;
      value?: T;
    };
    if (parsed.format !== CACHE_FORMAT || typeof parsed.cachedAt !== 'number') {
      return null;
    }
    return { value: parsed.value as T, cachedAt: parsed.cachedAt };
  } catch {
    return null; // corrupt cache file behaves as a miss
  }
}

function writeJsonCache<T>(file: string, value: T): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ format: CACHE_FORMAT, cachedAt: Date.now(), value }),
    );
  } catch (error) {
    // Cache writes are best-effort — a failed write degrades to a cache
    // miss on the next read, never a live failure.
    getLogger().warn(
      `[market-data] cache write failed for ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Deterministic mock OHLCV series (the mock tier). Seeded from the token
 * symbol so the same token always produces the same placeholder candles —
 * stable for demos and CI, and always labelled `mock` by the resolver.
 */
export function syntheticCandles(token: string, count: number): Candle[] {
  let seed = 0;
  for (let i = 0; i < token.length; i++) {
    seed = (seed * 31 + token.charCodeAt(i)) >>> 0;
  }
  const rand = (): number => {
    // mulberry32 — small, deterministic, good enough for placeholder candles
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const candles: Candle[] = [];
  const now = Math.floor(Date.now() / 1000);
  let price = 1 + rand() * 100;

  for (let i = 0; i < count; i++) {
    const volatility = 0.02 + rand() * 0.05;
    const change = (rand() - 0.48) * volatility * price;

    const open = price;
    const close = price + change;
    const high = Math.max(open, close) * (1 + rand() * 0.01);
    const low = Math.min(open, close) * (1 - rand() * 0.01);
    const volume = 100000 + rand() * 1000000;

    candles.push({
      timestamp: now - (count - i) * 3600,
      open,
      high,
      low,
      close,
      volume,
    });

    price = close;
  }

  return candles;
}

/**
 * Deterministic neutral snapshot (the mock tier for snapshots): Fear&Greed
 * 50 Neutral, no quotes, no trending. Sentiment finds no quote data and
 * abstains; momentum/mean-reversion compute on mock candles.
 */
export function syntheticSnapshot(_tokens: string[]): MarketSnapshot {
  const fearGreed: FearGreedIndex = {
    value: 50,
    value_classification: 'Neutral',
    timestamp: new Date().toISOString(),
    time_until_update: '',
  };
  return {
    quotes: new Map(),
    trending: [],
    fearGreed,
    timestamp: Date.now(),
  };
}

/** Where a resolved value came from — re-exported for callers' logging. */
export type { TieredResult };

/**
 * Trading gate on data provenance (review finding): mock candles are
 * deterministic placeholders seeded from the token symbol, not from time —
 * during a CMC outage the same indicator readings repeat every cycle, so the
 * agent would place repeated directional bets on fixed synthetic prices.
 * Capital never moves on the mock tier. A `cache` hit is real (if stale)
 * data and still trades, with its badge logged.
 */
export function tradingBlockedForTier(tier: SourceTier): boolean {
  return tier === 'mock';
}

/**
 * Three-tier wrapper around {@link CoinMarketCapClient}.
 *
 * Every payload carries a `TieredResult` badge (`live` / `cache` / `mock`).
 * A snapshot that contains no live quotes is treated as a live-tier failure
 * so the resolver falls through honestly instead of presenting a hollow
 * snapshot as live data.
 */
export class TieredMarketData {
  private cacheDir: string;

  constructor(
    private cmc: CoinMarketCapClient,
    cacheDir: string = DEFAULT_MARKET_DATA_CACHE_DIR,
  ) {
    this.cacheDir = cacheDir;
  }

  /** LIVE → CACHE → MOCK full market snapshot for the configured tokens. */
  async getMarketSnapshot(tokens: string[]): Promise<TieredResult<MarketSnapshot>> {
    return resolveTiered<MarketSnapshot>({
      live: async () => {
        const snapshot = await this.cmc.getMarketSnapshot(tokens);
        // The CMC client degrades internally (allSettled + neutral FGI);
        // a snapshot with zero live quotes is not live data.
        if (snapshot.quotes.size === 0) {
          throw new Error('live CMC snapshot returned no quotes');
        }
        writeJsonCache(path.join(this.cacheDir, 'market-snapshot.json'), {
          tokens,
          snapshot,
        });
        return snapshot;
      },
      cache: async () => {
        const hit = readJsonCache<{ tokens: string[]; snapshot: MarketSnapshot }>(
          path.join(this.cacheDir, 'market-snapshot.json'),
        );
        if (!hit) return null;
        return { value: hit.value.snapshot, cachedAt: hit.cachedAt };
      },
      mock: () => syntheticSnapshot(tokens),
      onFailure: ({ tier, error }) =>
        getLogger().warn(`[market-data] ${tier} tier failed: ${error.message}`),
    });
  }

  /** LIVE → CACHE → MOCK OHLCV candle series for one token. */
  async getOHLCV(
    symbol: string,
    interval: string = '1h',
    count: number = 168,
  ): Promise<TieredResult<OHLCVSeries>> {
    const cacheFile = path.join(this.cacheDir, `ohlcv-${symbol}.json`);
    return resolveTiered<OHLCVSeries>({
      live: async () => {
        const series = await this.cmc.getOHLCV(symbol, interval, count);
        if (series.candles.length === 0) {
          throw new Error('live CMC OHLCV returned no candles');
        }
        writeJsonCache(cacheFile, series);
        return series;
      },
      cache: async () => {
        const hit = readJsonCache<OHLCVSeries>(cacheFile);
        if (!hit) return null;
        return { value: hit.value, cachedAt: hit.cachedAt };
      },
      mock: () => ({
        token: symbol,
        interval,
        candles: syntheticCandles(symbol, count),
      }),
      onFailure: ({ tier, error }) =>
        getLogger().warn(`[market-data] OHLCV ${symbol} ${tier} tier failed: ${error.message}`),
    });
  }
}
