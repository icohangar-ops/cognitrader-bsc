// ============================================================
// CogniTrader BSC — Core Agent Orchestrator
// Main loop: CMC data → signals → risk check → execute via TWAK/BNB
// ============================================================

import type {
  FullConfig,
  AgentMetrics,
  AgentStatus,
  PortfolioState,
  TradeResult,
  Position,
} from '../utils/types';
import { CoinMarketCapClient } from '../integrations/cmc';
import { TrustWalletAgentKit } from '../integrations/twak';
import { BSCClient } from '../integrations/bsc';
import { BNBAgentSDK } from '../integrations/bnb-agent-sdk';
import { SignalEngine } from './SignalEngine';
import { RiskManager } from './RiskManager';
import { StrategyEngine } from './StrategyEngine';
import { getLogger, logMetrics } from '../utils/logger';

export class CogniTrader {
  // ─── Services ──────────────────────────────────────────────
  private config: FullConfig;
  private cmc: CoinMarketCapClient;
  private twak: TrustWalletAgentKit;
  private bsc: BSCClient;
  private agentSDK: BNBAgentSDK;
  private signalEngine: SignalEngine;
  private riskManager: RiskManager;
  private strategyEngine: StrategyEngine;

  // ─── State ─────────────────────────────────────────────────
  private status: AgentStatus = 'INITIALIZING';
  private isRunning = false;
  private startTime = 0;
  private cycleCount = 0;
  private lastCycleTime = 0;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  // ─── Metrics ───────────────────────────────────────────────
  private metrics: AgentMetrics = {
    status: 'INITIALIZING',
    uptime: 0,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    totalPnL: 0,
    winRate: 0,
    avgTradePnL: 0,
    bestTrade: 0,
    worstTrade: 0,
    signalsGenerated: 0,
    signalsActedOn: 0,
    cycleCount: 0,
    lastCycleTime: 0,
    portfolio: {
      totalValueBNB: 0,
      availableBNB: 0,
      positions: [],
      dailyPnL: 0,
      dailyPnLPct: 0,
      maxDrawdown: 0,
      unrealizedPnL: 0,
    },
  };

  constructor(config: FullConfig) {
    this.config = config;

    // Initialize services
    this.cmc = new CoinMarketCapClient(
      config.cmc.apiKey,
      config.cmc.baseUrl,
      config.cmc.rateLimitMs,
    );

    this.twak = new TrustWalletAgentKit(config.twak, config.bsc);
    this.bsc = new BSCClient(config.bsc);
    this.agentSDK = new BNBAgentSDK(config.agent);
    this.riskManager = new RiskManager(config.agent);
    this.signalEngine = new SignalEngine(config.agent, this.agentSDK);
    this.strategyEngine = new StrategyEngine(
      config.agent,
      this.bsc,
      this.twak,
      this.riskManager,
      this.agentSDK,
    );
  }

  // ─── Initialization ───────────────────────────────────────

  async initialize(): Promise<void> {
    getLogger().info('🚀 Initializing CogniTrader BSC...');
    getLogger().info('━'.repeat(60));

    try {
      // Initialize integrations
      await Promise.all([
        this.twak.initialize(),
        this.bsc.initialize(),
        this.agentSDK.initialize(),
      ]);

      // Initialize portfolio baseline
      const balance = await this.bsc.getBNBBalance();
      this.riskManager.initializeDailyBaseline(balance);

      // Initialize metrics
      this.startTime = Date.now();
      this.status = 'RUNNING';

      getLogger().info('━'.repeat(60));
      getLogger().info('✅ CogniTrader BSC initialized successfully');
      getLogger().info(`📦 Wallet Mode: ${this.twak.getMode()}`);
      getLogger().info(`📊 Starting Balance: ${balance.toFixed(4)} BNB`);
      getLogger().info(`⚡ Strategies: ${this.config.agent.strategies.join(', ')}`);
      getLogger().info(`🎯 Tokens: ${this.config.agent.tokens.join(', ')}`);
      getLogger().info(`⏱ Polling Interval: ${this.config.agent.pollingIntervalMs / 1000}s`);
      getLogger().info(`🛡 Max Positions: ${this.config.agent.maxConcurrentPositions}`);
      getLogger().info(`💸 Max Position Size: ${this.config.agent.maxPositionPct * 100}% of portfolio`);
      getLogger().info(`🛑 Stop Loss: ${this.config.agent.stopLossPct * 100}%`);
      getLogger().info(`🎯 Take Profit: ${this.config.agent.takeProfitPct * 100}%`);
      getLogger().info(`📉 Daily Drawdown Limit: ${this.config.agent.dailyDrawdownLimitPct * 100}%`);
      getLogger().info(`${
        this.config.agent.dryRun ? '🧪 DRY RUN MODE — No real trades' : '🔴 LIVE TRADING MODE'
      }`);
      getLogger().info('━'.repeat(60));

    } catch (error) {
      this.status = 'ERROR';
      const msg = error instanceof Error ? error.message : String(error);
      getLogger().error(`❌ Initialization failed: ${msg}`);
      throw error;
    }
  }

