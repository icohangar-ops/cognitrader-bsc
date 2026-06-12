// ============================================================
// CogniTrader BSC — Sentiment Strategy
// CMC data-driven sentiment divergence and market regime signals
// ============================================================

import type { Candle, Signal, CMCQuote, CMCTrendingToken, FearGreedIndex } from '../utils/types';
import { getLogger } from '../utils/logger';

// ─── Sentiment Scoring Functions ────────────────────────────

function scorePricePerformance(quote: CMCQuote): { score: number; signal: string; direction: 'bullish' | 'bearish' | 'neutral' } {
  const { percent_change_1h, percent_change_24h, percent_change_7d } = quote.quote.USD;

  // Multi-timeframe scoring
  let score = 15; // Base score

  if (percent_change_1h > 2) score += 5;
  else if (percent_change_1h > 0.5) score += 3;
  else if (percent_change_1h < -2) score -= 5;
  else if (percent_change_1h < -0.5) score -= 3;

  if (percent_change_24h > 10) score += 10;
  else if (percent_change_24h > 5) score += 6;
  else if (percent_change_24h > 2) score += 3;
  else if (percent_change_24h < -10) score -= 10;
  else if (percent_change_24h < -5) score -= 6;
  else if (percent_change_24h < -2) score -= 3;

  if (percent_change_7d > 20) score += 5;
  else if (percent_change_7d > 10) score += 3;
  else if (percent_change_7d < -20) score -= 5;
  else if (percent_change_7d < -10) score -= 3;

  // Detect divergence: price down but momentum building
  const divergence =
    percent_change_1h > 0 && percent_change_24h < 0;

  if (divergence) {
    score += 8; // Bullish divergence bonus
  }

  score = Math.max(0, Math.min(35, score));

  const direction: 'bullish' | 'bearish' | 'neutral' =
    score >= 22 ? 'bullish' : score <= 10 ? 'bearish' : 'neutral';

  return {
    score,
    signal: `Performance: 1h ${percent_change_1h.toFixed(2)}%, 24h ${percent_change_24h.toFixed(2)}%, 7d ${percent_change_7d.toFixed(2)}%${divergence ? ' [BULLISH DIVERGENCE]' : ''}`,
    direction,
  };
}

function scoreVolumeSentiment(quote: CMCQuote): { score: number; signal: string } {
  const { volume_24h, market_cap } = quote.quote.USD;

  // Volume-to-market-cap ratio
  const volumeRatio = market_cap > 0 ? volume_24h / market_cap : 0;

  let score = 12;

  // High turnover = active market = better signals
  if (volumeRatio > 0.5) {
    score += 8; // Very active
  } else if (volumeRatio > 0.2) {
    score += 5; // Active
  } else if (volumeRatio > 0.05) {
    score += 2; // Normal
  } else {
    score -= 3; // Low liquidity — unreliable
  }

  // High volume change (if available) indicates market interest
  // We infer from market cap rank
  if (quote.cmc_rank <= 20) {
    score += 5; // Top 20 — very liquid
  } else if (quote.cmc_rank <= 50) {
    score += 3; // Top 50 — liquid
  } else if (quote.cmc_rank > 200) {
    score -= 3; // Low cap — risky
  }

  score = Math.max(0, Math.min(25, score));

  return {
    score,
    signal: `Volume: $${formatNumber(volume_24h)}, MC: $${formatNumber(market_cap)}, V/MC: ${(volumeRatio * 100).toFixed(2)}%, Rank: #${quote.cmc_rank}`,
  };
}

function scoreFearGreedAlignment(fearGreed: FearGreedIndex, direction: 'LONG' | 'SHORT' | 'HOLD'): { score: number; signal: string } {
  let score = 10; // Base

  const fgi = fearGreed.value;

  // Contrarian strategy: buy in fear, sell in greed
  switch (direction) {
    case 'LONG':
      if (fgi <= 25) {
        score += 20; // Best time to buy — extreme fear
      } else if (fgi <= 40) {
        score += 12; // Good time to buy — fear
      } else if (fgi >= 75) {
        score -= 10; // Risky to buy — extreme greed
      } else if (fgi >= 60) {
        score -= 5; // Cautious — greed
      }
      break;

    case 'SHORT':
      if (fgi >= 75) {
        score += 15; // Best time to sell — extreme greed
      } else if (fgi >= 60) {
        score += 8; // Good time to sell — greed
      } else if (fgi <= 25) {
        score -= 15; // Risky to short — extreme fear
      }
      break;

    case 'HOLD':
      if (fgi >= 40 && fgi <= 60) {
        score += 5; // Neutral is good for holding
      }
      break;
  }

  score = Math.max(0, Math.min(25, score));

  return {
    score,
    signal: `F&G(${fgi}) ${fearGreed.value_classification}: ${direction === 'LONG' ? 'Buyer' : direction === 'SHORT' ? 'Seller' : 'Holder'} alignment`,
  };
}

