// ============================================================
// CogniTrader BSC — Type Definitions
// Multi-Signal AI Trading Agent on BNB Chain
// ============================================================

// ─── Market Data Types ───────────────────────────────────────

export interface CMCQuote {
  id: number;
  name: string;
  symbol: string;
  slug: string;
  cmc_rank: number;
  quote: {
    USD: {
      price: number;
      volume_24h: number;
      percent_change_1h: number;
      percent_change_24h: number;
      percent_change_7d: number;
      market_cap: number;
      fully_diluted_market_cap: number;
      high_24h: number;
      low_24h: number;
    };
  };
}

export interface CMCTrendingToken {
  id: number;
  name: string;
  symbol: string;
  slug: string;
  cmc_rank: number;
  market_cap: number;
  percent_change_24h: number;
  volume_24h: number;
  dominance: number;
}

export interface FearGreedIndex {
  value: number;
  value_classification: FearGreedClassification;
  timestamp: string;
  time_until_update: string;
}

export type FearGreedClassification =
  | 'Extreme Fear'
  | 'Fear'
  | 'Neutral'
  | 'Greed'
  | 'Extreme Greed';

export interface MarketSnapshot {
  quotes: Map<string, CMCQuote>;
  trending: CMCTrendingToken[];
  fearGreed: FearGreedIndex;
  timestamp: number;
}

// ─── Signal & Strategy Types ──────────────────────────────────

export type SignalDirection = 'LONG' | 'SHORT' | 'HOLD';
export type SignalStrength = 'STRONG' | 'MODERATE' | 'WEAK';
export type StrategyType = 'MOMENTUM' | 'SENTIMENT' | 'MEAN_REVERSION';

export interface Signal {
  token: string;
  strategy: StrategyType;
  direction: SignalDirection;
  strength: SignalStrength;
  score: number; // 0–100 composite score
  confidence: number; // 0–1 confidence interval
  reasoning: string;
  timestamp: number;
  metadata: Record<string, number | string | boolean>;
}

export interface AggregatedSignal {
  token: string;
  signals: Signal[];
  compositeScore: number;
  consensusDirection: SignalDirection;
  consensusStrength: SignalStrength;
  riskScore: number; // 0–100 (higher = riskier)
  timestamp: number;
}

export interface TradeDecision {
  token: string;
  direction: SignalDirection;
  amountIn: string; // in BNB
  amountOutMin: string; // minimum tokens to receive
  slippageTolerance: number; // basis points
  deadline: number; // unix timestamp
  reasoning: string;
  signals: Signal[];
  riskAssessment: RiskAssessment;
}

// ─── Risk Management Types ───────────────────────────────────

export interface RiskAssessment {
  approved: boolean;
  positionSize: string; // BNB amount to trade
  maxPositionPct: number; // max % of portfolio
  stopLossPct: number; // stop-loss percentage
  takeProfitPct: number; // take-profit percentage
  riskRewardRatio: number;
  reasons: string[];
  warnings: string[];
  riskScore?: number; // 0–100 (higher = riskier), carried from the originating signal
}

export interface PortfolioState {
  totalValueBNB: number;
  availableBNB: number;
  positions: Position[];
  dailyPnL: number;
  dailyPnLPct: number;
  maxDrawdown: number;
  unrealizedPnL: number;
}

export interface Position {
  token: string;
  symbol: string;
  amount: string;
  entryPrice: number;
  currentPrice: number;
  valueBNB: number;
  pnl: number;
  pnlPct: number;
  openedAt: number;
  stopLoss: number;
  takeProfit: number;
}

// ─── Trade Execution Types ───────────────────────────────────

export interface TradeResult {
  success: boolean;
  txHash: string;
  fromToken: string;
  toToken: string;
  amountIn: string;
  amountOut: string;
  gasUsed: string;
  gasPrice: string;
  blockNumber: number;
  timestamp: number;
  error?: string;
}

export interface BSCConfig {
  rpcUrl: string;
  /** Optional backup RPC endpoints (rotated to on failure). */
  rpcFallbackUrls: string[];
  chainId: number;
  walletAddress: string;
  privateKey: string;
  pancakeSwapRouter: string;
  pancakeSwapFactory: string;
  wbnbAddress: string;
}

export interface CMCConfig {
  apiKey: string;
  baseUrl: string;
  rateLimitMs: number;
}

export interface TWAKConfig {
  walletPath: string;
  policyEngineEnabled: boolean;
  maxTxValueBNB: number;
  allowedTokens: string[];
  requireConfirmation: boolean;
  autonomousMode: boolean;
}

export interface AgentConfig {
  pollingIntervalMs: number;
  maxConcurrentPositions: number;
  maxPositionPct: number;
  stopLossPct: number;
  takeProfitPct: number;
  dailyDrawdownLimitPct: number;
  minSignalScore: number;
  minConfidence: number;
  slippageBps: number;
  dryRun: boolean;
  strategies: StrategyType[];
  tokens: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface FullConfig {
  bsc: BSCConfig;
  cmc: CMCConfig;
  twak: TWAKConfig;
  agent: AgentConfig;
}

// ─── Agent State Types ───────────────────────────────────────

export type AgentStatus = 'INITIALIZING' | 'RUNNING' | 'PAUSED' | 'ERROR' | 'STOPPED';

export interface AgentMetrics {
  status: AgentStatus;
  uptime: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalPnL: number;
  winRate: number;
  avgTradePnL: number;
  bestTrade: number;
  worstTrade: number;
  signalsGenerated: number;
  signalsActedOn: number;
  cycleCount: number;
  lastCycleTime: number;
  portfolio: PortfolioState;
}

// ─── Token Pair Types ───────────────────────────────────────

export interface TokenPair {
  base: string;
  quote: string;
  address: string;
  decimals: number;
  symbol: string;
}

// ─── Candle / OHLCV Types ───────────────────────────────────

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OHLCVSeries {
  token: string;
  interval: string;
  candles: Candle[];
}
