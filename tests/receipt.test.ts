// ============================================================
// Tests for trade-execution receipts (src/chp/receipt.ts, ported
// from cubiczan-chp-mcp src/receipt.ts)
// Proves: a fresh valid receipt verifies; tampering any bound
// field fails the MAC; the same receipt cannot replay; expiry and
// wrong-policy/wrong-key receipts are refused; deny receipts parse
// but never pass execution.
// Run with: npm test
// ============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  issueTradeReceipt,
  hashTradeArgs,
  parseTradeReceipt,
  verifyExecutionReceipt,
  type TradeApprovalReceipt,
  type TradeReceiptArgs,
} from '../src/chp/receipt';
import { InMemoryReplayStore } from '../src/chp/replay';

const KEY = 'test-receipt-key';
const ARGS: TradeReceiptArgs = {
  token: 'CAKE',
  direction: 'LONG',
  amountIn: '0.5000',
  slippageTolerance: 50,
  deadline: 1900000000,
};

function issueValid(now = Date.now()): TradeApprovalReceipt {
  return issueTradeReceipt(
    {
      actor: 'alice',
      resource: 'execute_trade:LONG:CAKE',
      args_hash: hashTradeArgs(ARGS),
      policy_version: 'test',
      risk: 'medium',
      decision: 'allow',
      ttlMs: 5 * 60 * 1000,
      issued_at: new Date(now).toISOString(),
    },
    KEY,
  );
}

test('a freshly issued receipt verifies and binds its args hash', () => {
  const receipt = issueValid();
  const replay = new InMemoryReplayStore();
  const ok = verifyExecutionReceipt(
    receipt,
    { argsHash: hashTradeArgs(ARGS), policyVersion: 'test', key: KEY },
    replay,
  );
  assert.ok(ok.ok);
});

test('tampering any signed field breaks the signature', () => {
  const replay = new InMemoryReplayStore();
  const tampered: TradeApprovalReceipt = {
    ...issueValid(),
    args_hash: hashTradeArgs({ ...ARGS, amountIn: '9.9999' }),
  };
  const result = verifyExecutionReceipt(
    tampered,
    { argsHash: hashTradeArgs({ ...ARGS, amountIn: '9.9999' }), policyVersion: 'test', key: KEY },
    replay,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /signature/);
});

test('the same receipt cannot replay', () => {
  const receipt = issueValid();
  const replay = new InMemoryReplayStore();
  const expected = { argsHash: hashTradeArgs(ARGS), policyVersion: 'test', key: KEY };
  assert.ok(verifyExecutionReceipt(receipt, expected, replay).ok);
  const second = verifyExecutionReceipt(receipt, expected, replay);
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.reason, /replay/);
});

test('an expired receipt is refused', () => {
  const receipt = issueTradeReceipt(
    {
      actor: 'alice',
      resource: 'execute_trade:LONG:CAKE',
      args_hash: hashTradeArgs(ARGS),
      policy_version: 'test',
      risk: 'medium',
      decision: 'allow',
      ttlMs: 1000,
      issued_at: new Date(Date.now() - 10_000).toISOString(),
    },
    KEY,
  );
  const result = verifyExecutionReceipt(
    receipt,
    { argsHash: hashTradeArgs(ARGS), policyVersion: 'test', key: KEY },
    new InMemoryReplayStore(),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /expired/);
});

test('a receipt signed with a different key is refused', () => {
  const receipt = issueValid();
  const result = verifyExecutionReceipt(
    receipt,
    { argsHash: hashTradeArgs(ARGS), policyVersion: 'test', key: 'attacker-key' },
    new InMemoryReplayStore(),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /signature/);
});

test('a deny receipt parses but never passes execution', () => {
  const deny = issueTradeReceipt(
    {
      actor: 'policy:chp',
      resource: 'execute_trade:LONG:CAKE',
      args_hash: hashTradeArgs(ARGS),
      policy_version: 'test',
      risk: 'high',
      decision: 'deny',
      ttlMs: 60_000,
    },
    KEY,
  );
  assert.ok(parseTradeReceipt(deny));
  const result = verifyExecutionReceipt(
    deny,
    { argsHash: hashTradeArgs(ARGS), policyVersion: 'test', key: KEY },
    new InMemoryReplayStore(),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /deny/);
});

test('a missing receipt fails closed with an unparseable-receipt reason', () => {
  const result = verifyExecutionReceipt(
    undefined,
    { argsHash: hashTradeArgs(ARGS), policyVersion: 'test', key: KEY },
    new InMemoryReplayStore(),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /unparseable or incomplete/);
});

test('a policy-version mismatch is refused', () => {
  const receipt = issueValid();
  const result = verifyExecutionReceipt(
    receipt,
    { argsHash: hashTradeArgs(ARGS), policyVersion: 'other-policy', key: KEY },
    new InMemoryReplayStore(),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /policy_version/);
});
