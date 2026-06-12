// ============================================================
// CogniTrader BSC — Risk Manager
// Position sizing, stop-loss, drawdown limits, portfolio heat
// ============================================================

import type {
  AgentConfig,
  RiskAssessment,
  PortfolioState,
  Position,
  TradeDecision,
} from '../utils/types';
import { logRiskWarning, logRiskBlocked } from '../utils/logger';

export class RiskManager {
  private config: AgentConfig;
  private dailyStartPortfolioValue = 0;
  private peakPortfolioValue = 0;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  // ─── Main Risk Assessment ──────────────────────────────────

  assessRisk(
    decision: TradeDecision,
    portfolio: PortfolioState,
  ): RiskAssessment {
    const reasons: string[] = [];
    const warnings: string[] = [];
    let approved = true;

    // ─── Check 1: Maximum concurrent positions ──────────────
    if (decision.direction !== 'HOLD' && portfolio.positions.length >= this.config.maxConcurrentPositions) {
      approved = false;
      reasons.push(`Max concurrent positions reached (${portfolio.positions.length}/${this.config.maxConcurrentPositions})`);
      logRiskBlocked(`Max positions: ${portfolio.positions.length}/${this.config.maxConcurrentPositions}`);
    }

    // ─── Check 2: Daily drawdown limit ─────────────────────
    if (portfolio.dailyPnLPct <= -this.config.dailyDrawdownLimitPct) {
      approved = false;
      reasons.push(`Daily drawdown limit hit (${(portfolio.dailyPnLPct * 100).toFixed(2)}% <= ${this.config.dailyDrawdownLimitPct * 100}%)`);
      logRiskBlocked(`Daily drawdown: ${(portfolio.dailyPnLPct * 100).toFixed(2)}%`);
    }

    // ─── Check 3: Position sizing ───────────────────────────
    const proposedAmount = parseFloat(decision.amountIn);
    const maxAmount = portfolio.totalValueBNB * this.config.maxPositionPct;

    if (proposedAmount > maxAmount) {
      approved = false;
      reasons.push(`Position size ${proposedAmount} BNB exceeds max ${maxAmount.toFixed(4)} BNB (${this.config.maxPositionPct * 100}% of portfolio)`);
      logRiskBlocked(`Position size exceeded: ${proposedAmount} > ${maxAmount.toFixed(4)} BNB`);
    }

    // ─── Check 4: Minimum signal quality ────────────────────
    const avgScore = decision.signals.reduce((s, sig) => s + sig.score, 0) / decision.signals.length;
    const avgConfidence = decision.signals.reduce((s, sig) => s + sig.confidence, 0) / decision.signals.length;

    if (avgScore < this.config.minSignalScore) {
      approved = false;
      reasons.push(`Signal score ${avgScore.toFixed(1)} below minimum ${this.config.minSignalScore}`);
    }

    if (avgConfidence < this.config.minConfidence) {
      warnings.push(`Signal confidence ${avgConfidence.toFixed(2)} below minimum ${this.config.minConfidence}`);
    }

    // ─── Check 5: Available balance ─────────────────────────
    if (proposedAmount > portfolio.availableBNB) {
      approved = false;
      reasons.push(`Insufficient BNB balance: need ${proposedAmount}, have ${portfolio.availableBNB.toFixed(4)}`);
    }

    // ─── Check 6: Duplicate position ────────────────────────
    const existingPosition = portfolio.positions.find(p => p.token === decision.token);
    if (existingPosition && decision.direction === 'LONG') {
      approved = false;
      reasons.push(`Already holding position in ${decision.token}`);
      logRiskBlocked(`Duplicate position: ${decision.token}`);
    }

    // ─── Warnings (non-blocking) ───────────────────────────
    if (portfolio.dailyPnLPct < 0) {
      warnings.push(`Currently in daily loss: ${(portfolio.dailyPnLPct * 100).toFixed(2)}%`);
    }

    if ((decision.riskAssessment.riskScore ?? 0) > 70) {
      warnings.push(`High risk score: ${decision.riskAssessment.riskScore}/100`);
      logRiskWarning(`High risk trade: ${decision.token} (score: ${decision.riskAssessment.riskScore})`);
    }

    // ─── Calculate position size ───────────────────────────
    const positionSize = approved
      ? Math.min(proposedAmount, maxAmount).toString()
      : '0';

    // ─── Calculate risk-reward ratio ────────────────────────
    const riskRewardRatio = this.config.takeProfitPct / this.config.stopLossPct;

    if (riskRewardRatio < 2) {
      warnings.push(`Risk-reward ratio ${riskRewardRatio.toFixed(1)}:1 below 2:1 target`);
    }

    return {
      approved,
      positionSize,
      maxPositionPct: this.config.maxPositionPct,
      stopLossPct: this.config.stopLossPct,
      takeProfitPct: this.config.takeProfitPct,
      riskRewardRatio,
      reasons,
      warnings,
    };
  }

