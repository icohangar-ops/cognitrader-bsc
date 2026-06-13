// ============================================================
// Tests for the slippage / minOut money-math (src/integrations/slippage.ts)
// Run with: npm test
// ============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMinOut, BPS_DENOMINATOR, MAX_SLIPPAGE_BPS } from '../src/integrations/slippage';

// 1 token with 18 decimals = 10^18 wei
const ONE = 1_000_000_000_000_000_000n;

test('100 bps (1%) slippage on 1 token => 0.99 tokens', () => {
  // expected: 1e18 * (10000 - 100) / 10000 = 1e18 * 9900 / 10000 = 0.99e18
  assert.equal(computeMinOut(ONE, 100), 990_000_000_000_000_000n);
});

test('50 bps (0.5%) slippage on 1 token => 0.995 tokens', () => {
  assert.equal(computeMinOut(ONE, 50), 995_000_000_000_000_000n);
});

test('250 bps (2.5%) on a non-round expected amount', () => {
  // expectedOut = 1_234_567 wei ; 1234567 * 9750 / 10000 = 1203702.825 -> truncates to 1203702
  assert.equal(computeMinOut(1_234_567n, 250), 1_203_702n);
});

test('0 bps slippage => minOut equals expectedOut exactly (no haircut)', () => {
  assert.equal(computeMinOut(ONE, 0), ONE);
  assert.equal(computeMinOut(7_777_777_777n, 0), 7_777_777_777n);
});

test('MAX (10000 bps = 100%) slippage => minOut is 0 (accept any output)', () => {
  assert.equal(computeMinOut(ONE, MAX_SLIPPAGE_BPS), 0n);
  assert.equal(computeMinOut(123_456_789n, 10000), 0n);
});

test('9999 bps (99.99%) => keeps only 1 bps of expected', () => {
  // 1e18 * 1 / 10000 = 1e14
  assert.equal(computeMinOut(ONE, 9999), 100_000_000_000_000n);
});

test('expectedOut of 0 => 0 for any valid slippage', () => {
  assert.equal(computeMinOut(0n, 0), 0n);
  assert.equal(computeMinOut(0n, 100), 0n);
  assert.equal(computeMinOut(0n, 10000), 0n);
});

test('BigInt division truncates toward zero (does not round up)', () => {
  // 3 wei * 9999 / 10000 = 2.9997 -> 2 (truncated), proving minOut is never optimistic
  assert.equal(computeMinOut(3n, 1), 2n);
  // result must never exceed expectedOut
  assert.ok(computeMinOut(3n, 1) <= 3n);
});

test('minOut is monotonic: more slippage never yields a larger minOut', () => {
  let prev = computeMinOut(ONE, 0);
  for (const bps of [1, 10, 100, 500, 1000, 5000, 9999, 10000]) {
    const cur = computeMinOut(ONE, bps);
    assert.ok(cur <= prev, `minOut at ${bps}bps (${cur}) should be <= previous (${prev})`);
    assert.ok(cur >= 0n, `minOut must never be negative`);
    prev = cur;
  }
});

test('handles very large amounts without precision loss (BigInt, not float)', () => {
  const huge = 123_456_789_012_345_678_901_234_567_890n; // way beyond Number.MAX_SAFE_INTEGER
  // 300 bps => * 9700 / 10000
  assert.equal(computeMinOut(huge, 300), (huge * 9700n) / 10000n);
});

// ─── Edge / bug-class guards ───────────────────────────────

test('rejects negative slippageBps (would inflate minOut above expected)', () => {
  assert.throws(() => computeMinOut(ONE, -1), /out of range/);
});

test('rejects slippageBps above 10000 (would produce negative minOut)', () => {
  assert.throws(() => computeMinOut(ONE, 10001), /out of range/);
  // proves the guard prevents the catastrophic negative-minOut case:
  // without it, 1e18 * (10000-10001)/10000 = -1e14 (a negative floor that
  // would let a swap execute at ANY price).
});

test('rejects non-integer slippageBps', () => {
  assert.throws(() => computeMinOut(ONE, 12.5), /must be an integer/);
});

test('rejects negative expectedOut', () => {
  assert.throws(() => computeMinOut(-1n, 100), /non-negative/);
});

test('exported constants match the on-chain bps convention', () => {
  assert.equal(BPS_DENOMINATOR, 10000n);
  assert.equal(MAX_SLIPPAGE_BPS, 10000);
});

test('characterization: matches the original inline bsc.ts expression', () => {
  // original code was: expectedOut * BigInt(10000 - slippageBps) / 10000n
  for (const expected of [ONE, 1n, 999_999_999n, 5_000_000_000_000n]) {
    for (const bps of [0, 1, 50, 100, 333, 1000, 9999, 10000]) {
      const original = (expected * BigInt(10000 - bps)) / 10000n;
      assert.equal(computeMinOut(expected, bps), original, `mismatch at expected=${expected} bps=${bps}`);
    }
  }
});