  // ─── Main Agent Loop ───────────────────────────────────────

  start(): void {
    if (this.isRunning) {
      getLogger().warn('Agent is already running');
      return;
    }

    this.isRunning = true;
    this.status = 'RUNNING';

    getLogger().info('🔄 Starting agent loop...');

    // Run immediately, then on interval
    this.runCycle();

    this.intervalHandle = setInterval(
      () => this.runCycle(),
      this.config.agent.pollingIntervalMs,
    );

    getLogger().info(`Agent loop started with ${this.config.agent.pollingIntervalMs / 1000}s interval`);
  }

  async runCycle(): Promise<void> {
    const cycleStart = Date.now();
    this.cycleCount++;

    getLogger().info(`\n${'═'.repeat(60)}`);
    getLogger().info(`📊 CYCLE #${this.cycleCount} — ${new Date().toISOString()}`);
    getLogger().info(`${'═'.repeat(60)}`);

    try {
      // Step 1: Fetch market data
      const snapshot = await this.cmc.getMarketSnapshot(this.config.agent.tokens);

      // Step 2: Generate signals
      const signals = await this.signalEngine.generateSignals(
        this.config.agent.tokens,
        snapshot,
      );
      this.metrics.signalsGenerated += signals.length;

      // Step 3: Log signals
      if (signals.length > 0) {
        getLogger().info(`\n📈 Top Signals:`);
        for (const signal of signals.slice(0, 5)) {
          getLogger().info(
            `  ${signal.consensusStrength.padEnd(8)} ${signal.token.padEnd(6)} ${signal.consensusDirection} (score: ${signal.compositeScore}, risk: ${signal.riskScore})`,
          );
        }
      } else {
        getLogger().info('📭 No actionable signals this cycle');
      }

      // Step 4: Execute trades
      if (signals.length > 0) {
        const results = await this.strategyEngine.executeSignals(signals);
        this.processTradeResults(results);
      }

      // Step 5: Check existing positions for exits
      await this.strategyEngine.checkExistingPositions();

      // Step 6: Update portfolio and metrics
      const portfolio = await this.strategyEngine.getPortfolioState();
      this.metrics.portfolio = portfolio;
      this.metrics.uptime = Date.now() - this.startTime;

      // Step 7: Log metrics
      logMetrics(this.metrics);

    } catch (error) {
      this.status = 'ERROR';
      const msg = error instanceof Error ? error.message : String(error);
      getLogger().error(`❌ Cycle #${this.cycleCount} failed: ${msg}`);
      this.status = 'RUNNING'; // Recover and continue
    }

    this.lastCycleTime = Date.now() - cycleStart;
    this.metrics.cycleCount = this.cycleCount;
    this.metrics.lastCycleTime = this.lastCycleTime;
  }

  // ─── Trade Result Processing ───────────────────────────────

  private processTradeResults(results: TradeResult[]): void {
    for (const result of results) {
      if (!result.txHash || result.txHash.startsWith('dry-run') || result.txHash === '') {
        continue; // Skip non-trades
      }

      this.metrics.totalTrades++;

      if (result.success) {
        getLogger().info(`✅ Trade executed: ${result.fromToken} → ${result.toToken} (TX: ${result.txHash})`);

        // Track PnL (simplified)
        const amountIn = parseFloat(result.amountIn);
        if (amountIn > 0) {
          // We'll update PnL when position is closed
        }
      } else {
        getLogger().error(`❌ Trade failed: ${result.fromToken} → ${result.toToken}: ${result.error}`);
      }
    }

    if (results.some(r => r.txHash && r.txHash !== '')) {
      this.metrics.signalsActedOn++;
    }
  }

  // ─── Control ───────────────────────────────────────────────

  stop(): void {
    getLogger().info('🛑 Stopping CogniTrader BSC...');

    this.isRunning = false;
    this.status = 'STOPPED';

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    getLogger().info('━'.repeat(60));
    getLogger().info('🛑 Agent stopped. Final metrics:');
    logMetrics(this.metrics);
    getLogger().info('━'.repeat(60));
  }

  pause(): void {
    if (!this.isRunning) return;

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    this.status = 'PAUSED';
    getLogger().info('⏸ Agent paused');
  }

  resume(): void {
    if (this.isRunning) return;

    this.start();
    getLogger().info('▶ Agent resumed');
  }

  // ─── Status ─────────────────────────────────────────────────

  getStatus(): AgentStatus {
    return this.status;
  }

  getMetrics(): AgentMetrics {
    this.metrics.uptime = Date.now() - this.startTime;
    this.metrics.status = this.status;
    return { ...this.metrics };
  }

  getPortfolioState(): Promise<PortfolioState> {
    return this.strategyEngine.getPortfolioState();
  }

  getPositions(): Position[] {
    return this.strategyEngine.getPositions();
  }

  isLive(): boolean {
    return !this.config.agent.dryRun;
  }
}
