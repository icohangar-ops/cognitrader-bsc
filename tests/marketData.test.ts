// ============================================================
// Tests for the tiered market-data service
// (src/integrations/marketData.ts — row 3: live → cache → mock,
// always badged, vendored resolver src/lib/resilience/tieredSource.ts)
// Proves: live success is badged live and writes a disk cache;
// a live failure with a warm cache returns cached data badged
// cache; with no cache the mock tier answers badged mock; a
// hollow live snapshot (zero quotes) is treated as a live failure.
// Run with: npm test
// ============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { TieredMarketData, syntheticCandles, syntheticSnapshot } from '../src/integrations/marketData';
import { CoinMarketCapClient } from '../src/integrations/cmc';
import type { MarketSnapshot, OHLCVSeries } from '../src/utils/types';

function tmpCacheDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'cognitrader-md-'));
}

/** Stub CMC client — only the two methods the tiered service calls. */
function stubCmc(overrides: {
  snapshot?: () => Promise<MarketSnapshot>;
  ohlcv?: () => Promise<OHLCVSeries>;
}): CoinMarketCapClient {
  const stub = {
    getMarketSnapshot: overrides.snapshot ?? (() => { throw new Error('cmc down'); }),
    getOHLCV: overrides.ohlcv ?? (() => { throw new Error('cmc down'); }),
  };
  return stub as unknown as CoinMarketCapClient;
}

test('live tier succeeds, badges live, and writes a disk cache', async () => {
  const cacheDir = tmpCacheDir();
  try {
    const series: OHLCVSeries = { token: 'CAKE', interval: '1h', candles: syntheticCandles('CAKE', 48) };
    const md = new TieredMarketData(
      stubCmc({ ohlcv: async () => series }),
      cacheDir,
    );
    const result = await md.getOHLCV('CAKE', '1h', 48);
    assert.equal(result.tier, 'live');
    assert.equal(result.degraded, false);
    assert.equal(result.value.candles.length, 48);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('live failure with a warm cache returns cached data badged cache', async () => {
  const cacheDir = tmpCacheDir();
  try {
    const series: OHLCVSeries = { token: 'CAKE', interval: '1h', candles: syntheticCandles('CAKE', 48) };
    const liveThenDown = new TieredMarketData(
      stubCmc({ ohlcv: async () => series }),
      cacheDir,
    );
    const live = await liveThenDown.getOHLCV('CAKE', '1h', 48);
    assert.equal(live.tier, 'live');

    const down = new TieredMarketData(stubCmc({}), cacheDir);
    const cached = await down.getOHLCV('CAKE', '1h', 48);
    assert.equal(cached.tier, 'cache');
    assert.equal(cached.degraded, true);
    assert.equal(cached.stale, false);
    assert.equal(cached.value.candles.length, 48);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('live failure with no cache falls through to the mock tier', async () => {
  const cacheDir = tmpCacheDir();
  try {
    const md = new TieredMarketData(stubCmc({}), cacheDir);
    const result = await md.getOHLCV('CAKE', '1h', 48);
    assert.equal(result.tier, 'mock');
    assert.equal(result.degraded, true);
    assert.equal(result.value.candles.length, 48);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('a hollow live snapshot (zero quotes) is treated as a live failure', async () => {
  const cacheDir = tmpCacheDir();
  try {
    const md = new TieredMarketData(
      stubCmc({ snapshot: async () => syntheticSnapshot(['CAKE']) }),
      cacheDir,
    );
    const result = await md.getMarketSnapshot(['CAKE']);
    assert.equal(result.tier, 'mock');
    assert.equal(result.degraded, true);
    assert.equal(result.value.quotes.size, 0);
    assert.equal(result.value.fearGreed.value, 50);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('mock candles are deterministic for the same token', () => {
  const a = syntheticCandles('CAKE', 24);
  const b = syntheticCandles('CAKE', 24);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, syntheticCandles('ETH', 24));
});
