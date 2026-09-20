// ============================================================
// CogniTrader BSC — Strategy Engine
// Strategy selection, execution logic, and portfolio management
// ============================================================

import type {
  AgentConfig,
  AggregatedSignal,
  TradeDecision,
  TradeResult,
  PortfolioState,
  Position,
  RiskAssessment,
} from '../utils/types';
import { BSCClient } from '../integrations/bsc';
import { TrustWalletAgentKit } from '../integrations/twak';
import { RiskManager } from './RiskManager';
import { BNBAgentSDK } from '../integrations/bnb-agent-sdk';
import { getLogger, logTrade, logRiskWarning } from '../utils/logger';
import { ChpGate, type ChpAction } from '../chp/gate';
import {
  ChpTradeGate,
  ChpRejection,
  type ChpVerdict,
  type DecisionCase,
  type FoundationAssessment,
  type ParityEvidence,
  type R0Evaluation,
  type RevalidatedLedgerEntry,
} from '../chp/hardening';
import {
  hashTradeArgs,
  issueTradeReceipt,
  resolveReceiptKey,
  verifyExecutionReceipt,
  type ReceiptRisk,
  type TradeApprovalReceipt,
  type TradeReceiptArgs,
} from '../chp/receipt';
import { InMemoryReplayStore } from '../chp/replay';

/** Receipt TTL — matches the 300s swap deadline in createTradeDecision. */
const RECEIPT_TTL_MS = 5 * 60 * 1000;

/** A fully-gated trade parked as PROVISIONAL_LOCK pending a named confirmer. */
interface PendingTrade {
  kase: DecisionCase;
  decision: TradeDecision;
  assessment: FoundationAssessment;
  r0Verdict: ChpVerdict;
  foundationVerdict: ChpVerdict;
  amountInBnb: number;
}

export class StrategyEngine {
  private config: AgentConfig;
  private bscClient: BSCClient;
  private twak: TrustWalletAgentKit;
  private riskManager: RiskManager;
  private agentSDK: BNBAgentSDK;
  private positions: Map<string, Position>;
  private chpGate: ChpGate;
  private chpHardening: ChpTradeGate;
  /** Trades parked as PROVISIONAL_LOCK awaiting a named confirmer. */
  private pendingTrades: Map<string, PendingTrade>;
  /** Row 22: single-use nonces for issued execution receipts. */
  private readonly receiptReplay = new InMemoryReplayStore();
  /** HMAC key for execution receipts ($CHP_RECEIPT_KEY; dev fallback logged). */
  private readonly receiptKey = resolveReceiptKey();

  constructor(
    config: AgentConfig,
    bscClient: BSCClient,
    twak: TrustWalletAgentKit,
    riskManager: RiskManager,
    agentSDK: BNBAgentSDK,
    chpGate?: ChpGate,
    chpHardening?: ChpTradeGate,
  ) {
    this.config = config;
    this.bscClient = bscClient;
    this.twak = twak;
    this.riskManager = riskManager;
    this.agentSDK = agentSDK;
    this.positions = new Map();
    // Decision-governance gate. Loads policy.yaml (conservative default
    // if missing). Every capital-moving trade passes through it.
    this.chpGate = chpGate ?? new ChpGate();
    // CHP hardening (consensus-hardening-protocol Profile A port):
    // R0 -> deterministic adversary foundation -> human lock -> ledger.
    this.chpHardening = chpHardening ?? new ChpTradeGate();
    this.pendingTrades = new Map();
  }

  // ─── Main Execution Loop ──────────────────────────────────

