// ============================================================
// Tests for adversarial split damping in signal orchestration
// (src/integrations/bnb-agent-sdk.ts, ported from swarmfi-preps
// src/lib/swarm/consensus.ts)
// Proves: a 2-vs-1 near-tie damps the composite (×0.7); a
// unanimous sweep does not; a 1-vs-1 split (below the ≥3
// directional floor) is not damped.
// Run with: npm test
// ============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BNBAgentSDK } from '../src/integrations/bnb-agent-sdk';
import type { AgentConfig, Signal } from '../src/utils/types';

function makeConfig(): AgentConfig {
  return {
    strategies: ['MOMENTUM', 'SENTIMENT', 'MEAN_REVERSION'],
    minSignalScore: 65,
    minConfidence: 0.6,
    maxPositionPct: 0.1,
    maxConcurrentPositions: 3,
    stopLossPct: 0.05,
    takeProfitPct: 0.15,
    dailyDrawdownLimitPct: 0.1,
    slippageBps: 50,
    pollingIntervalMs: 30000,
    dryRun: true,
    tokens: ['CAKE'],
  } as unknown as AgentConfig;
}

let seq = 0;
function makeSignal(
  strategy: Signal['strategy'],
  direction: Signal['direction'],
  score: number,
): Signal {
  seq += 1;
  return {
    token: 'CAKE',
    strategy,
    direction,
    strength: score >= 85 ? 'STRONG' : score >= 60 ? 'MODERATE' : 'WEAK',
    score,
    confidence: 0.8,
    reasoning: `test-${seq}`,
    timestamp: Date.now(),
    metadata: {},
  };
}

test('2-vs-1 directional split damps the composite by ×0.7', () => {
  const sdk = new BNBAgentSDK(makeConfig());
  const signals = [
    makeSignal('MOMENTUM', 'LONG', 80),   // 80 × 0.4 = 32
    makeSignal('SENTIMENT', 'SHORT', 70), // 70 × 0.35 = 24.5
    makeSignal('MEAN_REVERSION', 'LONG', 85), // 85 × 0.25 = 21.25
  ];

  return sdk.orchestrateSignal(signals).then((aggregated) => {
    // base composite 77.75, balanceRatio 1/3 < 0.35 with 3 directional → ×0.7
    assert.equal(aggregated.splitDamping, 0.7);
    assert.equal(aggregated.compositeScore, Math.round(77.75 * 0.7 * 100) / 100);
    assert.equal(aggregated.consensusDirection, 'LONG');
    assert.equal(aggregated.consensusStrength, 'WEAK'); // damped below 65
  });
});

test('unanimous sweep is not damped', () => {
  const sdk = new BNBAgentSDK(makeConfig());
  const signals = [
    makeSignal('MOMENTUM', 'LONG', 80),
    makeSignal('SENTIMENT', 'LONG', 85),
    makeSignal('MEAN_REVERSION', 'LONG', 90),
  ];

  return sdk.orchestrateSignal(signals).then((aggregated) => {
    assert.equal(aggregated.splitDamping, 1);
    assert.equal(aggregated.compositeScore, 84.25);
    assert.equal(aggregated.consensusStrength, 'STRONG');
  });
});

test('1-vs-1 split (two directional voters) is not damped — below the ≥3 floor', () => {
  const sdk = new BNBAgentSDK(makeConfig());
  const signals = [
    makeSignal('MOMENTUM', 'LONG', 80),
    makeSignal('SENTIMENT', 'SHORT', 80),
  ];

  return sdk.orchestrateSignal(signals).then((aggregated) => {
    assert.equal(aggregated.splitDamping, 1);
    assert.equal(aggregated.compositeScore, 80);
    assert.equal(aggregated.consensusDirection, 'HOLD');
  });
});
