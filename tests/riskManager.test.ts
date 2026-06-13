// ============================================================
// Tests for RiskManager money-math (src/agent/RiskManager.ts)
// stop-loss / take-profit thresholds, position sizing, PnL,
// drawdown, Kelly sizing, portfolio heat.
// Run with: npm test
// ============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RiskManager } from '../src/agent/RiskManager';
import type { AgentConfig, Position, PortfolioState } from '../src/utils/types';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    pollingIntervalMs: 60000,
    maxConcurrentPositions: 3,
    maxPositionPct: 0.2, // 20%
    stopLossPct: 0.05, // 5%
    takeProfitPct: 0.15, // 15%
    dailyDrawdownLimitPct: 0.1, // 10%
    minSignalScore: 60,
    minConfidence: 0.5,
    slippageBps: 100,
    dryRun: true,
    strategies: ['MOMENTUM'],
    tokens: ['CAKE'],
    logLevel: 'error',
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    token: 'CAKE',
    symbol: 'CAKE',
    amount: '100',
    entryPrice: 100,
    currentPrice: 100,
    valueBNB: 1,
    pnl: 0,
    pnlPct: 0,
    openedAt: 0,
    stopLoss: 95,
    takeProfit: 115,
    ...overrides,
  };
}

// ─── Stop-loss / Take-profit thresholds ─────────────────────

test('stop-loss fires exactly at the threshold (-5%)', () => {
  const rm = new RiskManager(makeConfig({ stopLossPct: 0.05 }));
  // entry 100, current 95 => pnl = -5% == -stopLossPct => should exit
  const r = rm.evaluatePositionExit(makePosition({ entryPrice: 100, currentPrice: 95 }));
  assert.equal(r.shouldExit, true);
  assert.equal(r.type, 'STOP_LOSS');
});

test('stop-loss does NOT fire just above the threshold (-4.99%)', () => {
  const rm = new RiskManager(makeConfig({ stopLossPct: 0.05 }));
  const r = rm.evaluatePositionExit(makePosition({ entryPrice: 100, currentPrice: 95.01 }));
  assert.equal(r.shouldExit, false);
  assert.equal(r.type, 'NONE');
});

test('take-profit fires exactly at the threshold (+15%)', () => {
  const rm = new RiskManager(makeConfig({ takeProfitPct: 0.15 }));
  const r = rm.evaluatePositionExit(makePosition({ entryPrice: 100, currentPrice: 115 }));
  assert.equal(r.shouldExit, true);
  assert.equal(r.type, 'TAKE_PROFIT');
});

test('take-profit does NOT fire just below threshold (+14.99%)', () => {
  const rm = new RiskManager(makeConfig({ takeProfitPct: 0.15 }));
  const r = rm.evaluatePositionExit(makePosition({ entryPrice: 100, currentPrice: 114.99 }));
  assert.equal(r.shouldExit, false);
});

test('flat position (no move) does not exit', () => {
  const rm = new RiskManager(makeConfig());
  const r = rm.evaluatePositionExit(makePosition({ entryPrice: 100, currentPrice: 100 }));
  assert.equal(r.shouldExit, false);
  assert.equal(r.type, 'NONE');
});

test('invalid / zero / negative prices never trigger an exit', () => {
  const rm = new RiskManager(makeConfig());
  assert.equal(rm.evaluatePositionExit(makePosition({ currentPrice: 0 })).shouldExit, false);
  assert.equal(rm.evaluatePositionExit(makePosition({ entryPrice: 0 })).shouldExit, false);
  assert.equal(rm.evaluatePositionExit(makePosition({ currentPrice: -5 })).shouldExit, false);
});

test('deep loss beyond stop-loss still classified STOP_LOSS (not skipped)', () => {
  const rm = new RiskManager(makeConfig({ stopLossPct: 0.05 }));
  const r = rm.evaluatePositionExit(makePosition({ entryPrice: 100, currentPrice: 40 }));
  assert.equal(r.shouldExit, true);
  assert.equal(r.type, 'STOP_LOSS');
});

// ─── PnL / drawdown math (updatePortfolio) ──────────────────

function makePortfolio(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return {
    totalValueBNB: 100,
    availableBNB: 100,
    positions: [],
    dailyPnL: 0,
    dailyPnLPct: 0,
    maxDrawdown: 0,
    unrealizedPnL: 0,
    ...overrides,
  };
}

test('daily PnL computed against the baseline', () => {
  const rm = new RiskManager(makeConfig());
  rm.initializeDailyBaseline(100);
  const p = rm.updatePortfolio(makePortfolio({ totalValueBNB: 110 }));
  assert.equal(p.dailyPnL, 10);
  assert.ok(Math.abs(p.dailyPnLPct - 0.1) < 1e-12); // +10%
});

