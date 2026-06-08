// ============================================================
// CogniTrader BSC — Mean Reversion Strategy
// Statistical mean reversion on BSC token pairs using
// z-scores, Bollinger Bands, and mean absolute deviation
// ============================================================

import type { Candle, Signal, CMCQuote, FearGreedIndex } from '../utils/types';
import { getLogger } from '../utils/logger';

// ─── Statistical Functions ───────────────────────────────────

function calculateBollingerBands(
  candles: Candle[],
  period: number = 20,
  stdDevMultiplier: number = 2,
): {
  upper: number;
  middle: number;
  lower: number;
  currentPrice: number;
  bandwidth: number;
  percentB: number;
} {
  if (candles.length < period) {
    const price = candles[candles.length - 1]?.close ?? 0;
    return { upper: price, middle: price, lower: price, currentPrice: price, bandwidth: 0, percentB: 50 };
  }

  const recent = candles.slice(-period);
  const closes = recent.map(c => c.close);
  const mean = closes.reduce((s, v) => s + v, 0) / period;
  const variance = closes.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = mean + (stdDev * stdDevMultiplier);
  const lower = mean - (stdDev * stdDevMultiplier);
  const currentPrice = candles[candles.length - 1].close;
  const bandwidth = ((upper - lower) / mean) * 100;
  const percentB = upper !== lower ? ((currentPrice - lower) / (upper - lower)) * 100 : 50;

  return { upper, middle: mean, lower, currentPrice, bandwidth, percentB };
}

function calculateZScore(candles: Candle[], period: number = 30): { zScore: number; mean: number; stdDev: number } {
  if (candles.length < period) {
    return { zScore: 0, mean: 0, stdDev: 0 };
  }

  const recent = candles.slice(-period);
  const closes = recent.map(c => c.close);
  const mean = closes.reduce((s, v) => s + v, 0) / period;
  const variance = closes.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const currentPrice = candles[candles.length - 1].close;
  const zScore = stdDev > 0 ? (currentPrice - mean) / stdDev : 0;

  return { zScore, mean, stdDev };
}

function calculateMeanAbsoluteDeviation(candles: Candle[], period: number = 20): { mad: number; mean: number } {
  if (candles.length < period) {
    return { mad: 0, mean: 0 };
  }

  const recent = candles.slice(-period);
  const closes = recent.map(c => c.close);
  const mean = closes.reduce((s, v) => s + v, 0) / period;
  const absoluteDeviations = closes.map(c => Math.abs(c - mean));
  const mad = absoluteDeviations.reduce((s, v) => s + v, 0) / period;

  return { mad, mean };
}

function detectWicks(candles: Candle[], lookback: number = 5): { longWicks: number; shortWicks: number; signal: string } {
  if (candles.length < lookback) {
    return { longWicks: 0, shortWicks: 0, signal: 'Insufficient data' };
  }

  const recent = candles.slice(-lookback);
  let longWicks = 0;
  let shortWicks = 0;

  for (const candle of recent) {
    const body = Math.abs(candle.close - candle.open);
    const totalRange = candle.high - candle.low;

    if (totalRange === 0) continue;

    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;

    // A wick is significant if it's larger than the body
    if (upperWick > body * 1.5) longWicks++;
    if (lowerWick > body * 1.5) shortWicks++;
  }

  const signal =
    shortWicks > longWicks * 2 ? 'Strong rejection of lower prices (bullish)' :
    longWicks > shortWicks * 2 ? 'Strong rejection of upper prices (bearish)' :
    'No clear rejection pattern';

  return { longWicks, shortWicks, signal };
}

// ─── Mean Reversion Strategy ──────────────────────────────────

export class MeanReversionStrategy {
  readonly name = 'MeanReversion';
  readonly type = 'MEAN_REVERSION' as const;

  // ─── Bollinger Band Scoring (0–35 points) ─────────────────

  private scoreBollingerBands(bb: ReturnType<typeof calculateBollingerBands>): { score: number; signal: string } {
    let score = 15; // Base

    // Price near lower band → oversold → buy
    if (bb.percentB <= 5) {
      score += 20; // Extremely oversold
    } else if (bb.percentB <= 15) {
      score += 15; // Oversold
    } else if (bb.percentB <= 25) {
      score += 8; // Below average
    }
    // Price near upper band → overbought → sell
    else if (bb.percentB >= 95) {
      score -= 15; // Extremely overbought
    } else if (bb.percentB >= 85) {
      score -= 10; // Overbought
    } else if (bb.percentB >= 75) {
      score -= 3; // Above average
    }

    // Squeeze (low bandwidth) → pending breakout → higher score
    if (bb.bandwidth < 5) {
      score += 3; // Bollinger squeeze — potential reversion
    }

    score = Math.max(0, Math.min(35, score));

    return {
      score,
      signal: `BB: %B=${bb.percentB.toFixed(1)}, Bandwidth=${bb.bandwidth.toFixed(2)}%`,
    };
  }

  // ─── Z-Score Scoring (0–25 points) ────────────────────────

