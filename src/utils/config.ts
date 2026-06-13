// ============================================================
// CogniTrader BSC — Configuration Management
// ============================================================

import dotenv from 'dotenv';
import path from 'path';
import type { FullConfig, AgentConfig, BSCConfig, CMCConfig, TWAKConfig } from './types';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export function loadConfig(): FullConfig {
  return {
    bsc: loadBSCConfig(),
    cmc: loadCMCConfig(),
    twak: loadTWAKConfig(),
    agent: loadAgentConfig(),
  };
}

function loadBSCConfig(): BSCConfig {
  const rpcUrl = process.env.BSC_RPC_URL;
  if (!rpcUrl) {
    throw new Error('BSC_RPC_URL environment variable is required');
  }

  const rpcFallbackUrls = (process.env.BSC_RPC_FALLBACK_URLS ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u.length > 0);

  return {
    rpcUrl,
    rpcFallbackUrls,
    chainId: parseInt(process.env.BSC_CHAIN_ID ?? '56', 10),
    walletAddress: requiredEnv('BSC_WALLET_ADDRESS'),
    privateKey: requiredEnv('BSC_PRIVATE_KEY'),
    pancakeSwapRouter: process.env.PANCAKESWAP_ROUTER ?? '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    pancakeSwapFactory: process.env.PANCAKESWAP_FACTORY ?? '0xcA143Ce32Fe78f1f7019d72855a1425CE3c76cC1',
    wbnbAddress: process.env.WBNB_ADDRESS ?? '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  };
}

function loadCMCConfig(): CMCConfig {
  return {
    apiKey: requiredEnv('CMC_API_KEY'),
    baseUrl: process.env.CMC_BASE_URL ?? 'https://pro-api.coinmarketcap.com',
    rateLimitMs: parseInt(process.env.CMC_RATE_LIMIT_MS ?? '5000', 10),
  };
}

function loadTWAKConfig(): TWAKConfig {
  return {
    walletPath: process.env.TWAK_WALLET_PATH ?? './wallet.json',
    policyEngineEnabled: process.env.TWAK_POLICY_ENGINE !== 'false',
    maxTxValueBNB: parseFloat(process.env.TWAK_MAX_TX_BNB ?? '5'),
    allowedTokens: (process.env.TWAK_ALLOWED_TOKENS ?? 'CAKE,BNB,BUSD,USDT').split(',').map(t => t.trim()),
    requireConfirmation: process.env.TWAK_REQUIRE_CONFIRMATION !== 'false',
    autonomousMode: process.env.TWAK_AUTONOMOUS_MODE === 'true',
  };
}

function loadAgentConfig(): AgentConfig {
  return {
    pollingIntervalMs: parseInt(process.env.AGENT_POLLING_INTERVAL ?? '30000', 10),
    maxConcurrentPositions: parseInt(process.env.AGENT_MAX_POSITIONS ?? '3', 10),
    maxPositionPct: parseFloat(process.env.AGENT_MAX_POSITION_PCT ?? '0.10'),
    stopLossPct: parseFloat(process.env.AGENT_STOP_LOSS_PCT ?? '0.05'),
    takeProfitPct: parseFloat(process.env.AGENT_TAKE_PROFIT_PCT ?? '0.15'),
    dailyDrawdownLimitPct: parseFloat(process.env.AGENT_DAILY_DRAWDOWN_PCT ?? '0.10'),
    minSignalScore: parseFloat(process.env.AGENT_MIN_SIGNAL_SCORE ?? '65'),
    minConfidence: parseFloat(process.env.AGENT_MIN_CONFIDENCE ?? '0.6'),
    slippageBps: parseInt(process.env.AGENT_SLIPPAGE_BPS ?? '50', 10),
    dryRun: process.env.AGENT_DRY_RUN === 'true',
    strategies: (process.env.AGENT_STRATEGIES ?? 'MOMENTUM,SENTIMENT,MEAN_REVERSION').split(',').map(s => s.trim()) as AgentConfig['strategies'],
    tokens: (process.env.AGENT_TOKENS ?? 'CAKE,ETH,ADA,SOL,AVAX').split(',').map(t => t.trim()),
    logLevel: (process.env.AGENT_LOG_LEVEL ?? 'info') as AgentConfig['logLevel'],
  };
}

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Environment variable ${key} is required but not set`);
  }
  return value;
}

export function validateConfig(config: FullConfig): void {
  // Validate BSC
  if (!config.bsc.rpcUrl.startsWith('http')) {
    throw new Error('BSC_RPC_URL must be a valid HTTP endpoint');
  }
  if (!config.bsc.privateKey.startsWith('0x') || config.bsc.privateKey.length !== 66) {
    throw new Error('BSC_PRIVATE_KEY must be a valid 64-char hex string with 0x prefix');
  }

  // Validate CMC
  if (config.cmc.apiKey.length < 10) {
    throw new Error('CMC_API_KEY appears invalid (too short)');
  }

  // Validate Agent
  if (config.agent.maxPositionPct > 0.2) {
    throw new Error('AGENT_MAX_POSITION_PCT cannot exceed 20% for safety');
  }
  if (config.agent.stopLossPct > 0.15) {
    throw new Error('AGENT_STOP_LOSS_PCT cannot exceed 15% for safety');
  }
  if (config.agent.maxConcurrentPositions > 5) {
    throw new Error('AGENT_MAX_POSITIONS cannot exceed 5 for safety');
  }
  if (config.agent.dailyDrawdownLimitPct > 0.2) {
    throw new Error('AGENT_DAILY_DRAWDOWN_PCT cannot exceed 20% for safety');
  }
}
