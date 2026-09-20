// ============================================================
// Tests for the CHP trade hardening gate (consensus-hardening-
// protocol Profile A port: src/chp/hardening.ts + friends)
// Mirrors the erp-control-plane CHP suite (tests/test_genbi_chp.py):
// R0 refusal, deterministic foundation scoring with the defi floor
// (85), human lock flow, ledger round trip + tamper detection, and
// trading-loop integration.
// Run with: npm test
// ============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ChpGate } from '../src/chp/gate';
import {
  ChpTradeGate,
  ChpRejection,
  chpSettingsFromEnv,
  type DecisionCase,
} from '../src/chp/hardening';
import { evaluateR0Gate } from '../src/chp/r0';
import {
  foundationFloor,
  FULL_SCORE,
  type ParityEvidence,
} from '../src/chp/foundation';
import type { AgentConfig, AggregatedSignal } from '../src/utils/types';
import type { BSCClient } from '../src/integrations/bsc';
import type { TrustWalletAgentKit } from '../src/integrations/twak';
import type { RiskManager } from '../src/agent/RiskManager';
import type { BNBAgentSDK } from '../src/integrations/bnb-agent-sdk';
import { StrategyEngine } from '../src/agent/StrategyEngine';

const CONFIRMER = 'sam@cubiczan.com';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chp-cognitrader-'));
}

function withinToleranceParity(expected: number, actual: number): ParityEvidence {
  return {
    caseId: 'portfolio-sizing-assertion',
    metric: 'trade_size_bnb',
    unit: 'bnb',
    expected,
    tolerance: 0.001,
    actual,
    withinTolerance: Math.abs(actual - expected) <= 0.001,
  };
}

function hardenedGate(
  ledgerPath: string,
  requireHumanLock = false,
): ChpTradeGate {
  return new ChpTradeGate(
    { requireHumanLock, ledgerPath, domain: 'defi' },
  );
}

// ─────────────────────────────────────────────── R0 (gate level)

test('R0 gate: failures are FATAL per capitalized criterion and HALT', () => {
  const evaluation = evaluateR0Gate({
    solvable: true,
    scoped: true,
    valid: false,
    worth_it: false,
  });
  assert.equal(evaluation.results.Solvable, 'PASS');
  assert.equal(evaluation.results.Scoped, 'PASS');
  assert.equal(evaluation.results.Valid, 'FATAL');
  assert.equal(evaluation.results.Worth_it, 'FATAL');
  assert.equal(evaluation.verdict, 'HALT');
});

test('R0 gate: a fully solvable decision passes', () => {
  const evaluation = evaluateR0Gate({
    solvable: true,
    scoped: true,
    valid: true,
    worth_it: true,
  });
  assert.equal(evaluation.verdict, 'PASS');
});

test('R0 refusal: not worth it refuses the trade before the engine', () => {
  const gate = hardenedGate(tmpDir());
  assert.throws(
    () => gate.openR0({ solvable: true, scoped: true, valid: true, worth_it: false }),
    (error: unknown) => {
      assert.ok(error instanceof ChpRejection);
      assert.equal(error.evaluation?.results['Worth_it'], 'FATAL');
      assert.match(error.message, /Worth_it/);
      return true;
    },
  );
});

test('R0 refusal: an unsolvable decision fails Solvable', () => {
  const gate = hardenedGate(tmpDir());
  assert.throws(
    () => gate.openR0({ solvable: false, scoped: true, valid: true, worth_it: true }),
    (error: unknown) => {
      assert.ok(error instanceof ChpRejection);
      assert.equal(error.evaluation?.results['Solvable'], 'FATAL');
      return true;
    },
  );
});

// ──────────────────────────────── Foundation pass (deterministic)

test('state parity scores a full defi foundation (100 >= floor 85)', () => {
  const gate = hardenedGate(tmpDir());
  const assessment = gate.assessFoundation({
    guardrailsPassed: true,
    guardrailDetail: 'TWAK policy allowed; risk approved; spend gate passed',
    boundedResult: true,
    boundedDetail: '5 BNB vs available 100 BNB',
    parity: withinToleranceParity(5, 5),
  });
  assert.equal(assessment.domain, 'defi');
  assert.equal(assessment.score, FULL_SCORE);
  assert.equal(assessment.stateMatched, true);
});

test('defi floor is 85 and guardrails+bounded alone (70) stay below it', () => {
  assert.equal(foundationFloor('defi'), 85);
  assert.equal(foundationFloor('blockchain'), 85);
  assert.equal(foundationFloor('finance'), 100);
  assert.equal(foundationFloor('unknown-domain'), 70);

  const gate = hardenedGate(tmpDir());
  const assessment = gate.assessFoundation({
    guardrailsPassed: true,
    guardrailDetail: 'ok',
    boundedResult: true,
    boundedDetail: 'ok',
    parity: null,
  });
  assert.equal(assessment.score, 70); // guardrails 40 + bounded 30; no parity
  assert.equal(assessment.stateMatched, false);
});

