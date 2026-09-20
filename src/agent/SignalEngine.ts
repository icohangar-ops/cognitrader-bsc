// ============================================================
// CogniTrader BSC — Multi-Factor Signal Engine
// Aggregates signals from all strategies, applies composite
// scoring, and generates actionable trade signals
// ============================================================

import type {
  Signal,
  AggregatedSignal,
  MarketSnapshot,
  Candle,
  StrategyType,
  AgentConfig,
  CMCQuote,
  FearGreedIndex,
  CMCTrendingToken,
} from '../utils/types';
import { MomentumStrategy } from '../strategies/MomentumStrategy';
import { SentimentStrategy } from '../strategies/SentimentStrategy';
import { MeanReversionStrategy } from '../strategies/MeanReversion';
import { BNBAgentSDK } from '../integrations/bnb-agent-sdk';
import { TieredMarketData } from '../integrations/marketData';
import { getLogger, logSignal } from '../utils/logger';

export class SignalEngine {
  private momentumStrategy: MomentumStrategy;
  private sentimentStrategy: SentimentStrategy;
  private meanReversionStrategy: MeanReversionStrategy;
  private agentSDK: BNBAgentSDK;
  private config: AgentConfig;
  private marketData: TieredMarketData;

  constructor(config: AgentConfig, agentSDK: BNBAgentSDK, marketData: TieredMarketData) {
    this.config = config;
    this.agentSDK = agentSDK;
    this.momentumStrategy = new MomentumStrategy();
    this.sentimentStrategy = new SentimentStrategy();
    this.meanReversionStrategy = new MeanReversionStrategy();
    this.marketData = marketData;
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
    quote: CMCQuote | undefined,
    fearGreed: FearGreedIndex,
    trending: CMCTrendingToken[],
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

  /**
   * Tiered fetch (row 3, src/integrations/marketData.ts):
   * LIVE CMC OHLCV → disk cache → deterministic mock, always badged.
   * The tier badge is logged here — the human reader of strategy output
   * must be able to tell real candles from placeholders.
   */
  async getOHLCVData(token: string): Promise<Candle[]> {
    const result = await this.marketData.getOHLCV(token, '1h', 168);
    getLogger().info(`📊 OHLCV ${token}: [${result.badge}] ${result.value.candles.length} candles (${result.value.interval})`);
    return result.value.candles;
  }
}
