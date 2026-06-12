// ============================================================
// CogniTrader BSC — Momentum Strategy
// RSI + MACD + Volume-Weighted Momentum Scoring
// ============================================================

import type { Candle, Signal, CMCQuote, FearGreedIndex } from '../utils/types';
import { getLogger } from '../utils/logger';

// ─── Technical Indicator Helpers ─────────────────────────────

function calculateEMA(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const result: number[] = [values[0]];
  const multiplier = 2 / (period + 1);

  for (let i = 1; i < values.length; i++) {
    const ema = (values[i] - result[i - 1]) * multiplier + result[i - 1];
    result.push(ema);
  }
  return result;
}

function calculateRSI(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 50; // Neutral

  const changes: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    changes.push(candles[i].close - candles[i - 1].close);
  }

  const recent = changes.slice(-period);
  const gains = recent.filter(c => c > 0);
  const losses = recent.filter(c => c < 0).map(c => Math.abs(c));

  const avgGain = gains.length > 0 ? gains.reduce((s, g) => s + g, 0) / period : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, l) => s + l, 0) / period : 0;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateMACD(candles: Candle[]): { macdLine: number; signalLine: number; histogram: number } {
  const closes = candles.map(c => c.close);
  if (closes.length < 26) {
    return { macdLine: 0, signalLine: 0, histogram: 0 };
  }

  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);

  const macdValues: number[] = [];
  for (let i = 0; i < ema12.length && i < ema26.length; i++) {
    macdValues.push(ema12[i] - ema26[i]);
  }

  const signalLine = calculateEMA(macdValues, 9);
  const macdLine = macdValues[macdValues.length - 1] ?? 0;
  const signal = signalLine[signalLine.length - 1] ?? 0;
  const histogram = macdLine - signal;

  return { macdLine, signalLine: signal, histogram };
}