  // ─── Stop-Loss / Take-Profit Evaluation ─────────────────────

  evaluatePositionExit(position: Position): { shouldExit: boolean; reason: string; type: 'STOP_LOSS' | 'TAKE_PROFIT' | 'NONE' } {
    if (position.currentPrice <= 0 || position.entryPrice <= 0) {
      return { shouldExit: false, reason: 'Invalid price data', type: 'NONE' };
    }

    const pnlPct = (position.currentPrice - position.entryPrice) / position.entryPrice;

    // Stop-loss check
    if (pnlPct <= -this.config.stopLossPct) {
      logRiskWarning(`Stop-loss triggered for ${position.token}: ${((pnlPct) * 100).toFixed(2)}% loss`);
      return {
        shouldExit: true,
        reason: `Stop-loss triggered at ${((pnlPct) * 100).toFixed(2)}% loss (limit: ${this.config.stopLossPct * 100}%)`,
        type: 'STOP_LOSS',
      };
    }

    // Take-profit check
    if (pnlPct >= this.config.takeProfitPct) {
      return {
        shouldExit: true,
        reason: `Take-profit reached at ${(pnlPct * 100).toFixed(2)}% gain (target: ${this.config.takeProfitPct * 100}%)`,
        type: 'TAKE_PROFIT',
      };
    }

    return { shouldExit: false, reason: '', type: 'NONE' };
  }

  // ─── Portfolio State Management ────────────────────────────

  initializeDailyBaseline(portfolioValue: number): void {
    this.dailyStartPortfolioValue = portfolioValue;
    if (portfolioValue > this.peakPortfolioValue) {
      this.peakPortfolioValue = portfolioValue;
    }
  }

  updatePortfolio(portfolio: PortfolioState): PortfolioState {
    // Calculate daily PnL
    if (this.dailyStartPortfolioValue > 0) {
      portfolio.dailyPnL = portfolio.totalValueBNB - this.dailyStartPortfolioValue;
      portfolio.dailyPnLPct = portfolio.dailyPnL / this.dailyStartPortfolioValue;
    }

    // Update peak for max drawdown
    if (portfolio.totalValueBNB > this.peakPortfolioValue) {
      this.peakPortfolioValue = portfolio.totalValueBNB;
    }

    // Calculate max drawdown
    if (this.peakPortfolioValue > 0) {
      const drawdown = (this.peakPortfolioValue - portfolio.totalValueBNB) / this.peakPortfolioValue;
      if (drawdown > portfolio.maxDrawdown) {
        portfolio.maxDrawdown = drawdown;
      }
    }

    // Calculate unrealized PnL
    portfolio.unrealizedPnL = portfolio.positions.reduce((sum, pos) => sum + pos.pnl, 0);

    return portfolio;
  }

  // ─── Portfolio Heat Calculation ────────────────────────────

  calculatePortfolioHeat(portfolio: PortfolioState): number {
    // Portfolio heat = sum of (position value * risk %) / total portfolio
    if (portfolio.totalValueBNB === 0) return 0;

    const heat = portfolio.positions.reduce((sum, pos) => {
      return sum + (pos.valueBNB * this.config.stopLossPct);
    }, 0);

    return heat / portfolio.totalValueBNB;
  }

  // ─── Kelly Position Sizing ────────────────────────────────

  kellyPositionSize(
    winRate: number,
    avgWin: number,
    avgLoss: number,
    portfolioValue: number,
  ): number {
    if (avgLoss === 0) return 0;

    const kelly = winRate - ((1 - winRate) / (avgWin / avgLoss));
    const halfKelly = kelly * 0.5; // Half-Kelly for safety
    const maxSize = portfolioValue * this.config.maxPositionPct;

    return Math.min(Math.max(halfKelly * portfolioValue, 0), maxSize);
  }

  // ─── Helpers ───────────────────────────────────────────────

  getDailyStartValue(): number {
    return this.dailyStartPortfolioValue;
  }

  getPeakValue(): number {
    return this.peakPortfolioValue;
  }

  resetDailyBaseline(): void {
    this.dailyStartPortfolioValue = 0;
  }
}
