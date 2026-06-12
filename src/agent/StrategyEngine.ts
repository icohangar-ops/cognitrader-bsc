// ============================================================
// CogniTrader BSC — Strategy Engine
// Strategy selection, execution logic, and portfolio management
// ============================================================

import type {
  AgentConfig,
  AggregatedSignal,
  TradeDecision,
  TradeResult,
  PortfolioState,
  Position,
} from '../utils/types';
import { BSCClient } from '../integrations/bsc';
import { TrustWalletAgentKit } from '../integrations/twak';
import { RiskManager } from './RiskManager';
import { BNBAgentSDK } from '../integrations/bnb-agent-sdk';
import { getLogger, logTrade, logRiskWarning } from '../utils/logger';

export class StrategyEngine {
  private config: AgentConfig;
  private bscClient: BSCClient;
  private twak: TrustWalletAgentKit;
  private riskManager: RiskManager;
  private agentSDK: BNBAgentSDK;
  private positions: Map<string, Position>;

  constructor(
    config: AgentConfig,
    bscClient: BSCClient,
    twak: TrustWalletAgentKit,
    riskManager: RiskManager,
    agentSDK: BNBAgentSDK,
  ) {
    this.config = config;
    this.bscClient = bscClient;
    this.twak = twak;
    this.riskManager = riskManager;
    this.agentSDK = agentSDK;
    this.positions = new Map();
  }

  // ─── Main Execution Loop ──────────────────────────────────