test('failed guardrails score 40 and cannot self-certify', () => {
  const gate = hardenedGate(tmpDir());
  const assessment = gate.assessFoundation({
    guardrailsPassed: false,
    guardrailDetail: 'risk refused',
    boundedResult: true,
    boundedDetail: 'ok',
    parity: withinToleranceParity(5, 5),
  });
  assert.equal(assessment.score, 60); // bounded 30 + parity 30; no guardrails
});

test('a state parity MISMATCH is fatal even with a named confirmer', () => {
  const gate = hardenedGate(tmpDir());
  const r0 = gate.openR0({ solvable: true, scoped: true, valid: true, worth_it: true });
  assert.throws(
    () =>
      gate.harden({
        token: 'CAKE',
        direction: 'LONG',
        amountInBnb: 5,
        reasoning: 'test',
        sizingBasisBnb: 100,
        r0,
        guardrailsPassed: true,
        guardrailDetail: 'ok',
        boundedResult: true,
        boundedDetail: 'ok',
        parity: {
          caseId: 'portfolio-sizing-assertion',
          metric: 'trade_size_bnb',
          unit: 'bnb',
          expected: 10,
          tolerance: 0.001,
          actual: 5,
          withinTolerance: false,
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ChpRejection);
      assert.match(error.message, /MISMATCH/);
      return true;
    },
  );
});

// ───────────────────────────────────────────────────── human lock

test('hardened case opens PROVISIONAL_LOCK and locks with a confirmer', () => {
  const gate = hardenedGate(tmpDir());
  const r0 = gate.openR0({ solvable: true, scoped: true, valid: true, worth_it: true });
  const { kase, foundationVerdict } = gate.harden({
    token: 'CAKE',
    direction: 'LONG',
    amountInBnb: 5,
    reasoning: 'test',
    sizingBasisBnb: 100,
    r0,
    guardrailsPassed: true,
    guardrailDetail: 'ok',
    boundedResult: true,
    boundedDetail: 'ok',
    parity: withinToleranceParity(5, 5),
  });
  assert.equal(foundationVerdict, 'PASS');
  assert.equal(kase.status, 'PROVISIONAL_LOCK');
  assert.equal(gate.confirm(kase, CONFIRMER), 'LOCKED');
  assert.deepEqual(kase.lockedDecisions, [`${CONFIRMER}:${kase.decisionId}`]);
});

test('a REFRAME verdict cannot self-certify without the human lock', () => {
  const gate = hardenedGate(tmpDir(), false); // lock flag OFF
  const r0 = gate.openR0({ solvable: true, scoped: true, valid: true, worth_it: true });
  const { foundationVerdict } = gate.harden({
    token: 'CAKE',
    direction: 'LONG',
    amountInBnb: 5,
    reasoning: 'test',
    sizingBasisBnb: 100,
    r0,
    guardrailsPassed: true,
    guardrailDetail: 'ok',
    boundedResult: true,
    boundedDetail: 'ok',
    parity: null, // no parity evidence -> 70 < 85 -> REFRAME
  });
  assert.equal(foundationVerdict, 'REFRAME');
});

// ──────────────────────────────────────────────────────── ledger

function recordedCase(gate: ChpTradeGate): { kase: DecisionCase; entry: ReturnType<ChpTradeGate['record']> } {
  const r0 = gate.openR0({ solvable: true, scoped: true, valid: true, worth_it: true });
  const { kase, assessment, r0Verdict, foundationVerdict } = gate.harden({
    token: 'CAKE',
    direction: 'LONG',
    amountInBnb: 5,
    reasoning: 'parity-held trade',
    sizingBasisBnb: 100,
    r0,
    guardrailsPassed: true,
    guardrailDetail: 'ok',
    boundedResult: true,
    boundedDetail: 'ok',
    parity: withinToleranceParity(5, 5),
  });
  gate.confirm(kase, CONFIRMER);
  const entry = gate.record({
    kase,
    assessment,
    r0Verdict,
    foundationVerdict,
    token: 'CAKE',
    direction: 'LONG',
    amountInBnb: 5,
    reasoning: 'parity-held trade',
    artifacts: { txHash: '0xstub', success: true },
    confirmedBy: CONFIRMER,
  });
  return { kase, entry };
}

test('decision record seals an envelope and round trips through the ledger', () => {
  const dir = tmpDir();
  const gate = hardenedGate(path.join(dir, 'decisions.jsonl'));
  const { kase, entry } = recordedCase(gate);

  const listing = gate.records.list();
  assert.equal(listing.length, 1);
  assert.equal(listing[0]['envelope_valid'], true);
  assert.equal(listing[0]['integrity_valid'], true);
  assert.equal(listing[0]['decision_id'], entry.decision_id);
  assert.equal(listing[0]['confirmed_by'], CONFIRMER);
  assert.equal(listing[0]['session_status'], 'LOCKED');
  assert.equal(gate.records.get(kase.decisionId)?.body.includes('CAKE'), true);
  assert.equal(gate.records.get('trade-missing'), null);
});

test('tampered ledger bodies read as integrity invalid, envelope still valid', () => {
  const dir = tmpDir();
  const ledgerPath = path.join(dir, 'decisions.jsonl');
  const gate = hardenedGate(ledgerPath);
  recordedCase(gate);

  const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
  const entry = JSON.parse(lines[0]) as Record<string, unknown>;
  // Tamper with the sealed payload body: inflate the foundation score.
  entry['body'] = (entry['body'] as string).replace(
    '"foundation_score":100',
    '"foundation_score":70',
  );
  lines[0] = JSON.stringify(entry);
  fs.writeFileSync(ledgerPath, lines.join('\n') + '\n', 'utf8');

  const record = gate.records.list()[0];
  assert.equal(record['integrity_valid'], false);
  assert.equal(record['envelope_valid'], true); // the CHP envelope checks structure only
});

// ─────────────────────────────────────── trading-loop integration

function makeEngine(options: {
  ledgerPath: string;
  requireHumanLock?: boolean;
  confidence?: number;
  compositeScore?: number;
  sizingBase?: number;
}): { engine: StrategyEngine; gate: ChpTradeGate } {
  const config: AgentConfig = {
    pollingIntervalMs: 60000,
    maxConcurrentPositions: 3,
    maxPositionPct: 0.1,
    stopLossPct: 0.05,
    takeProfitPct: 0.1,
    dailyDrawdownLimitPct: 0.2,
    minSignalScore: 60,
    minConfidence: 0.5,
    slippageBps: 100,
    dryRun: true,
    strategies: ['MOMENTUM'],
    tokens: ['CAKE'],
    logLevel: 'error',
    bnbPriceUsd: 600,
  };
  const tradeResult = {
    success: true,
    txHash: '0xstub',
    fromToken: 'BNB',
    toToken: 'CAKE',
    amountIn: '5.0000',
    amountOut: '10',
    gasUsed: '0',
    gasPrice: '0',
    blockNumber: 0,
    timestamp: 0,
  };
  const bsc = {
    getBNBBalance: async () => 100,
    getPriceBNB: async () => 1,
    swapBNBForToken: async () => tradeResult,
    swapTokenForBNB: async () => tradeResult,
  } as unknown as BSCClient;
  const twak = {
    checkPolicy: () => ({ allowed: true }),
  } as unknown as TrustWalletAgentKit;
  const risk = {
    getDailyStartValue: () => options.sizingBase ?? 100,
    updatePortfolio: (state: never) => state,
    assessRisk: () => ({
      approved: true,
      positionSize: '5.0000',
      maxPositionPct: 0.1,
      stopLossPct: 0.05,
      takeProfitPct: 0.1,
      riskRewardRatio: 2,
      reasons: [],
      warnings: [],
    }),
  } as unknown as RiskManager;
  const agentSDK = { addTradeMemory: () => {} } as unknown as BNBAgentSDK;
  // Spend gate set generous so the CHP hardening path is the one under test.
  const spendGate = new ChpGate({
    version: 'test',
    maxNotionalUsd: 1_000_000,
    dailyNotionalCapUsd: 1_000_000,
    hitlThresholdUsd: 1_000_000,
    allowedActions: ['LONG', 'SHORT'],
    perAssetLimits: {},
    minConfidence: 0.5,
  });
  const gate = new ChpTradeGate({
    requireHumanLock: options.requireHumanLock ?? true,
    ledgerPath: options.ledgerPath,
    domain: 'defi',
  });
  const engine = new StrategyEngine(config, bsc, twak, risk, agentSDK, spendGate, gate);
  return { engine, gate };
}

function makeSignal(overrides: Partial<AggregatedSignal> = {}): AggregatedSignal {
  return {
    token: 'CAKE',
    signals: [
      {
        token: 'CAKE',
        strategy: 'MOMENTUM',
        direction: 'LONG',
        strength: 'STRONG',
        score: 75,
        confidence: 0.8,
        reasoning: 'test signal',
        timestamp: 0,
        metadata: {},
      },
    ],
    compositeScore: 75,
    consensusDirection: 'LONG',
    consensusStrength: 'STRONG',
    riskScore: 20,
    timestamp: Date.now(),
    ...overrides,
  };
}

test('trading loop: human lock parks the trade until a confirmer locks it', async () => {
  const dir = tmpDir();
  const { engine } = makeEngine({ ledgerPath: path.join(dir, 'decisions.jsonl'), requireHumanLock: true });

  const results = await engine.executeSignals([makeSignal()]);
  assert.equal(results.length, 1);
  assert.equal(results[0].txHash, ''); // not executed

  const pending = engine.getPendingChpDecisions();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'PROVISIONAL_LOCK');
  assert.equal(pending[0].foundationScore, 100);
  assert.equal(engine.getChpDecisions().length, 0); // nothing persisted yet

  const executed = await engine.confirmTradeDecision(pending[0].decisionId, CONFIRMER);
  assert.ok(executed);
  assert.match(executed.txHash, /^dry-run-/); // dryRun config: no live swap

  const record = engine.getChpDecision(pending[0].decisionId);
  assert.equal(record?.session_status, 'LOCKED');
  assert.equal(record?.confirmed_by, CONFIRMER);
  assert.equal(record?.integrity_valid, true);
  assert.equal(engine.getPendingChpDecisions().length, 0);
});

