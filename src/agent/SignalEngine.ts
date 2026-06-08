// ============================================================
// CogniTrader BSC — Multi-Factor Signal Engine
// Aggregates signals from all strategies, applies composite
// scoring, and generates actionable trade signals
// ============================================================

import type { Signal, AggregatedSignal, MarketSnapshot, Candle, StrategyType, AgentConfig } from '../utils/types';
import { MomentumStrategy } from '../strategies/MomentumStrategy';
import { SentimentStrategy } from '../strategies/SentimentStrategy';
import { MeanReversionStrategy } from '../strategies/MeanReversion';
import { BNBAgentSDK } from '../integrations/bnb-agent-sdk';
import { getLogger, logSignal } from '../utils/logger';

export class SignalEngine {
  private momentumStrategy: MomentumStrategy;
  private sentimentStrategy: SentimentStrategy;
  private meanReversionStrategy: MeanReversionStrategy;
  private agentSDK: BNBAgentSDK;
  private config: AgentConfig;
  private ohlcvCache: Map<string, { candles: Candle[]; fetchedAt: number }>;

  constructor(config: AgentConfig, agentSDK: BNBAgentSDK) {
    this.config = config;
    this.agentSDK = agentSDK;
    this.momentumStrategy = new MomentumStrategy();
    this.sentimentStrategy = new SentimentStrategy();
    this.meanReversionStrategy = new MeanReversionStrategy();
    this.ohlcvCache = new Map();
  }

  // ─── Main Signal Generation Pipeline ──────────────────────

  async generateSignals(
    tokens: string[],
    snapshot: MarketSnapshot,
  ): Promise<AggregatedSignal[]> {
    getLogger().info(`🔬 Signal Engine: Analyzing ${tokens.length} tokens with ${this.config.strategies.length} strategies`);

    const aggregatedSignals: AggregatedSignal[] = [];

    for (const token of tokens) {
      try {
        const signals = await this.generateTokenSignals(token, snapshot);

        if (signals.length === 0) {
          getLogger().debug(`No signals generated for ${token}`);
          continue;
        }

        // Use Agent SDK to orchestrate signals
        const aggregated = await this.agentSDK.orchestrateSignal(signals);

        // Filter by minimum thresholds
        if (aggregated.compositeScore >= this.config.minSignalScore &&
            aggregated.consensusStrength !== 'WEAK') {
          aggregatedSignals.push(aggregated);

          logSignal(
            token,
            aggregated.compositeScore,
            aggregated.consensusDirection,
            aggregated.consensusStrength,
          );
        } else {
          getLogger().debug(`${token}: Score ${aggregated.compositeScore} below threshold ${this.config.minSignalScore}`);
        }
      } catch (error) {
        getLogger().error(`Signal generation failed for ${token}`, error);
      }
    }

    // Sort by composite score descending
    aggregatedSignals.sort((a, b) => b.compositeScore - a.compositeScore);

    getLogger().info(`📊 Signal Engine: ${aggregatedSignals.length} actionable signals generated`);
    return aggregatedSignals;
  }

  // ─── Per-Token Signal Generation ───────────────────────────

  private async generateTokenSignals(token: string, snapshot: MarketSnapshot): Promise<Signal[]> {
    const signals: Signal[] = [];

    // Get OHLCV data (with caching)
    const candles = await this.getOHLCVData(token);

    // Get quote data
    const quote = snapshot.quotes.get(token);

    for (const strategyType of this.config.strategies) {
      try {
        const signal = await this.generateStrategySignal(
          strategyType,
          token,
          candles,
          quote,
          snapshot.fearGreed,
          snapshot.trending,
        );

        if (signal && signal.direction !== 'HOLD') {
          signals.push(signal);
        }
      } catch (error) {
        getLogger().error(`Strategy ${strategyType} failed for ${token}`, error);
      }
    }

    return signals;
  }

  // ─── Strategy Dispatch ─────────────────────────────────────

  private async generateStrategySignal(
    strategy: StrategyType,
    token: string,
    candles: Candle[],
    quote: Signal['metadata'] extends Record<string, infer V> ? never : never,
    fearGreed: Signal['metadata'] extends Record<string, infer V> ? never : never,
    trending: Signal['metadata'] extends Record<string, infer V> ? never : never,
  ): Promise<Signal | null> {
    switch (strategy) {
      case 'MOMENTUM':
        if (candles.length < 30) {
          getLogger().debug(`${token}: Insufficient candles for momentum (${candles.length})`);
          return null;
        }
        return this.momentumStrategy.generateSignal(token, candles);

      case 'SENTIMENT':
        if (!quote) {
          getLogger().debug(`${token}: No CMC quote available for sentiment`);
          return null;
        }
        return this.sentimentStrategy.generateSignal(
          token,
          candles,
          quote,
          fearGreed,
          trending,
        );

      case 'MEAN_REVERSION':
        if (candles.length < 20) {
          getLogger().debug(`${token}: Insufficient candles for mean reversion (${candles.length})`);
          return null;
        }
        return this.meanReversionStrategy.generateSignal(token, candles);

      default:
        getLogger().warn(`Unknown strategy type: ${strategy}`);
        return null;
    }
  }

  // ─── OHLCV Data Management ─────────────────────────────────

  async getOHLCVData(token: string): Promise<Candle[]> {
    const cached = this.ohlcvCache.get(token);
    const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
      return cached.candles;
    }

    // Generate synthetic OHLCV data from CMC data for demonstration
    // In production, this would fetch from CMC historical API
    const candles = this.generateSyntheticCandles(token, 168);

    this.ohlcvCache.set(token, { candles, fetchedAt: Date.now() });
    return candles;
  }

  private generateSyntheticCandles(token: string, count: number): Candle[] {
    // Generate realistic synthetic candles for strategy computation
    // In production, use CMC historical data API
    const candles: Candle[] = [];
    const now = Math.floor(Date.now() / 1000);
    let price = 1 + Math.random() * 100; // Random starting price

    for (let i = 0; i < count; i++) {
      const volatility = 0.02 + Math.random() * 0.05;
      const change = (Math.random() - 0.48) * volatility * price; // Slight upward bias

      const open = price;
      const close = price + change;
      const high = Math.max(open, close) * (1 + Math.random() * 0.01);
      const low = Math.min(open, close) * (1 - Math.random() * 0.01);
      const volume = 100000 + Math.random() * 1000000;

      candles.push({
        timestamp: now - (count - i) * 3600,
        open,
        high,
        low,
        close,
        volume,
      });

      price = close;
    }

    return candles;
  }

  // ─── Cache Management ───────────────────────────────────────

  clearCache(): void {
    this.ohlcvCache.clear();
    getLogger().debug('OHLCV cache cleared');
  }

  getCacheStats(): { tokens: number; oldest: number | null; newest: number | null } {
    let oldest: number | null = null;
    let newest: number | null = null;

    for (const entry of this.ohlcvCache.values()) {
      if (oldest === null || entry.fetchedAt < oldest) oldest = entry.fetchedAt;
      if (newest === null || entry.fetchedAt > newest) newest = entry.fetchedAt;
    }

    return {
      tokens: this.ohlcvCache.size,
      oldest,
      newest,
    };
  }
}
