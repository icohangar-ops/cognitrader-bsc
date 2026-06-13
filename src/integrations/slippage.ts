// ============================================================
// CogniTrader BSC — Slippage / minOut math (pure, testable)
// ============================================================
//
// Extracted from BSCClient swap paths so the money-critical
// minOut computation can be unit-tested in isolation (the swap
// methods themselves require a live RPC endpoint).

export const BPS_DENOMINATOR = 10000n;
export const MAX_SLIPPAGE_BPS = 10000;

/**
 * Compute the minimum acceptable output amount for a swap given an
 * expected output and a slippage tolerance in basis points.
 *
 *   minOut = expectedOut * (10000 - slippageBps) / 10000   (integer / BigInt math)
 *
 * 1 bps = 0.01%. 100 bps = 1%. 10000 bps = 100% (minOut = 0, i.e. accept any output).
 *
 * Division truncates toward zero (BigInt semantics), matching the on-chain
 * router behaviour and the original inline expression in bsc.ts.
 *
 * @throws if slippageBps is out of the [0, 10000] range, non-integer, or expectedOut is negative.
 */
export function computeMinOut(expectedOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps)) {
    throw new Error(`slippageBps must be an integer, got ${slippageBps}`);
  }
  if (slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error(`slippageBps out of range [0, ${MAX_SLIPPAGE_BPS}]: ${slippageBps}`);
  }
  if (expectedOut < 0n) {
    throw new Error(`expectedOut must be non-negative, got ${expectedOut}`);
  }

  return (expectedOut * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR;
}