function calculateVolumeProfile(candles: Candle[], period: number = 20): {
  volumeSMA: number;
  volumeRatio: number;
  volumeTrend: 'increasing' | 'decreasing' | 'stable';
} {
  if (candles.length < period) {
    return { volumeSMA: 0, volumeRatio: 1, volumeTrend: 'stable' };
  }

  const recent = candles.slice(-period);
  const avgVolume = recent.reduce((s, c) => s + c.volume, 0) / period;
  const currentVolume = candles[candles.length - 1].volume;
  const ratio = currentVolume / (avgVolume || 1);

  // Compare first half to second half of recent period
  const firstHalf = recent.slice(0, Math.floor(period / 2));
  const secondHalf = recent.slice(Math.floor(period / 2));
  const avgFirst = firstHalf.reduce((s, c) => s + c.volume, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((s, c) => s + c.volume, 0) / secondHalf.length;

  const trend: 'increasing' | 'decreasing' | 'stable' =
    avgSecond > avgFirst * 1.1 ? 'increasing' :
    avgSecond < avgFirst * 0.9 ? 'decreasing' : 'stable';

  return { volumeSMA: avgVolume, volumeRatio: ratio, volumeTrend: trend };
}

// ─── Momentum Strategy ────────────────────────────────────────

export class MomentumStrategy {
  readonly name = 'Momentum';
  readonly type = 'MOMENTUM' as const;

  // ─── RSI Scoring (0–30 points) ────────────────────────────

  private scoreRSI(rsi: number): { score: number; signal: string } {
    if (rsi <= 20) {
      return { score: 28, signal: 'Extreme oversold — strong buy reversal signal' };
    }
    if (rsi <= 30) {
      return { score: 25, signal: 'Oversold — buy zone' };
    }
    if (rsi <= 40) {
      return { score: 18, signal: 'Approaching oversold — mild buy' };
    }
    if (rsi >= 80) {
      return { score: 5, signal: 'Extreme overbought — strong sell signal' };
    }
    if (rsi >= 70) {
      return { score: 8, signal: 'Overbought — sell zone' };
    }
    if (rsi >= 60) {
      return { score: 15, signal: 'Approaching overbought — caution' };
    }
    return { score: 20, signal: 'Neutral RSI — no momentum edge' };
  }

  // ─── MACD Scoring (0–30 points) ───────────────────────────

  private scoreMACD(macd: ReturnType<typeof calculateMACD>): { score: number; signal: string } {
    const { macdLine, histogram } = macd;

    // Bullish crossover
    if (histogram > 0 && macdLine > 0) {
      return { score: 28, signal: 'Strong bullish MACD crossover' };
    }
    if (histogram > 0) {
      return { score: 22, signal: 'Bullish MACD momentum' };
    }

    // Bearish crossover
    if (histogram < 0 && macdLine < 0) {
      return { score: 5, signal: 'Strong bearish MACD crossover' };
    }
    if (histogram < 0) {
      return { score: 12, signal: 'Bearish MACD momentum' };
    }

    return { score: 15, signal: 'Neutral MACD' };
  }

  // ─── Volume Scoring (0–25 points) ─────────────────────────

  private scoreVolume(vp: ReturnType<typeof calculateVolumeProfile>): { score: number; signal: string } {
    if (vp.volumeRatio > 2.5 && vp.volumeTrend === 'increasing') {
      return { score: 25, signal: 'Explosive volume surge with upward trend' };
    }
    if (vp.volumeRatio > 1.8) {
      return { score: 20, signal: 'High volume confirmation' };
    }
    if (vp.volumeRatio > 1.3 && vp.volumeTrend === 'increasing') {
      return { score: 17, signal: 'Increasing volume trend' };
    }
    if (vp.volumeRatio < 0.5) {
      return { score: 8, signal: 'Very low volume — unreliable signals' };
    }
    return { score: 14, signal: 'Normal volume levels' };
  }

  // ─── Price Momentum Scoring (0–15 points) ──────────────────

  private scorePriceMomentum(candles: Candle[]): { score: number; signal: string } {
    if (candles.length < 5) return { score: 10, signal: 'Insufficient data for price momentum' };

    const recent5 = candles.slice(-5);
    const priceChange = (recent5[recent5.length - 1].close - recent5[0].close) / recent5[0].close;

    if (priceChange > 0.08) {
      return { score: 15, signal: `Strong upward momentum: +${(priceChange * 100).toFixed(2)}%` };
    }
    if (priceChange > 0.03) {
      return { score: 13, signal: `Positive momentum: +${(priceChange * 100).toFixed(2)}%` };
    }
    if (priceChange < -0.08) {
      return { score: 3, signal: `Strong downward momentum: ${(priceChange * 100).toFixed(2)}%` };
    }
    if (priceChange < -0.03) {
      return { score: 7, signal: `Negative momentum: ${(priceChange * 100).toFixed(2)}%` };
    }

    return { score: 10, signal: 'Sideways price action' };
  }

  // ─── Main Signal Generation ───────────────────────────────

  async generateSignal(
    token: string,
    candles: Candle[],
    _quote?: CMCQuote,
    fearGreed?: FearGreedIndex,
  ): Promise<Signal> {
    getLogger().debug(`[Momentum] Analyzing ${token} with ${candles.length} candles`);

    // Calculate indicators
    const rsi = calculateRSI(candles);
    const macd = calculateMACD(candles);
    const volumeProfile = calculateVolumeProfile(candles);
    const priceMomentum = this.scorePriceMomentum(candles);

    // Score each component
    const rsiResult = this.scoreRSI(rsi);
    const macdResult = this.scoreMACD(macd);
    const volumeResult = this.scoreVolume(volumeProfile);

    const totalScore = rsiResult.score + macdResult.score + volumeResult.score + priceMomentum.score;

    // Determine direction
    let direction: Signal['direction'] = 'HOLD';
    if (totalScore >= 70) {
      direction = 'LONG';
    } else if (totalScore <= 40) {
      direction = 'SHORT';
    }

    // Strength
    const strength: Signal['strength'] =
      totalScore >= 85 ? 'STRONG' : totalScore >= 60 ? 'MODERATE' : 'WEAK';

    // Confidence based on signal agreement
    const indicators = [
      rsi < 30 ? 'bullish' : rsi > 70 ? 'bearish' : 'neutral',
      macd.histogram > 0 ? 'bullish' : macd.histogram < 0 ? 'bearish' : 'neutral',
      volumeProfile.volumeTrend === 'increasing' ? 'bullish' : volumeProfile.volumeTrend === 'decreasing' ? 'bearish' : 'neutral',
      priceMomentum.score >= 13 ? 'bullish' : priceMomentum.score <= 7 ? 'bearish' : 'neutral',
    ];

    const bullishCount = indicators.filter(i => i === 'bullish').length;
    const bearishCount = indicators.filter(i => i === 'bearish').length;
    const confidence = Math.max(bullishCount, bearishCount) / indicators.length;

    // Market regime filter using Fear & Greed
    let regimeNote = '';
    if (fearGreed) {
      if (fearGreed.value <= 20 && direction === 'LONG') {
        regimeNote = ' [Caution: Extreme Fear regime — high risk]';
      } else if (fearGreed.value >= 80 && direction === 'SHORT') {
        regimeNote = ' [Caution: Extreme Greed — shorts risky]';
      }
    }

    const signal: Signal = {
      token,
      strategy: 'MOMENTUM',
      direction,
      strength,
      score: totalScore,
      confidence: Math.round(confidence * 100) / 100,
      reasoning: [
        `RSI(${rsi.toFixed(1)}): ${rsiResult.signal}`,
        `MACD: ${macdResult.signal}`,
        `Volume(${volumeProfile.volumeRatio.toFixed(2)}x): ${volumeResult.signal}`,
        `Price: ${priceMomentum.signal}${regimeNote}`,
      ].join(' | '),
      timestamp: Date.now(),
      metadata: {
        rsi: rsi,
        macdLine: macd.macdLine,
        macdHistogram: macd.histogram,
        volumeRatio: volumeProfile.volumeRatio,
        priceChange5: candles.length >= 5
          ? ((candles[candles.length - 1].close - candles[candles.length - 5].close) / candles[candles.length - 5].close)
          : 0,
      },
    };

    return signal;
  }
}
