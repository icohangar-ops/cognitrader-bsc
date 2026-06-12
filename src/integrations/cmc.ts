// ============================================================
// CogniTrader BSC — CoinMarketCap API Client
// Fetches market data, Fear & Greed index, trending tokens
// ============================================================

import axios, { type AxiosInstance } from 'axios';
import type { CMCQuote, CMCTrendingToken, FearGreedIndex, MarketSnapshot, OHLCVSeries, Candle } from '../utils/types';
import { getLogger } from '../utils/logger';

export class CoinMarketCapClient {
  private client: AxiosInstance;
  private lastRequestTime = 0;
  private rateLimitMs: number;

  constructor(apiKey: string, baseUrl: string = 'https://pro-api.coinmarketcap.com', rateLimitMs: number = 5000) {
    this.rateLimitMs = rateLimitMs;

    this.client = axios.create({
      baseURL: baseUrl,
      headers: {
        'X-CMC_PRO_API_KEY': apiKey,
        'Accept': 'application/json',
      },
      timeout: 15000,
    });

    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        const status = error.response?.status;
        const message = error.response?.data?.status?.error_message ?? error.message;
        getLogger().error(`CMC API error [${status}]: ${message}`);
        return Promise.reject(new Error(`CMC API [${status}]: ${message}`));
      },
    );
  }

  // ─── Rate Limiting ─────────────────────────────────────────

  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.rateLimitMs) {
      const delay = this.rateLimitMs - elapsed;
      getLogger().debug(`Rate limit: waiting ${delay}ms before next CMC request`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    this.lastRequestTime = Date.now();
  }

  // ─── Latest Quotes ────────────────────────────────────────

  async getLatestQuotes(symbols: string[]): Promise<Map<string, CMCQuote>> {
    await this.enforceRateLimit();

    const symbolStr = symbols.join(',');
    getLogger().debug(`Fetching CMC quotes for: ${symbolStr}`);

    const response = await this.client.get('/v2/cryptocurrency/quotes/latest', {
      params: { symbol: symbolStr, convert: 'USD' },
    });

    const quoteMap = new Map<string, CMCQuote>();
    const data = response.data.data;

    for (const symbol of Object.keys(data)) {
      quoteMap.set(symbol, data[symbol] as CMCQuote);
    }

    getLogger().info(`CMC quotes fetched: ${quoteMap.size} tokens`);
    return quoteMap;
  }

  // ─── Fear & Greed Index ───────────────────────────────────

  async getFearAndGreedIndex(): Promise<FearGreedIndex> {
    await this.enforceRateLimit();

    getLogger().debug('Fetching CMC Fear & Greed Index');

    const response = await this.client.get('/v2/fear-and-greed/index');

    const data = response.data.data;
    const fgi: FearGreedIndex = {
      value: data.value,
      value_classification: data.value_classification,
      timestamp: data.timestamp,
      time_until_update: data.time_until_update,
    };

    getLogger().info(`Fear & Greed: ${fgi.value} (${fgi.value_classification})`);
    return fgi;
  }

  // ─── Trending Tokens ──────────────────────────────────────

  async getTrendingTokens(): Promise<CMCTrendingToken[]> {
    await this.enforceRateLimit();

    getLogger().debug('Fetching CMC trending tokens');

    const response = await this.client.get('/v2/cryptocurrency/trending');

    const trending: CMCTrendingToken[] = response.data.data.map((item: Record<string, unknown>) => ({
      id: item.id as number,
      name: item.name as string,
      symbol: item.symbol as string,
      slug: item.slug as string,
      cmc_rank: item.cmc_rank as number,
      market_cap: (item.quote as Record<string, Record<string, number>>)?.USD?.market_cap ?? 0,
      percent_change_24h: (item.quote as Record<string, Record<string, number>>)?.USD?.percent_change_24h ?? 0,
      volume_24h: (item.quote as Record<string, Record<string, number>>)?.USD?.volume_24h ?? 0,
      dominance: (item.quote as Record<string, Record<string, number>>)?.USD?.market_cap_dominance ?? 0,
    }));

    getLogger().info(`Trending tokens: ${trending.length} found`);
    return trending;
  }

  // ─── OHLCV Historical Data ────────────────────────────────

  async getOHLCV(symbol: string, interval: string = '1h', count: number = 168): Promise<OHLCVSeries> {
    await this.enforceRateLimit();

    getLogger().debug(`Fetching OHLCV for ${symbol}: ${interval} x ${count}`);

    const response = await this.client.get('/v2/cryptocurrency/ohlcv/historical', {
      params: { symbol, convert: 'USD', time_start: this.getTimeStart(interval, count) },
    });

    const candles: Candle[] = response.data.data.map((item: Record<string, unknown>) => ({
      timestamp: new Date(item.timestamp as string).getTime() / 1000,
      open: (item.quote as Record<string, Record<string, number>>)?.USD?.open ?? 0,
      high: (item.quote as Record<string, Record<string, number>>)?.USD?.high ?? 0,
      low: (item.quote as Record<string, Record<string, number>>)?.USD?.low ?? 0,
      close: (item.quote as Record<string, Record<string, number>>)?.USD?.close ?? 0,
      volume: (item.quote as Record<string, Record<string, number>>)?.USD?.volume ?? 0,
    }));

    return { token: symbol, interval, candles };
  }

  private getTimeStart(interval: string, count: number): string {
    const intervalMs: Record<string, number> = {
      '1m': 60_000,
      '5m': 300_000,
      '15m': 900_000,
      '1h': 3_600_000,
      '6h': 21_600_000,
      '1d': 86_400_000,
    };
    const ms = (intervalMs[interval] ?? 3_600_000) * count;
    const date = new Date(Date.now() - ms);
    return date.toISOString();
  }

  // ─── Full Market Snapshot ─────────────────────────────────

  async getMarketSnapshot(tokens: string[]): Promise<MarketSnapshot> {
    getLogger().info('📡 Fetching full market snapshot...');

    const [quotes, fearGreed, trending] = await Promise.allSettled([
      this.getLatestQuotes(tokens),
      this.getFearAndGreedIndex(),
      this.getTrendingTokens(),
    ]);

    const quoteMap = new Map<string, CMCQuote>();
    if (quotes.status === 'fulfilled') {
      quotes.value.forEach((v, k) => quoteMap.set(k, v));
    } else {
      getLogger().warn(`Failed to fetch quotes: ${quotes.reason}`);
    }

    const fgi: FearGreedIndex = fearGreed.status === 'fulfilled'
      ? fearGreed.value
      : { value: 50, value_classification: 'Neutral', timestamp: new Date().toISOString(), time_until_update: '' };

    const trendingTokens: CMCTrendingToken[] = trending.status === 'fulfilled'
      ? trending.value
      : [];

    return {
      quotes: quoteMap,
      trending: trendingTokens,
      fearGreed: fgi,
      timestamp: Date.now(),
    };
  }
}