  async executeSignals(signals: AggregatedSignal[]): Promise<TradeResult[]> {
    const results: TradeResult[] = [];

    for (const signal of signals) {
      try {
        const result = await this.processSignal(signal);
        results.push(result);
      } catch (error) {
        getLogger().error(`Failed to process signal for ${signal.token}`, error);
        results.push({
          success: false,
          txHash: '',
          fromToken: 'BNB',
          toToken: signal.token,
          amountIn: '0',
          amountOut: '0',
          gasUsed: '0',
          gasPrice: '0',
          blockNumber: 0,
          timestamp: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  // ─── Process Individual Signal ─────────────────────────────

  private async processSignal(signal: AggregatedSignal): Promise<TradeResult> {
    getLogger().info(`🎯 Processing signal: ${signal.token} → ${signal.consensusDirection} (${signal.compositeScore})`);

    // Skip HOLD signals
    if (signal.consensusDirection === 'HOLD') {
      getLogger().debug(`${signal.token}: HOLD — no action needed`);
      return this.noopResult(signal.token);
    }

    // Check existing positions for stop-loss/take-profit
    await this.checkExistingPositions();

    // Create trade decision
    const decision = this.createTradeDecision(signal);
    if (!decision) {
      getLogger().debug(`${signal.token}: No trade decision created`);
      return this.noopResult(signal.token);
    }

    // Snapshot portfolio state once; R0 reads it and the risk engine reuses it.
    const portfolio = await this.getPortfolioState();

    // ─── CHP R0 gate — before the engine ──────────────────────────
    // "Is this trade solvable from the current portfolio state?"
    // Failures are FATAL: HALT refuses the trade before any guardrail,
    // risk, or execution machinery runs (audited as chp_rejected).
    let r0: R0Evaluation;
    try {
      r0 = this.chpHardening.openR0(this.r0Criteria(decision, signal));
    } catch (error) {
      if (error instanceof ChpRejection) {
        logRiskWarning(`chp_rejected [R0] ${signal.token}: ${error.message} [r0 ${error.evaluation?.verdict}]`);
        return this.noopResult(signal.token);
      }
      throw error;
    }

    // TWAK policy check
    const policyResult = this.twak.checkPolicy({
      token: decision.token,
      amountBNB: parseFloat(decision.amountIn),
    });

    if (!policyResult.allowed) {
      logRiskWarning(`TWAK policy blocked: ${policyResult.reason}`);
      return this.noopResult(signal.token);
    }

    // Risk assessment (reuses the R0 portfolio snapshot)
    const riskAssessment = this.riskManager.assessRisk(decision, portfolio);

    if (!riskAssessment.approved) {
      getLogger().warn(`${signal.token}: Risk blocked — ${riskAssessment.reasons.join('; ')}`);
      return this.noopResult(signal.token);
    }

    if (riskAssessment.warnings.length > 0) {
      for (const warning of riskAssessment.warnings) {
        logRiskWarning(warning);
      }
    }

    // ─── CHP decision gate (governance) ───────────────────────
    // Convert the BNB notional to USD and run it through the policy
    // gate. Blocked or HITL-required trades are not submitted.
    const bnbPriceUsd = this.config.bnbPriceUsd ?? 600;
    const notionalUsd = parseFloat(decision.amountIn) * bnbPriceUsd;
    const avgConfidence =
      decision.signals.reduce((s, sig) => s + sig.confidence, 0) /
      Math.max(decision.signals.length, 1);
    const chp = this.chpGate.evaluate({
      action: decision.direction as ChpAction,
      asset: decision.token,
      notionalUsd,
      confidence: avgConfidence,
      rationale: decision.reasoning,
    });
    if (!chp.allowed) {
      if (chp.requiresHuman) {
        logRiskWarning(
          `CHP gate requires human approval for ${decision.token} ($${notionalUsd.toFixed(0)}): ${chp.reason} [decision ${chp.provenance.decisionId}]`,
        );
      } else {
        getLogger().warn(
          `${decision.token}: CHP gate ${chp.state} — ${chp.reason} [decision ${chp.provenance.decisionId}]`,
        );
      }
      return this.noopResult(signal.token);
    }

    // Log trade decision
    logTrade({
      token: decision.token,
      amountIn: decision.amountIn,
      direction: decision.direction,
      reasoning: decision.reasoning,
    });

    // ─── CHP foundation pass + human lock ─────────────────────
    // The deterministic adversary scores the fully guarded trade
    // (TWAK policy + risk assessment + spend gate = guardrails), then
    // the case opens PROVISIONAL_LOCK pending human confirmation.
    try {
      return await this.hardenAndExecute(signal, decision, portfolio, riskAssessment, policyResult.allowed, r0);
    } catch (error) {
      if (error instanceof ChpRejection) {
        logRiskWarning(`chp_rejected [foundation] ${signal.token}: ${error.message}`);
        return this.noopResult(signal.token);
      }
      throw error;
    }
  }

  // ─── CHP Hardening (consensus-hardening-protocol Profile A) ──

  /** R0 criteria, trade-shaped: solvable from the current portfolio state? */
  private r0Criteria(
    decision: TradeDecision,
    signal: AggregatedSignal,
  ) {
    const sizingBase = this.riskManager.getDailyStartValue();
    const amountIn = parseFloat(decision.amountIn);
    const avgConfidence =
      signal.signals.reduce((sum, sig) => sum + sig.confidence, 0) /
      Math.max(signal.signals.length, 1);
    return {
      solvable:
        decision.token.trim() !== '' &&
        (decision.direction === 'LONG' || decision.direction === 'SHORT') &&
        sizingBase > 0 &&
        amountIn >= 0.001,
      scoped:
        Number.isFinite(decision.slippageTolerance) &&
        decision.slippageTolerance > 0 &&
        Number.isFinite(decision.deadline) &&
        decision.deadline > Math.floor(Date.now() / 1000),
      // Well-formed backing: a LONG swaps the base asset; a SHORT needs an
      // existing position to sell.
      valid: decision.direction === 'LONG' || this.positions.has(decision.token),
      worth_it:
        avgConfidence >= this.config.minConfidence &&
        signal.compositeScore >= this.config.minSignalScore,
    };
  }

  /**
   * Parity evidence: the decision's size must re-derive from the same
   * sizing basis the portfolio state implies (state assertion serving in
   * place of a golden set — see foundation.ts).
   */
  private parityEvidence(decision: TradeDecision): ParityEvidence {
    const sizingBase = this.riskManager.getDailyStartValue();
    const expected = Math.min(
      sizingBase * this.config.maxPositionPct,
      sizingBase * 0.05,
    );
    const actual = parseFloat(decision.amountIn);
    // decision.amountIn is toFixed(4)-rounded, so allow 0.001 BNB drift.
    const tolerance = 0.001;
    const comparable = Number.isFinite(actual);
    return {
      caseId: 'portfolio-sizing-assertion',
      metric: 'trade_size_bnb',
      unit: 'bnb',
      expected,
      tolerance,
      actual: comparable ? actual : null,
      withinTolerance: comparable ? Math.abs(actual - expected) <= tolerance : null,
    };
  }

  /**
   * Foundation pass + human lock, then execution. The spend gate, TWAK
   * policy, and risk assessment have all passed by this point — they are
   * the guardrail stack the adversary scores.
   */
  private async hardenAndExecute(
    signal: AggregatedSignal,
    decision: TradeDecision,
    portfolio: PortfolioState,
    riskAssessment: RiskAssessment,
    twakAllowed: boolean,
    r0: R0Evaluation,
  ): Promise<TradeResult> {
    const amountInBnb = parseFloat(decision.amountIn);
    const hardened = this.chpHardening.harden({
      token: decision.token,
      direction: decision.direction,
      amountInBnb,
      reasoning: decision.reasoning,
      sizingBasisBnb: this.riskManager.getDailyStartValue(),
      r0,
      guardrailsPassed: twakAllowed && riskAssessment.approved,
      guardrailDetail: `TWAK policy ${twakAllowed ? 'allowed' : 'blocked'}; risk assessment ${riskAssessment.approved ? 'approved' : 'refused'}; spend gate passed`,
      boundedResult:
        Number.isFinite(amountInBnb) &&
        amountInBnb > 0 &&
        amountInBnb <= portfolio.availableBNB + 1e-9,
      boundedDetail: `${amountInBnb} BNB vs available ${portfolio.availableBNB} BNB`,
      parity: this.parityEvidence(decision),
    });

    const { kase, assessment, r0Verdict, foundationVerdict } = hardened;

    // REQUIRE_HUMAN_LOCK (default ON): the trade parks as PROVISIONAL_LOCK
    // and only executes after a named confirmer locks it. A REFRAME trade
    // (foundation below the defi floor) takes the same path — it may only
    // proceed through the same human lock, never self-certify.
    if (this.chpHardening.requireHumanLock) {
      this.pendingTrades.set(kase.decisionId, {
        kase,
        decision,
        assessment,
        r0Verdict,
        foundationVerdict,
        amountInBnb,
      });
      logRiskWarning(
        `CHP human lock: ${decision.direction} ${decision.token} parked as PROVISIONAL_LOCK` +
          ` [decision ${kase.decisionId}, foundation ${assessment.score}/${this.chpHardening.domainFloor}]` +
          ' — confirm with confirmChpDecision to execute',
      );
      return this.noopResult(signal.token);
    }

    // Lock flag off: a REFRAME trade still cannot self-certify — refused
    // outright, mirroring the reference promotion gate.
    if (foundationVerdict !== 'PASS') {
      throw new ChpRejection(
        `CHP foundation: ${foundationVerdict} (score ${assessment.score}, ${assessment.domain} domain,` +
          ` floor ${this.chpHardening.domainFloor}) — the trade cannot self-certify; retry with a named confirmer`,
      );
    }

    // Foundation PASS with the lock flag off proceeds unlocked (status stays
    // PROVISIONAL_LOCK, confirmed_by null) and is recorded with its artifacts.
    const receipt = this.executionReceipt(
      'chp:auto-foundation-pass',
      decision,
      this.receiptRiskFor(foundationVerdict),
    );
    const result = await this.executeTrade(decision, receipt);
    this.chpHardening.record({
      kase,
      assessment,
      r0Verdict,
      foundationVerdict,
      token: decision.token,
      direction: decision.direction,
      amountInBnb,
      reasoning: decision.reasoning,
      artifacts: {
        txHash: result.txHash,
        success: result.success,
        mode: 'auto',
        receiptNonce: receipt.nonce,
        receiptActor: receipt.actor,
      },
      confirmedBy: null,
    });
    return result;
  }

  /**
   * Third-party confirmation of a parked trade: PROVISIONAL_LOCK -> LOCKED,
   * then the trade executes and the sealed record lands in the ledger.
   * Returns null when no pending trade matches the decision id.
   */
  async confirmTradeDecision(decisionId: string, confirmedBy: string): Promise<TradeResult | null> {
    const pending = this.pendingTrades.get(decisionId);
    if (!pending) return null;
    this.pendingTrades.delete(decisionId);

    const status = this.chpHardening.confirm(pending.kase, confirmedBy);
    const receipt = this.executionReceipt(
      confirmedBy,
      pending.decision,
      this.receiptRiskFor(pending.foundationVerdict),
    );
    const result = await this.executeTrade(pending.decision, receipt);
    this.chpHardening.record({
      kase: pending.kase,
      assessment: pending.assessment,
      r0Verdict: pending.r0Verdict,
      foundationVerdict: pending.foundationVerdict,
      token: pending.decision.token,
      direction: pending.decision.direction,
      amountInBnb: pending.amountInBnb,
      reasoning: pending.decision.reasoning,
      artifacts: {
        txHash: result.txHash,
        success: result.success,
        confirmedVia: 'confirmTradeDecision',
        receiptNonce: receipt.nonce,
        receiptActor: receipt.actor,
      },
      confirmedBy,
    });
    getLogger().info(
      `[CHP] ${status} ${pending.decision.token} confirmed by ${confirmedBy} [decision ${decisionId}]`,
    );
    return result;
  }

  /** Parked trades awaiting a named confirmer. */
  getPendingChpDecisions(): {
    decisionId: string;
    title: string;
    status: string;
    foundationScore: number;
  }[] {
    return Array.from(this.pendingTrades.values()).map((pending) => ({
      decisionId: pending.kase.decisionId,
      title: pending.kase.title,
      status: pending.kase.status,
      foundationScore: pending.kase.foundationScore,
    }));
  }

  /** Revalidated decision ledger entries, newest first. */
  getChpDecisions(limit?: number): RevalidatedLedgerEntry[] {
    return this.chpHardening.records.list(limit ?? 100);
  }

  getChpDecision(decisionId: string): RevalidatedLedgerEntry | null {
    return this.chpHardening.records.get(decisionId);
  }

  // ─── Trade Decision Creation ───────────────────────────────

  private createTradeDecision(signal: AggregatedSignal): TradeDecision | null {
    const portfolio = this.riskManager.getDailyStartValue();
    const amountIn = Math.min(
      portfolio * this.config.maxPositionPct,
      portfolio * 0.05, // Conservative default: 5% per trade
    );

    if (amountIn < 0.001) {
      getLogger().warn(`Insufficient portfolio value for trade (${amountIn} BNB)`);
      return null;
    }

    const direction: TradeDecision['direction'] = signal.consensusDirection;

    return {
      token: signal.token,
      direction,
      amountIn: amountIn.toFixed(4),
      amountOutMin: '0',
      slippageTolerance: this.config.slippageBps,
      deadline: Math.floor(Date.now() / 1000) + 300,
      reasoning: signal.signals.map(s => s.reasoning).join(' | '),
      signals: signal.signals,
      riskAssessment: {
        approved: true,
        positionSize: amountIn.toFixed(4),
        maxPositionPct: this.config.maxPositionPct,
        stopLossPct: this.config.stopLossPct,
        takeProfitPct: this.config.takeProfitPct,
        riskRewardRatio: this.config.takeProfitPct / this.config.stopLossPct,
        reasons: [],
        warnings: [],
        riskScore: signal.riskScore,
      },
    };
  }

  // ─── Execution Receipts (row 22: an allowlist is not authorization) ───

  /** The exact trade arguments a receipt binds — anything that changes what executes on-chain. */
  private tradeReceiptArgs(decision: TradeDecision): TradeReceiptArgs {
    return {
      token: decision.token,
      direction: decision.direction,
      amountIn: decision.amountIn,
      slippageTolerance: decision.slippageTolerance,
      deadline: decision.deadline,
    };
  }

  /** Map the CHP foundation verdict to the receipt's risk field. */
  private receiptRiskFor(verdict: ChpVerdict): ReceiptRisk {
    switch (verdict) {
      case 'PASS':
        return 'medium';
      case 'REFRAME':
        return 'high';
      default:
        return 'critical';
    }
  }

  /** Issue a signed, single-use receipt authorizing exactly this trade. */
  private executionReceipt(actor: string, decision: TradeDecision, risk: ReceiptRisk): TradeApprovalReceipt {
    return issueTradeReceipt(
      {
        actor,
        resource: `execute_trade:${decision.direction}:${decision.token}`,
        args_hash: hashTradeArgs(this.tradeReceiptArgs(decision)),
        policy_version: this.chpGate.getPolicy().version,
        risk,
        decision: 'allow',
        ttlMs: RECEIPT_TTL_MS,
      },
      this.receiptKey,
    );
  }

  // ─── Trade Execution ───────────────────────────────────────

  private async executeTrade(decision: TradeDecision, receipt?: TradeApprovalReceipt): Promise<TradeResult> {
    // Row 22 (an allowlist is not authorization): the CHP verdict SELECTS a
    // trade; a signed receipt AUTHORIZES this exact execution. Fail closed —
    // no receipt, tampered args, expired, wrong policy version, or replayed
    // nonce all refuse to move capital.
    const verification = verifyExecutionReceipt(
      receipt,
      {
        argsHash: hashTradeArgs(this.tradeReceiptArgs(decision)),
        policyVersion: this.chpGate.getPolicy().version,
        key: this.receiptKey,
      },
      this.receiptReplay,
    );
    if (!verification.ok) {
      logRiskWarning(
        `CHP execution receipt refused (${verification.reason})` +
          ` — trade NOT executed [${decision.direction} ${decision.token}]`,
      );
      return this.noopResult(decision.token);
    }
    getLogger().info(
      `[CHP] receipt ${verification.receipt.nonce} verified (actor ${verification.receipt.actor},` +
        ` risk ${verification.receipt.risk}, policy ${verification.receipt.policy_version})`,
    );

    if (this.config.dryRun) {
      getLogger().info(`[DRY RUN] Would execute trade: ${decision.direction} ${decision.amountIn} BNB → ${decision.token}`);
      const result: TradeResult = {
        success: true,
        txHash: `dry-run-${Date.now()}`,
        fromToken: 'BNB',
        toToken: decision.token,
        amountIn: decision.amountIn,
        amountOut: '0',
        gasUsed: '0',
        gasPrice: '0',
        blockNumber: 0,
        timestamp: Date.now(),
      };

      // Record in agent memory
      this.agentSDK.addTradeMemory({
        token: decision.token,
        action: decision.direction === 'LONG' ? 'BUY' : 'SELL',
        amount: parseFloat(decision.amountIn),
        price: 0,
        pnl: 0,
        signalScore: decision.signals.reduce((s, sig) => s + sig.score, 0) / decision.signals.length,
        reasoning: decision.reasoning,
        timestamp: Date.now(),
      });

      return result;
    }

    // Live execution
    if (decision.direction === 'LONG') {
      const result = await this.bscClient.swapBNBForToken(
        decision.token,
        parseFloat(decision.amountIn),
        decision.slippageTolerance,
      );

      if (result.success) {
        // Record position
        this.positions.set(decision.token, {
          token: decision.token,
          symbol: decision.token,
          amount: result.amountOut,
          entryPrice: parseFloat(result.amountOut) > 0
            ? parseFloat(decision.amountIn) / parseFloat(result.amountOut)
            : 0,
          currentPrice: 0,
          valueBNB: parseFloat(decision.amountIn),
          pnl: 0,
          pnlPct: 0,
          openedAt: Date.now(),
          stopLoss: this.config.stopLossPct,
          takeProfit: this.config.takeProfitPct,
        });

        // Record in agent memory
        this.agentSDK.addTradeMemory({
          token: decision.token,
          action: 'BUY',
          amount: parseFloat(decision.amountIn),
          price: 0,
          pnl: 0,
          signalScore: decision.signals.reduce((s, sig) => s + sig.score, 0) / decision.signals.length,
          reasoning: decision.reasoning,
          timestamp: Date.now(),
        });
      }

      return result;
    }

    // SHORT direction = sell existing position
    const position = this.positions.get(decision.token);
    if (position) {
      const result = await this.bscClient.swapTokenForBNB(
        decision.token,
        parseFloat(position.amount),
        decision.slippageTolerance,
      );

      if (result.success) {
        this.positions.delete(decision.token);

        this.agentSDK.addTradeMemory({
          token: decision.token,
          action: 'SELL',
          amount: parseFloat(decision.amountIn),
          price: parseFloat(result.amountOut) / parseFloat(position.amount),
          pnl: parseFloat(result.amountOut) - parseFloat(decision.amountIn),
          signalScore: decision.signals.reduce((s, sig) => s + sig.score, 0) / decision.signals.length,
          reasoning: decision.reasoning,
          timestamp: Date.now(),
        });
      }

      return result;
    }

    return this.noopResult(decision.token);
  }

  // ─── Position Management ──────────────────────────────────

  async checkExistingPositions(): Promise<void> {
    for (const [token, position] of this.positions) {
      // Update current price
      try {
        const currentPrice = await this.bscClient.getPriceBNB(token);
        position.currentPrice = currentPrice;

        if (currentPrice > 0 && position.entryPrice > 0) {
          position.pnlPct = (currentPrice - position.entryPrice) / position.entryPrice;
          position.valueBNB = position.valueBNB * (1 + position.pnlPct);
          position.pnl = position.valueBNB * position.pnlPct;
        }
      } catch {
        getLogger().debug(`Could not update price for ${token}`);
      }

      // Check stop-loss / take-profit
      const evaluation = this.riskManager.evaluatePositionExit(position);
      if (evaluation.shouldExit) {
        getLogger().info(`🛑 Exiting ${token}: ${evaluation.reason}`);
        const exitResult = await this.bscClient.swapTokenForBNB(
          token,
          parseFloat(position.amount),
          this.config.slippageBps,
          this.config.dryRun,
        );
        // Only drop the position if the exit swap actually succeeded. A failed
        // exit must NOT delete the position, otherwise the agent believes it has
        // exited while still holding the token on-chain (ghost position).
        if (exitResult.success) {
          this.positions.delete(token);
        } else {
          logRiskWarning(
            `Stop-loss/take-profit exit for ${token} FAILED — position retained for retry: ${exitResult.error ?? 'unknown error'}`,
          );
        }
      }
    }
  }

  // ─── Portfolio State ───────────────────────────────────────

  async getPortfolioState(): Promise<PortfolioState> {
    const balanceBNB = await this.bscClient.getBNBBalance();

    const positions = Array.from(this.positions.values());
    const positionsValue = positions.reduce((sum, pos) => sum + pos.valueBNB, 0);
    const totalValue = balanceBNB + positionsValue;
    const unrealizedPnL = positions.reduce((sum, pos) => sum + pos.pnl, 0);

    const state: PortfolioState = {
      totalValueBNB: totalValue,
      availableBNB: balanceBNB,
      positions,
      dailyPnL: 0,
      dailyPnLPct: 0,
      maxDrawdown: 0,
      unrealizedPnL,
    };

    return this.riskManager.updatePortfolio(state);
  }

  // ─── Helpers ───────────────────────────────────────────────

  private noopResult(token: string): TradeResult {
    return {
      success: true,
      txHash: '',
      fromToken: 'BNB',
      toToken: token,
      amountIn: '0',
      amountOut: '0',
      gasUsed: '0',
      gasPrice: '0',
      blockNumber: 0,
      timestamp: Date.now(),
    };
  }

  getPositionCount(): number {
    return this.positions.size;
  }

  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }
}
