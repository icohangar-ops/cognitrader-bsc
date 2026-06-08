// ============================================================
// CogniTrader BSC — BNB AI Agent SDK Wrapper
// Agent orchestration, memory, and tool execution on BNB Chain
// ============================================================

import type { AgentConfig, Signal, AggregatedSignal } from '../utils/types';
import { getLogger } from '../utils/logger';

// ─── Agent SDK Types ─────────────────────────────────────────

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface AgentMemory {
  shortTerm: AgentMessage[];
  longTerm: TradeMemoryEntry[];
  maxShortTerm: number;
}

export interface TradeMemoryEntry {
  token: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  amount: number;
  price: number;
  pnl: number;
  signalScore: number;
  reasoning: string;
  timestamp: number;
}

export interface AgentToolResult {
  tool: string;
  success: boolean;
  data: Record<string, unknown>;
  timestamp: number;
}

// ─── Agent SDK Client ───────────────────────────────────────

export class BNBAgentSDK {
  private memory: AgentMemory;
  private config: AgentConfig;
  private toolRegistry: Map<string, (args: Record<string, unknown>) => Promise<AgentToolResult>>;
  private isInitialized = false;

  constructor(config: AgentConfig) {
    this.config = config;

    this.memory = {
      shortTerm: [],
      longTerm: [],
      maxShortTerm: 50,
    };

    this.toolRegistry = new Map();
    this.registerBuiltInTools();
  }

  // ─── Initialization ───────────────────────────────────────

  async initialize(): Promise<void> {
    getLogger().info('🧠 Initializing BNB AI Agent SDK...');

    // Load persistent memory if available
    this.loadMemoryFromDisk();

    getLogger().info(`Agent memory: ${this.memory.shortTerm.length} short-term, ${this.memory.longTerm.length} long-term entries`);
    this.isInitialized = true;
    getLogger().info('✅ BNB AI Agent SDK initialized');
  }

  // ─── Tool Registry ────────────────────────────────────────

  registerTool(
    name: string,
    handler: (args: Record<string, unknown>) => Promise<AgentToolResult>,
  ): void {
    this.toolRegistry.set(name, handler);
    getLogger().debug(`Agent tool registered: ${name}`);
  }

  private registerBuiltInTools(): void {
    this.registerTool('analyze_market', async (args) => ({
      tool: 'analyze_market',
      success: true,
      data: {
        analysis: `Market analysis for ${args.token}`,
        recommendation: 'HOLD',
        factors: this.computeMarketFactors(args as { token: string; price: number; volume: number }),
      },
      timestamp: Date.now(),
    }));

    this.registerTool('check_risk', async (args) => ({
      tool: 'check_risk',
      success: true,
      data: {
        riskLevel: args.score > 80 ? 'HIGH' : args.score > 60 ? 'MEDIUM' : 'LOW',
        allowed: (args.score as number) >= this.config.minSignalScore,
        maxPosition: this.config.maxPositionPct * 100,
      },
      timestamp: Date.now(),
    }));

    this.registerTool('compute_position_size', async (args) => ({
      tool: 'compute_position_size',
      success: true,
      data: {
        positionSize: this.kellyCriterion(args as { winProb: number; avgWin: number; avgLoss: number; portfolio: number }),
        method: 'kelly_criterion',
      },
      timestamp: Date.now(),
    }));

    this.registerTool('evaluate_strategy', async (args) => ({
      tool: 'evaluate_strategy',
      success: true,
      data: {
        strategy: args.strategy,
        score: args.score,
        confidence: args.confidence,
        shouldExecute: (args.score as number) >= this.config.minSignalScore &&
          (args.confidence as number) >= this.config.minConfidence,
      },
      timestamp: Date.now(),
    }));
  }

  // ─── Agent Orchestration ───────────────────────────────────

  async orchestrateSignal(signals: Signal[]): Promise<AggregatedSignal> {
    if (signals.length === 0) {
      throw new Error('No signals to orchestrate');
    }

    const token = signals[0].token;

    // Store in short-term memory
    this.addToMemory({
      role: 'assistant',
      content: `Processing ${signals.length} signals for ${token}`,
      timestamp: Date.now(),
      metadata: { signalCount: signals.length },
    });

    // Compute composite score with weighted strategy contributions
    const strategyWeights: Record<string, number> = {
      MOMENTUM: 0.4,
      SENTIMENT: 0.35,
      MEAN_REVERSION: 0.25,
    };

    let totalWeight = 0;
    let weightedScore = 0;

    for (const signal of signals) {
      const weight = strategyWeights[signal.strategy] ?? 0.33;
      weightedScore += signal.score * weight;
      totalWeight += weight;
    }

    const compositeScore = totalWeight > 0 ? weightedScore / totalWeight : 0;

    // Determine consensus direction
    const longCount = signals.filter(s => s.direction === 'LONG').length;
    const shortCount = signals.filter(s => s.direction === 'SHORT').length;

    let consensusDirection: AggregatedSignal['consensusDirection'] = 'HOLD';
    if (longCount > shortCount && longCount >= signals.length * 0.5) {
      consensusDirection = 'LONG';
    } else if (shortCount > longCount && shortCount >= signals.length * 0.5) {
      consensusDirection = 'SHORT';
    }

    const consensusStrength: AggregatedSignal['consensusStrength'] =
      compositeScore >= 80 ? 'STRONG' : compositeScore >= 65 ? 'MODERATE' : 'WEAK';

    const aggregated: AggregatedSignal = {
      token,
      signals,
      compositeScore: Math.round(compositeScore * 100) / 100,
      consensusDirection,
      consensusStrength,
      riskScore: this.computeRiskScore(signals),
      timestamp: Date.now(),
    };

    getLogger().info(`🧠 Agent orchestration: ${token} → ${consensusDirection} (score: ${compositeScore.toFixed(1)}, strength: ${consensusStrength})`);

    return aggregated;
  }