  private scoreZScore(zs: ReturnType<typeof calculateZScore>): { score: number; signal: string } {
    let score = 12;

    // Extreme z-scores indicate high reversion probability
    if (zs.zScore <= -2.5) {
      score += 13; // Extreme negative deviation — strong buy
    } else if (zs.zScore <= -2.0) {
      score += 10; // Strong negative deviation
    } else if (zs.zScore <= -1.5) {
      score += 6; // Moderate negative deviation
    } else if (zs.zScore >= 2.5) {
      score -= 12; // Extreme positive deviation — sell
    } else if (zs.zScore >= 2.0) {
      score -= 8; // Strong positive deviation
    } else if (zs.zScore >= 1.5) {
      score -= 4; // Moderate positive deviation
    }

    score = Math.max(0, Math.min(25, score));

    return {
      score,
      signal: `Z-Score: ${zs.zScore.toFixed(3)} (σ=${zs.stdDev.toFixed(4)})`,
    };
  }

  // ─── Wick Rejection Scoring (0–20 points) ─────────────────

  private scoreWickRejection(wicks: ReturnType<typeof detectWicks>): { score: number; signal: string } {
    if (wicks.longWicks === 0 && wicks.shortWicks === 0) {
      return { score: 10, signal: 'No rejection wicks detected' };
    }

    let score = 10;

    if (wicks.shortWicks > wicks.longWicks) {
      // Lower wick rejection → bullish (price rejected going lower)
      score += wicks.shortWicks * 3;
    } else if (wicks.longWicks > wicks.shortWicks) {
      // Upper wick rejection → bearish (price rejected going higher)
      score -= wicks.longWicks * 3;
    }

    score = Math.max(0, Math.min(20, score));

    return { score, signal: wicks.signal };
  }

  // ─── MAD Volatility Scoring (0–20 points) ─────────────────

  private scoreVolatilityMAD(mad: ReturnType<typeof calculateMeanAbsoluteDeviation>): { score: number; signal: string } {
    if (mad.mean === 0) return { score: 10, signal: 'No volatility data' };

    const madRatio = mad.mad / mad.mean;
    let score = 10;

    // Lower MAD ratio → more predictable → better for mean reversion
    if (madRatio < 0.02) {
      score += 8; // Very stable — good for reversion
    } else if (madRatio < 0.05) {
      score += 4; // Stable
    } else if (madRatio > 0.15) {
      score -= 5; // Very volatile — unreliable
    }

    score = Math.max(0, Math.min(20, score));

    return {
      score,
      signal: `MAD: ${(madRatio * 100).toFixed(2)}% (more stable = better reversion signal)`,
    };
  }

  // ─── Main Signal Generation ───────────────────────────────

  async generateSignal(
    token: string,
    candles: Candle[],
    quote?: CMCQuote,
    fearGreed?: FearGreedIndex,
  ): Promise<Signal> {
    getLogger().debug(`[MeanReversion] Analyzing ${token} with ${candles.length} candles`);

    // Calculate indicators
    const bollingerBands = calculateBollingerBands(candles);
    const zScore = calculateZScore(candles);
    const wicks = detectWicks(candles);
    const mad = calculateMeanAbsoluteDeviation(candles);

    // Score components
    const bbScore = this.scoreBollingerBands(bollingerBands);
    const zScoreResult = this.scoreZScore(zScore);
    const wickResult = this.scoreWickRejection(wicks);
    const volResult = this.scoreVolatilityMAD(mad);

    const totalScore = bbScore.score + zScoreResult.score + wickResult.score + volResult.score;

    // Direction
    let direction: Signal['direction'] = 'HOLD';
    if (totalScore >= 70) {
      direction = 'LONG';
    } else if (totalScore <= 40) {
      direction = 'SHORT';
    }

    // Strength
    const strength: Signal['strength'] =
      totalScore >= 85 ? 'STRONG' : totalScore >= 60 ? 'MODERATE' : 'WEAK';

    // Confidence: agreement of reversion indicators
    const reversionBullish = bbScore.score > 15 || zScoreResult.score > 15;
    const reversionBearish = bbScore.score < 8 || zScoreResult.score < 8;
    const wickBullish = wickResult.score > 12;
    const stable = volResult.score > 12;

    const bullishSignals = [reversionBullish, wickBullish].filter(Boolean).length;
    const bearishSignals = [reversionBearish].filter(Boolean).length;
    const confidence = Math.max(bullishSignals, bearishSignals) / 3;

    // Regime filter — mean reversion works best in range-bound markets
    let regimeNote = '';
    if (fearGreed) {
      if (fearGreed.value <= 15 || fearGreed.value >= 85) {
        regimeNote = ' [Caution: Extreme regime — mean reversion less reliable]';
      }
    }

    const signal: Signal = {
      token,
      strategy: 'MEAN_REVERSION',
      direction,
      strength,
      score: totalScore,
      confidence: Math.round(confidence * 100) / 100,
      reasoning: [
        bbScore.signal,
        zScoreResult.signal,
        wickResult.signal,
        volResult.signal + regimeNote,
      ].join(' | '),
      timestamp: Date.now(),
      metadata: {
        bollingerPercentB: bollingerBands.percentB,
        bollingerBandwidth: bollingerBands.bandwidth,
        zScore: zScore.zScore,
        longWicks: wicks.longWicks,
        shortWicks: wicks.shortWicks,
        madRatio: mad.mean > 0 ? mad.mad / mad.mean : 0,
      },
    };

    return signal;
  }
}