test('trading loop: R0 refuses an unworthy signal before anything runs', async () => {
  const dir = tmpDir();
  const { engine } = makeEngine({ ledgerPath: path.join(dir, 'decisions.jsonl'), requireHumanLock: true });

  const weak = makeSignal({
    signals: [
      {
        token: 'CAKE',
        strategy: 'MOMENTUM',
        direction: 'LONG',
        strength: 'WEAK',
        score: 40,
        confidence: 0.3,
        reasoning: 'weak',
        timestamp: 0,
        metadata: {},
      },
    ],
    compositeScore: 40,
    consensusStrength: 'WEAK',
  });
  const results = await engine.executeSignals([weak]);
  assert.equal(results[0].txHash, '');
  assert.equal(engine.getPendingChpDecisions().length, 0); // R0 refused: no case
  assert.equal(engine.getChpDecisions().length, 0);
});

test('trading loop: with the lock flag off, a REFRAME trade is refused outright', async () => {
  const dir = tmpDir();
  const { engine } = makeEngine({
    ledgerPath: path.join(dir, 'decisions.jsonl'),
    requireHumanLock: false,
    sizingBase: 0, // no portfolio state -> no parity evidence -> REFRAME
  });

  const results = await engine.executeSignals([makeSignal()]);
  assert.equal(results[0].txHash, '');
  assert.equal(engine.getChpDecisions().length, 0); // refused, nothing recorded
  assert.equal(engine.getPendingChpDecisions().length, 0);
});