test('daily loss produces negative PnL pct', () => {
  const rm = new RiskManager(makeConfig());
  rm.initializeDailyBaseline(200);
  const p = rm.updatePortfolio(makePortfolio({ totalValueBNB: 180 }));
  assert.equal(p.dailyPnL, -20);
  assert.ok(Math.abs(p.dailyPnLPct - -0.1) < 1e-12); // -10%
});

test('max drawdown captures the worst peak-to-trough decline', () => {
  const rm = new RiskManager(makeConfig());
  rm.initializeDailyBaseline(100); // peak = 100
  rm.updatePortfolio(makePortfolio({ totalValueBNB: 150 })); // peak rises to 150
  const p = rm.updatePortfolio(makePortfolio({ totalValueBNB: 120 })); // drop from 150 to 120
  // drawdown = (150 - 120) / 150 = 0.2
  assert.ok(Math.abs(p.maxDrawdown - 0.2) < 1e-12);
});

test('drawdown does not shrink when portfolio recovers', () => {
  // maxDrawdown is stored on the portfolio object (peak is stored on the
  // RiskManager), so realistic usage threads ONE portfolio object through
  // successive updates — mirror that here.
  const rm = new RiskManager(makeConfig());
  rm.initializeDailyBaseline(100);
  const port = makePortfolio({ totalValueBNB: 150 });
  rm.updatePortfolio(port); // peak rises to 150
  port.totalValueBNB = 120;
  rm.updatePortfolio(port); // dd = (150-120)/150 = 0.2
  assert.ok(Math.abs(port.maxDrawdown - 0.2) < 1e-12);
  port.totalValueBNB = 149;
  rm.updatePortfolio(port); // recovery; dd should remain the worst-seen 0.2
  assert.ok(Math.abs(port.maxDrawdown - 0.2) < 1e-12);
});

test('unrealized PnL is the sum of position pnls', () => {
  const rm = new RiskManager(makeConfig());
  const p = rm.updatePortfolio(
    makePortfolio({
      positions: [makePosition({ pnl: 2.5 }), makePosition({ pnl: -1.0 }), makePosition({ pnl: 0.5 })],
    }),
  );
  assert.ok(Math.abs(p.unrealizedPnL - 2.0) < 1e-12);
});

// ─── Position sizing & overdraft guards (assessRisk) ────────

function makeDecision(amountIn: string, score = 80, confidence = 0.9) {
  return {
    token: 'CAKE',
    direction: 'LONG' as const,
    amountIn,
    amountOutMin: '0',
    slippageTolerance: 100,
    deadline: 0,
    reasoning: 'test',
    signals: [
      {
        token: 'CAKE',
        strategy: 'MOMENTUM' as const,
        direction: 'LONG' as const,
        strength: 'STRONG' as const,
        score,
        confidence,
        reasoning: 't',
        timestamp: 0,
        metadata: {},
      },
    ],
    riskAssessment: {
      approved: true,
      positionSize: '0',
      maxPositionPct: 0.2,
      stopLossPct: 0.05,
      takeProfitPct: 0.15,
      riskRewardRatio: 3,
      reasons: [],
      warnings: [],
    },
  };
}

test('approves a position within size, balance and signal limits', () => {
  const rm = new RiskManager(makeConfig({ maxPositionPct: 0.2 }));
  // portfolio 100 BNB, max 20 BNB; propose 10 BNB
  const r = rm.assessRisk(makeDecision('10'), makePortfolio({ totalValueBNB: 100, availableBNB: 100 }));
  assert.equal(r.approved, true);
  assert.equal(r.positionSize, '10');
});

test('blocks position exceeding max position pct', () => {
  const rm = new RiskManager(makeConfig({ maxPositionPct: 0.2 }));
  // max = 20 BNB; propose 25 BNB
  const r = rm.assessRisk(makeDecision('25'), makePortfolio({ totalValueBNB: 100, availableBNB: 100 }));
  assert.equal(r.approved, false);
  assert.equal(r.positionSize, '0');
  assert.ok(r.reasons.some((x) => x.includes('exceeds max')));
});

test('overdraft guard: blocks when proposed amount exceeds available balance', () => {
  const rm = new RiskManager(makeConfig({ maxPositionPct: 1.0 }));
  // max pct allows it, but available is only 5 BNB and we ask for 8
  const r = rm.assessRisk(makeDecision('8'), makePortfolio({ totalValueBNB: 100, availableBNB: 5 }));
  assert.equal(r.approved, false);
  assert.ok(r.reasons.some((x) => x.includes('Insufficient BNB balance')));
});