function scoreTrendingBoost(token: string, trending: CMCTrendingToken[]): { score: number; signal: string } {
  const isTrending = trending.find(t => t.symbol === token || t.symbol === token + '/BNB');

  if (!isTrending) {
    return { score: 10, signal: 'Not in trending list' };
  }

  // Trending tokens get a boost based on 24h performance
  const change = isTrending.percent_change_24h;
  let score = 15;

  if (change > 15) {
    score += 10; // Strong trending upward
  } else if (change > 5) {
    score += 5; // Moderate trending
  }

  return {
    score: Math.min(25, score),
    signal: `TRENDING #${trending.indexOf(isTrending) + 1} (+${change.toFixed(2)}%)`,
  };
}

// ─── Sentiment Strategy ──────────────────────────────────────

export class SentimentStrategy {
  readonly name = 'Sentiment';
  readonly type = 'SENTIMENT' as const;

  async generateSignal(
    token: string,
    _candles: Candle[],
    quote: CMCQuote,
    fearGreed: FearGreedIndex,
    trending: CMCTrendingToken[],
  ): Promise<Signal> {
    getLogger().debug(`[Sentiment] Analyzing ${token} with market data`);

    // Determine initial direction from price performance
    const perfResult = scorePricePerformance(quote);
    const initialDirection: Signal['direction'] =
      perfResult.direction === 'bullish' ? 'LONG' :
      perfResult.direction === 'bearish' ? 'SHORT' : 'HOLD';

    // Score each sentiment factor
    const volumeResult = scoreVolumeSentiment(quote);
    const fgiResult = scoreFearGreedAlignment(fearGreed, initialDirection);
    const trendingResult = scoreTrendingBoost(token, trending);

    // Compute composite sentiment score
    const totalScore = perfResult.score + volumeResult.score + fgiResult.score + trendingResult.score;

    // Re-evaluate direction with composite score
    let direction: Signal['direction'] = 'HOLD';
    if (totalScore >= 70) {
      direction = 'LONG';
    } else if (totalScore <= 40) {
      direction = 'SHORT';
    }

    // Strength
    const strength: Signal['strength'] =
      totalScore >= 85 ? 'STRONG' : totalScore >= 60 ? 'MODERATE' : 'WEAK';

    // Confidence
    const factors = [
      perfResult.direction,
      volumeResult.score >= 17 ? 'bullish' : volumeResult.score <= 10 ? 'bearish' : 'neutral',
      fgiResult.score >= 20 ? 'bullish' : fgiResult.score <= 10 ? 'bearish' : 'neutral',
      trendingResult.score >= 15 ? 'bullish' : 'neutral',
    ];
    const bullish = factors.filter(f => f === 'bullish').length;
    const bearish = factors.filter(f => f === 'bearish').length;
    const confidence = Math.max(bullish, bearish) / factors.length;

    // Market cap filter — avoid very low liquidity
    let liquidityWarning = '';
    if (quote.quote.USD.market_cap < 1_000_000) {
      liquidityWarning = ' ⚠ LOW LIQUIDITY';
    }

    const signal: Signal = {
      token,
      strategy: 'SENTIMENT',
      direction,
      strength,
      score: totalScore,
      confidence: Math.round(confidence * 100) / 100,
      reasoning: [
        perfResult.signal,
        volumeResult.signal,
        fgiResult.signal,
        trendingResult.signal + liquidityWarning,
      ].join(' | '),
      timestamp: Date.now(),
      metadata: {
        marketCap: quote.quote.USD.market_cap,
        volume24h: quote.quote.USD.volume_24h,
        cmcRank: quote.cmc_rank,
        fearGreed: fearGreed.value,
        isTrending: trendingResult.score > 10,
      },
    };

    return signal;
  }
}

// ─── Utility ─────────────────────────────────────────────────

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}