test('trading loop: with the lock flag off, a parity-held trade self-certifies and records', async () => {
  const dir = tmpDir();
  const { engine } = makeEngine({
    ledgerPath: path.join(dir, 'decisions.jsonl'),
    requireHumanLock: false,
  });

  const results = await engine.executeSignals([makeSignal()]);
  assert.match(results[0].txHash, /^dry-run-/); // dryRun config: no live swap

  const record = engine.getChpDecisions()[0];
  assert.equal(record.session_status, 'PROVISIONAL_LOCK'); // unlocked proceed
  assert.equal(record.confirmed_by, null);
  assert.equal(record.foundation_score, 100);
  assert.equal(record.r0_verdict, 'PASS');
  assert.equal(record.integrity_valid, true);
});

// ─────────────────────────────────────────────────────── env flag

test('CHP_REQUIRE_HUMAN_LOCK defaults ON and parses explicit values', () => {
  assert.equal(chpSettingsFromEnv({} as NodeJS.ProcessEnv).requireHumanLock, true);
  assert.equal(chpSettingsFromEnv({ CHP_REQUIRE_HUMAN_LOCK: '1' } as NodeJS.ProcessEnv).requireHumanLock, true);
  assert.equal(chpSettingsFromEnv({ CHP_REQUIRE_HUMAN_LOCK: '0' } as NodeJS.ProcessEnv).requireHumanLock, false);
  assert.equal(chpSettingsFromEnv({ CHP_REQUIRE_HUMAN_LOCK: 'false' } as NodeJS.ProcessEnv).requireHumanLock, false);
  const withPath = chpSettingsFromEnv({ CHP_LEDGER_PATH: '/tmp/x.jsonl' } as NodeJS.ProcessEnv);
  assert.equal(withPath.ledgerPath, '/tmp/x.jsonl');
});