test('daily drawdown limit blocks new trades at the threshold', () => {
  const rm = new RiskManager(makeConfig({ dailyDrawdownLimitPct: 0.1 }));
  // dailyPnLPct = -0.1 == -limit => blocked
  const r = rm.assessRisk(makeDecision('5'), makePortfolio({ dailyPnLPct: -0.1 }));
  assert.equal(r.approved, false);
  assert.ok(r.reasons.some((x) => x.includes('Daily drawdown limit')));
});

test('max concurrent positions blocks a new non-HOLD trade', () => {
  const rm = new RiskManager(makeConfig({ maxConcurrentPositions: 2 }));
  const r = rm.assessRisk(
    makeDecision('5'),
    makePortfolio({ positions: [makePosition({ token: 'SOL' }), makePosition({ token: 'ADA' })] }),
  );
  assert.equal(r.approved, false);
  assert.ok(r.reasons.some((x) => x.includes('Max concurrent positions')));
});

test('duplicate LONG position in same token is blocked', () => {
  const rm = new RiskManager(makeConfig());
  const r = rm.assessRisk(
    makeDecision('5'),
    makePortfolio({ positions: [makePosition({ token: 'CAKE' })] }),
  );
  assert.equal(r.approved, false);
  assert.ok(r.reasons.some((x) => x.includes('Already holding')));
});

test('low signal score blocks the trade', () => {
  const rm = new RiskManager(makeConfig({ minSignalScore: 60 }));
  const r = rm.assessRisk(makeDecision('5', 40), makePortfolio());
  assert.equal(r.approved, false);
  assert.ok(r.reasons.some((x) => x.includes('below minimum')));
});

test('position size is clamped to the max even when approved', () => {
  // maxPct 0.2 of 100 = 20. propose exactly 20 -> approved, size 20.
  const rm = new RiskManager(makeConfig({ maxPositionPct: 0.2 }));
  const r = rm.assessRisk(makeDecision('20'), makePortfolio({ totalValueBNB: 100, availableBNB: 100 }));
  assert.equal(r.approved, true);
  assert.equal(r.positionSize, '20');
});

test('risk-reward ratio = takeProfit / stopLoss', () => {
  const rm = new RiskManager(makeConfig({ takeProfitPct: 0.15, stopLossPct: 0.05 }));
  const r = rm.assessRisk(makeDecision('5'), makePortfolio());
  assert.ok(Math.abs(r.riskRewardRatio - 3) < 1e-12);
});

// ─── Portfolio heat ─────────────────────────────────────────

test('portfolio heat = sum(positionValue * stopLossPct) / total', () => {
  const rm = new RiskManager(makeConfig({ stopLossPct: 0.05 }));
  // two positions worth 10 BNB each, total 100 => heat = (10*0.05 + 10*0.05)/100 = 1/100 = 0.01
  const heat = rm.calculatePortfolioHeat(
    makePortfolio({
      totalValueBNB: 100,
      positions: [makePosition({ valueBNB: 10 }), makePosition({ valueBNB: 10 })],
    }),
  );
  assert.ok(Math.abs(heat - 0.01) < 1e-12);
});

test('portfolio heat is 0 when total value is 0 (no divide-by-zero)', () => {
  const rm = new RiskManager(makeConfig());
  const heat = rm.calculatePortfolioHeat(makePortfolio({ totalValueBNB: 0, positions: [makePosition({ valueBNB: 10 })] }));
  assert.equal(heat, 0);
});

// ─── Kelly position sizing ──────────────────────────────────

test('Kelly: 60% win rate with 2:1 win/loss => half-Kelly fraction', () => {
  const rm = new RiskManager(makeConfig({ maxPositionPct: 1.0 }));
  // kelly = 0.6 - (0.4 / (2/1)) = 0.6 - 0.2 = 0.4 ; half = 0.2 ; *1000 = 200
  const size = rm.kellyPositionSize(0.6, 2, 1, 1000);
  assert.ok(Math.abs(size - 200) < 1e-9);
});

test('Kelly: negative edge clamps to 0 (never sizes a losing bet)', () => {
  const rm = new RiskManager(makeConfig({ maxPositionPct: 1.0 }));
  // 30% win rate, 1:1 => kelly = 0.3 - 0.7/1 = -0.4 (negative) => clamped to 0
  const size = rm.kellyPositionSize(0.3, 1, 1, 1000);
  assert.equal(size, 0);
});

test('Kelly: avgLoss of 0 returns 0 (no divide-by-zero)', () => {
  const rm = new RiskManager(makeConfig());
  assert.equal(rm.kellyPositionSize(0.6, 2, 0, 1000), 0);
});

test('Kelly result is capped by maxPositionPct', () => {
  const rm = new RiskManager(makeConfig({ maxPositionPct: 0.05 })); // cap = 5% of 1000 = 50
  // high-edge bet would size much larger, but must be capped at 50
  const size = rm.kellyPositionSize(0.9, 3, 1, 1000);
  assert.equal(size, 50);
});