  // ─── Memory Management ─────────────────────────────────────

  addToMemory(message: AgentMessage): void {
    this.memory.shortTerm.push(message);

    // Trim short-term memory
    if (this.memory.shortTerm.length > this.memory.maxShortTerm) {
      // Promote older entries to long-term if they contain trade data
      const trimmed = this.memory.shortTerm.splice(0, 10);
      for (const entry of trimmed) {
        if (entry.metadata?.token) {
          this.memory.longTerm.push({
            token: entry.metadata.token as string,
            action: entry.metadata.action as 'BUY' | 'SELL' | 'HOLD',
            amount: (entry.metadata.amount as number) ?? 0,
            price: (entry.metadata.price as number) ?? 0,
            pnl: (entry.metadata.pnl as number) ?? 0,
            signalScore: (entry.metadata.signalScore as number) ?? 0,
            reasoning: entry.content,
            timestamp: entry.timestamp,
          });
        }
      }
    }
  }

  addTradeMemory(entry: TradeMemoryEntry): void {
    this.memory.longTerm.push(entry);

    // Keep only last 200 long-term entries
    if (this.memory.longTerm.length > 200) {
      this.memory.longTerm = this.memory.longTerm.slice(-200);
    }

    this.persistMemoryToDisk();
  }

  getRecentSignals(count: number = 10): AgentMessage[] {
    return this.memory.shortTerm.slice(-count);
  }

  getTradeHistory(): TradeMemoryEntry[] {
    return [...this.memory.longTerm];
  }

  // ─── Risk Scoring ──────────────────────────────────────────

  private computeRiskScore(signals: Signal[]): number {
    let riskScore = 0;

    // High composite score means low risk
    const avgScore = signals.reduce((sum, s) => sum + s.score, 0) / signals.length;
    riskScore += Math.max(0, 100 - avgScore);

    // Low confidence increases risk
    const avgConfidence = signals.reduce((sum, s) => sum + s.confidence, 0) / signals.length;
    riskScore += (1 - avgConfidence) * 30;

    // Disagreement between strategies increases risk
    const directions = new Set(signals.map(s => s.direction));
    if (directions.size > 2) {
      riskScore += 20;
    }

    return Math.min(100, Math.round(riskScore));
  }

  // ─── Position Sizing: Kelly Criterion ──────────────────────

  private kellyCriterion(args: { winProb: number; avgWin: number; avgLoss: number; portfolio: number }): number {
    const { winProb, avgWin, avgLoss, portfolio } = args;

    if (avgLoss === 0) return 0;

    const kelly = winProb - ((1 - winProb) / (avgWin / avgLoss));
    const fractionalKelly = kelly * 0.5; // Half-Kelly for safety
    const maxBet = portfolio * this.config.maxPositionPct;

    return Math.min(Math.max(fractionalKelly * portfolio, 0), maxBet);
  }

  // ─── Market Factor Computation ─────────────────────────────

  private computeMarketFactors(args: { token: string; price: number; volume: number }): Record<string, string> {
    return {
      priceAction: args.price > 0 ? 'positive' : 'neutral',
      volumeTrend: args.volume > 1000000 ? 'high' : 'normal',
      liquidity: 'sufficient',
      volatility: 'moderate',
    };
  }

  // ─── Persistence ──────────────────────────────────────────

  private persistMemoryToDisk(): void {
    try {
      const { writeFileSync } = require('fs');
      writeFileSync(
        './agent-memory.json',
        JSON.stringify({
          shortTerm: this.memory.shortTerm.slice(-20),
          longTerm: this.memory.longTerm.slice(-100),
        }, null, 2),
      );
    } catch {
      // Memory persistence is best-effort
    }
  }

  private loadMemoryFromDisk(): void {
    try {
      const { existsSync, readFileSync } = require('fs');
      if (existsSync('./agent-memory.json')) {
        const data = JSON.parse(readFileSync('./agent-memory.json', 'utf-8'));
        if (data.longTerm) {
          this.memory.longTerm = data.longTerm;
        }
        if (data.shortTerm) {
          this.memory.shortTerm = data.shortTerm;
        }
        getLogger().info(`Restored agent memory: ${this.memory.shortTerm.length} short, ${this.memory.longTerm.length} long`);
      }
    } catch {
      // Fresh start if no memory file
    }
  }

  // ─── Helpers ───────────────────────────────────────────────

  isReady(): boolean {
    return this.isInitialized;
  }

  getMemoryStats(): { shortTerm: number; longTerm: number; tools: number } {
    return {
      shortTerm: this.memory.shortTerm.length,
      longTerm: this.memory.longTerm.length,
      tools: this.toolRegistry.size,
    };
  }
}