  async executeSignals(signals: AggregatedSignal[]): Promise<TradeResult[]> {
    const results: TradeResult[] = [];

    for (const signal of signals) {
      try {
        const result = await this.processSignal(signal);
        results.push(result);
      } catch (error) {
        getLogger().error(`Failed to process signal for ${signal.token}`, error);
        results.push({
          success: false,
          txHash: '',
          fromToken: 'BNB',
          toToken: signal.token,
          amountIn: '0',
          amountOut: '0',
          gasUsed: '0',
          gasPrice: '0',
          blockNumber: 0,
          timestamp: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  // ─── Process Individual Signal ─────────────────────────────

  private async processSignal(signal: AggregatedSignal): Promise<TradeResult> {
    getLogger().info(`🎯 Processing signal: ${signal.token} → ${signal.consensusDirection} (${signal.compositeScore})`);

    // Skip HOLD signals
    if (signal.consensusDirection === 'HOLD') {
      getLogger().debug(`${signal.token}: HOLD — no action needed`);
      return this.noopResult(signal.token);
    }

    // Check existing positions for stop-loss/take-profit
    await this.checkExistingPositions();

    // Create trade decision
    const decision = this.createTradeDecision(signal);
    if (!decision) {
      getLogger().debug(`${signal.token}: No trade decision created`);
      return this.noopResult(signal.token);
    }

    // TWAK policy check
    const policyResult = this.twak.checkPolicy({
      token: decision.token,
      amountBNB: parseFloat(decision.amountIn),
    });

    if (!policyResult.allowed) {
      logRiskWarning(`TWAK policy blocked: ${policyResult.reason}`);
      return this.noopResult(signal.token);
    }

    // Risk assessment
    const portfolio = await this.getPortfolioState();
    const riskAssessment = this.riskManager.assessRisk(decision, portfolio);

    if (!riskAssessment.approved) {
      getLogger().warn(`${signal.token}: Risk blocked — ${riskAssessment.reasons.join('; ')}`);
      return this.noopResult(signal.token);
    }

    if (riskAssessment.warnings.length > 0) {
      for (const warning of riskAssessment.warnings) {
        logRiskWarning(warning);
      }
    }

    // Log trade decision
    logTrade({
      token: decision.token,
      amountIn: decision.amountIn,
      direction: decision.direction,
      reasoning: decision.reasoning,
    });

    // Execute trade
    return this.executeTrade(decision);
  }

  // ─── Trade Decision Creation ───────────────────────────────

  private createTradeDecision(signal: AggregatedSignal): TradeDecision | null {
    const portfolio = this.riskManager.getDailyStartValue();
    const amountIn = Math.min(
      portfolio * this.config.maxPositionPct,
      portfolio * 0.05, // Conservative default: 5% per trade
    );

    if (amountIn < 0.001) {
      getLogger().warn(`Insufficient portfolio value for trade (${amountIn} BNB)`);
      return null;
    }

    const direction: TradeDecision['direction'] = signal.consensusDirection;

    return {
      token: signal.token,
      direction,
      amountIn: amountIn.toFixed(4),
      amountOutMin: '0',
      slippageTolerance: this.config.slippageBps,
      deadline: Math.floor(Date.now() / 1000) + 300,
      reasoning: signal.signals.map(s => s.reasoning).join(' | '),
      signals: signal.signals,
      riskAssessment: {
        approved: true,
        positionSize: amountIn.toFixed(4),
        maxPositionPct: this.config.maxPositionPct,
        stopLossPct: this.config.stopLossPct,
        takeProfitPct: this.config.takeProfitPct,
        riskRewardRatio: this.config.takeProfitPct / this.config.stopLossPct,
        reasons: [],
        warnings: [],
        riskScore: signal.riskScore,
      },
    };
  }

  // ─── Trade Execution ───────────────────────────────────────

  private async executeTrade(decision: TradeDecision): Promise<TradeResult> {
    if (this.config.dryRun) {
      getLogger().info(`[DRY RUN] Would execute trade: ${decision.direction} ${decision.amountIn} BNB → ${decision.token}`);
      const result: TradeResult = {
        success: true,
        txHash: `dry-run-${Date.now()}`,
        fromToken: 'BNB',
        toToken: decision.token,
        amountIn: decision.amountIn,
        amountOut: '0',
        gasUsed: '0',
        gasPrice: '0',
        blockNumber: 0,
        timestamp: Date.now(),
      };

      // Record in agent memory
      this.agentSDK.addTradeMemory({
        token: decision.token,
        action: decision.direction === 'LONG' ? 'BUY' : 'SELL',
        amount: parseFloat(decision.amountIn),
        price: 0,
        pnl: 0,
        signalScore: decision.signals.reduce((s, sig) => s + sig.score, 0) / decision.signals.length,
        reasoning: decision.reasoning,
        timestamp: Date.now(),
      });

      return result;
    }

    // Live execution
    if (decision.direction === 'LONG') {
      const result = await this.bscClient.swapBNBForToken(
        decision.token,
        parseFloat(decision.amountIn),
        decision.slippageTolerance,
      );

      if (result.success) {
        // Record position
        this.positions.set(decision.token, {
          token: decision.token,
          symbol: decision.token,
          amount: result.amountOut,
          entryPrice: parseFloat(result.amountOut) > 0
            ? parseFloat(decision.amountIn) / parseFloat(result.amountOut)
            : 0,
          currentPrice: 0,
          valueBNB: parseFloat(decision.amountIn),
          pnl: 0,
          pnlPct: 0,
          openedAt: Date.now(),
          stopLoss: this.config.stopLossPct,
          takeProfit: this.config.takeProfitPct,
        });

        // Record in agent memory
        this.agentSDK.addTradeMemory({
          token: decision.token,
          action: 'BUY',
          amount: parseFloat(decision.amountIn),
          price: 0,
          pnl: 0,
          signalScore: decision.signals.reduce((s, sig) => s + sig.score, 0) / decision.signals.length,
          reasoning: decision.reasoning,
          timestamp: Date.now(),
        });
      }

      return result;
    }

    // SHORT direction = sell existing position
    const position = this.positions.get(decision.token);
    if (position) {
      const result = await this.bscClient.swapTokenForBNB(
        decision.token,
        parseFloat(position.amount),
        decision.slippageTolerance,
      );

      if (result.success) {
        this.positions.delete(decision.token);

        this.agentSDK.addTradeMemory({
          token: decision.token,
          action: 'SELL',
          amount: parseFloat(decision.amountIn),
          price: parseFloat(result.amountOut) / parseFloat(position.amount),
          pnl: parseFloat(result.amountOut) - parseFloat(decision.amountIn),
          signalScore: decision.signals.reduce((s, sig) => s + sig.score, 0) / decision.signals.length,
          reasoning: decision.reasoning,
          timestamp: Date.now(),
        });
      }

      return result;
    }

    return this.noopResult(decision.token);
  }

  // ─── Position Management ──────────────────────────────────

  async checkExistingPositions(): Promise<void> {
    for (const [token, position] of this.positions) {
      // Update current price
      try {
        const currentPrice = await this.bscClient.getPriceBNB(token);
        position.currentPrice = currentPrice;

        if (currentPrice > 0 && position.entryPrice > 0) {
          position.pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
          position.valueBNB = position.valueBNB * (1 + position.pnlPct);
          position.pnl = position.valueBNB * position.pnlPct;
        }
      } catch {
        getLogger().debug(`Could not update price for ${token}`);
      }

      // Check stop-loss / take-profit
      const evaluation = this.riskManager.evaluatePositionExit(position);
      if (evaluation.shouldExit) {
        getLogger().info(`🛑 Exiting ${token}: ${evaluation.reason}`);
        await this.bscClient.swapTokenForBNB(
          token,
          parseFloat(position.amount),
          this.config.slippageBps,
          this.config.dryRun,
        );
        this.positions.delete(token);
      }
    }
  }

  // ─── Portfolio State ───────────────────────────────────────

  async getPortfolioState(): Promise<PortfolioState> {
    const balanceBNB = await this.bscClient.getBNBBalance();

    const positions = Array.from(this.positions.values());
    const positionsValue = positions.reduce((sum, pos) => sum + pos.valueBNB, 0);
    const totalValue = balanceBNB + positionsValue;
    const unrealizedPnL = positions.reduce((sum, pos) => sum + pos.pnl, 0);

    const state: PortfolioState = {
      totalValueBNB: totalValue,
      availableBNB: balanceBNB,
      positions,
      dailyPnL: 0,
      dailyPnLPct: 0,
      maxDrawdown: 0,
      unrealizedPnL,
    };

    return this.riskManager.updatePortfolio(state);
  }

  // ─── Helpers ───────────────────────────────────────────────

  private noopResult(token: string): TradeResult {
    return {
      success: true,
      txHash: '',
      fromToken: 'BNB',
      toToken: token,
      amountIn: '0',
      amountOut: '0',
      gasUsed: '0',
      gasPrice: '0',
      blockNumber: 0,
      timestamp: Date.now(),
    };
  }

  getPositionCount(): number {
    return this.positions.size;
  }

  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }
}
