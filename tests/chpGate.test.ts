// ============================================================
// Tests for the CHP decision gate (src/chp/gate.ts)
// Proves: under-threshold trades LOCK and execute; over-threshold
// trades require HITL; over-max trades are BLOCKED.
// Run with: npm test
// ============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChpGate } from '../src/chp/gate';
import type { RiskPolicy } from '../src/chp/policy';

function makePolicy(overrides: Partial<RiskPolicy> = {}): RiskPolicy {
  return {
    version: 'test',
    maxNotionalUsd: 5000,
    dailyNotionalCapUsd: 20000,
    hitlThresholdUsd: 1000,
    allowedActions: ['LONG', 'SHORT'],
    perAssetLimits: { CAKE: 2000 },
    minConfidence: 0.5,
    ...overrides,
  };
}

test('under-threshold trade is LOCKED and allowed', () => {
  const gate = new ChpGate(makePolicy());
  const d = gate.evaluate({ action: 'LONG', asset: 'ETH', notionalUsd: 500, confidence: 0.8 });
  assert.equal(d.allowed, true);
  assert.equal(d.requiresHuman, false);
  assert.equal(d.state, 'LOCKED');
});

test('trade at/over the HITL threshold requires human approval (not allowed)', () => {
  const gate = new ChpGate(makePolicy({ hitlThresholdUsd: 1000 }));
  const d = gate.evaluate({ action: 'LONG', asset: 'ETH', notionalUsd: 1500, confidence: 0.8 });
  assert.equal(d.allowed, false);
  assert.equal(d.requiresHuman, true);
  assert.equal(d.state, 'HITL_REQUIRED');
});

test('trade exceeding max notional is BLOCKED outright', () => {
  const gate = new ChpGate(makePolicy({ maxNotionalUsd: 5000 }));
  const d = gate.evaluate({ action: 'LONG', asset: 'ETH', notionalUsd: 6000, confidence: 0.9 });
  assert.equal(d.allowed, false);
  assert.equal(d.requiresHuman, false);
  assert.equal(d.state, 'BLOCKED');
});

test('per-asset cap blocks even an under-max trade', () => {
  const gate = new ChpGate(makePolicy({ perAssetLimits: { CAKE: 2000 } }));
  const d = gate.evaluate({ action: 'LONG', asset: 'CAKE', notionalUsd: 2500, confidence: 0.9 });
  assert.equal(d.allowed, false);
  assert.equal(d.state, 'BLOCKED');
  assert.ok(d.provenance.claims.some((c) => c.rule === 'per-asset-cap' && !c.passed));
});

test('disallowed action is BLOCKED', () => {
  const gate = new ChpGate(makePolicy({ allowedActions: ['LONG'] }));
  const d = gate.evaluate({ action: 'SHORT', asset: 'ETH', notionalUsd: 100, confidence: 0.9 });
  assert.equal(d.allowed, false);
  assert.equal(d.state, 'BLOCKED');
});

test('low-confidence signal fails the adversarial check', () => {
  const gate = new ChpGate(makePolicy({ minConfidence: 0.6 }));
  const d = gate.evaluate({ action: 'LONG', asset: 'ETH', notionalUsd: 100, confidence: 0.3 });
  assert.equal(d.allowed, false);
  assert.ok(d.provenance.claims.some((c) => c.rule === 'min-confidence' && !c.passed));
});

test('daily notional cap blocks once cumulative spend is exceeded', () => {
  const gate = new ChpGate(makePolicy({ dailyNotionalCapUsd: 1000, hitlThresholdUsd: 10000 }));
  // Three $400 trades = $1200 > $1000 cap; the third must block.
  assert.equal(gate.evaluate({ action: 'LONG', asset: 'ETH', notionalUsd: 400, confidence: 0.9 }).allowed, true);
  assert.equal(gate.evaluate({ action: 'LONG', asset: 'ETH', notionalUsd: 400, confidence: 0.9 }).allowed, true);
  const third = gate.evaluate({ action: 'LONG', asset: 'ETH', notionalUsd: 400, confidence: 0.9 });
  assert.equal(third.allowed, false);
  assert.equal(third.state, 'BLOCKED');
});

test('human approval promotes a HITL trade to LOCKED', () => {
  const gate = new ChpGate(makePolicy());
  const first = gate.evaluate({ action: 'LONG', asset: 'ETH', notionalUsd: 1500, confidence: 0.9 });
  assert.equal(first.requiresHuman, true);
  const approved = gate.approveHuman(
    { action: 'LONG', asset: 'ETH', notionalUsd: 1500, confidence: 0.9 },
    'ops@cubiczan',
  );
  assert.equal(approved.allowed, true);
  assert.equal(approved.state, 'LOCKED');
});

test('every decision is recorded in the provenance ledger with a content hash', () => {
  const gate = new ChpGate(makePolicy());
  gate.evaluate({ action: 'LONG', asset: 'ETH', notionalUsd: 500, confidence: 0.8 });
  gate.evaluate({ action: 'LONG', asset: 'ETH', notionalUsd: 6000, confidence: 0.8 });
  const ledger = gate.getLedger();
  assert.equal(ledger.length, 2);
  for (const entry of ledger) {
    assert.ok(entry.decisionId.length > 0);
    assert.match(entry.contentHash, /^[a-f0-9]{64}$/);
    assert.ok(entry.claims.length > 0);
  }
});
