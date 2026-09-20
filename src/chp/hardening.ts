// ============================================================
// CogniTrader BSC — CHP trade hardening gate
// Port of the ChpPromotionGate shape (erp-control-plane
// api/genbi/chp.py, consensus-hardening-protocol 0.1.1 Profile A).
// Every trade decision becomes a CHP decision case so the question
// "why did the agent trade?" has a mechanical answer. Four stages:
//
// 1. R0 gate — before the engine: the trade is solvable from the
//    current portfolio state, scoped (bounded slippage + live
//    deadline), valid (real backing: base-asset LONG or an existing
//    position to sell), and worth_it (metric-bearing signal above
//    the agent's own thresholds). HALT refuses the trade with
//    nothing executed or persisted (audited as chp_rejected).
// 2. Foundation pass — the deterministic adversary scores the
//    guarded trade: 40 guardrails + 30 bounded result + 30 state
//    parity. The `defi` domain gates at 85; a score below the
//    floor cannot self-certify. A parity MISMATCH is fatal — a
//    trade contradicting recomputed portfolio state must not be
//    executed, and no confirmer can wave it through.
// 3. Human lock — every hardened case opens PROVISIONAL_LOCK; a
//    named confirmer (confirmed_by) locks it through third-party
//    validation. CHP_REQUIRE_HUMAN_LOCK (default ON) makes that
//    confirmation mandatory for every trade.
// 4. Decision record — the case, verdicts, parity evidence, and
//    execution artifacts are sealed into a CHP payload envelope
//    and appended to the decision ledger.
// ============================================================

import path from 'path';
import crypto from 'crypto';
import {
  failedR0Criteria,
  evaluateR0Gate,
  type ChpVerdict,
  type R0Criteria,
  type R0Evaluation,
} from './r0';
import { buildPayloadEnvelope, renderEnvelope } from './envelope';
import { canonicalJson } from './canonical';
import {
  assessTradeFoundation,
  foundationFloor,
  type FoundationAssessment,
  type ParityEvidence,
  type TradeFoundationInput,
} from './foundation';
import {
  DecisionLedger,
  bodySha256,
  type RevalidatedLedgerEntry,
} from './ledger';

/** Port of chp.models.SessionStatus. */
export type SessionStatus =
  | 'EXPLORING'
  | 'PROVISIONAL'
  | 'PROVISIONAL_LOCK'
  | 'LOCKED'
  | 'CONVERGED'
  | 'UNRESOLVED'
  | 'REQUIRES_HUMAN_VERIFICATION'
  | 'REFRAME_REQUIRED'
  | 'HALT';

export interface ChpHardeningSettings {
  /** CHP_REQUIRE_HUMAN_LOCK — every trade needs a named confirmer. Default ON. */
  requireHumanLock: boolean;
  /** CHP_LEDGER_PATH — append-only decision ledger (JSONL). */
  ledgerPath: string;
  /** Foundation domain for floor resolution; trading is `defi` (floor 85). */
  domain: string;
}

/** Environment-driven settings; the human lock defaults ON (fail closed). */
export function chpSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): ChpHardeningSettings {
  const raw = (env['CHP_REQUIRE_HUMAN_LOCK'] ?? '').trim().toLowerCase();
  return {
    requireHumanLock: !(raw === '0' || raw === 'false' || raw === 'off'),
    ledgerPath:
      env['CHP_LEDGER_PATH']?.trim() ||
      path.resolve(process.cwd(), 'state', 'chp-decisions.jsonl'),
    domain: 'defi',
  };
}

/** CHP refused the trade (R0 HALT, foundation REFRAME, or lock required). */
export class ChpRejection extends Error {
  readonly reason: string;
  readonly evaluation: R0Evaluation | null;

  constructor(reason: string, evaluation?: R0Evaluation) {
    super(reason);
    this.name = 'ChpRejection';
    this.reason = reason;
    this.evaluation = evaluation ?? null;
  }
}

export interface DecisionCase {
  decisionId: string;
  title: string;
  domain: string;
  createdAt: string;
  /** Sessions start EXPLORING; hardening opens PROVISIONAL_LOCK. */
  status: SessionStatus;
  foundationScore: number;
  lockedDecisions: string[];
}

export interface ThirdPartyValidation {
  validator: string;
  item: string;
  challenge: string;
  result: 'CONFIRM' | 'REJECT';
  rationale: string;
}

/**
 * Port of chp.protocol.apply_third_party_validation: a named third-party
 * CONFIRM locks the case; REJECT sends it back for human verification.
 */
export function applyThirdPartyValidation(
  kase: DecisionCase,
  validation: ThirdPartyValidation,
): SessionStatus {
  if (!validation.validator.trim()) {
    throw new ChpRejection('third-party validation requires a named validator');
  }
  if (validation.result === 'CONFIRM') {
    kase.lockedDecisions.push(`${validation.validator}:${validation.item}`);
    kase.status = 'LOCKED';
  } else {
    kase.status = 'REQUIRES_HUMAN_VERIFICATION';
  }
  return kase.status;
}

export interface HardenTradeInput extends TradeFoundationInput {
  token: string;
  direction: string;
  amountInBnb: number;
  reasoning: string;
  sizingBasisBnb: number;
  r0: R0Evaluation;
}

export interface HardenedTrade {
  kase: DecisionCase;
  assessment: FoundationAssessment;
  r0Verdict: ChpVerdict;
  foundationVerdict: ChpVerdict;
}

export interface RecordTradeInput {
  kase: DecisionCase;
  assessment: FoundationAssessment;
  r0Verdict: ChpVerdict;
  foundationVerdict: ChpVerdict;
  token: string;
  direction: string;
  amountInBnb: number;
  reasoning: string;
  artifacts: Record<string, unknown>;
  confirmedBy: string | null;
}

export class ChpTradeGate {
  readonly records: DecisionLedger;
  private readonly settings: ChpHardeningSettings;

  constructor(settings?: Partial<ChpHardeningSettings>, ledger?: DecisionLedger) {
    this.settings = { ...chpSettingsFromEnv(), ...settings };
    this.records = ledger ?? new DecisionLedger(this.settings.ledgerPath);
  }

  get requireHumanLock(): boolean {
    return this.settings.requireHumanLock;
  }

  get domainFloor(): number {
    return foundationFloor(this.settings.domain);
  }

  /**
   * R0 — before the engine. Throws ChpRejection on HALT (failures are
   * FATAL, never warnings).
   */
  openR0(criteria: R0Criteria): R0Evaluation {
    const evaluation = evaluateR0Gate(criteria);
    if (evaluation.verdict !== 'PASS') {
      const failed = failedR0Criteria(evaluation);
      throw new ChpRejection(
        `CHP R0 gate: the trade decision failed ${failed.join(', ')}`,
        evaluation,
      );
    }
    return evaluation;
  }

  /** The deterministic adversary scores the guarded trade (0-100). */
  assessFoundation(input: TradeFoundationInput): FoundationAssessment {
    return assessTradeFoundation(input);
  }

  /**
   * Foundation pass + open the case. The case starts EXPLORING and opens
   * as PROVISIONAL_LOCK; a REFRAME verdict keeps that status too — the
   * trade may only proceed through the same human lock, never self-certify.
   */
  harden(input: HardenTradeInput): HardenedTrade {
    if (input.r0.verdict !== 'PASS') {
      throw new ChpRejection(
        'CHP foundation: R0 must pass before the foundation pass',
        input.r0,
      );
    }
    const assessment = this.assessFoundation(input);
    if (assessment.parity && assessment.parity.withinTolerance === false) {
      throw new ChpRejection(
        `CHP foundation: ${assessment.findings[assessment.findings.length - 1]}` +
          ' — a trade contradicting recomputed portfolio state must not be executed;' +
          ' fix the sizing or refresh the portfolio snapshot.',
      );
    }

    const kase: DecisionCase = {
      decisionId: `trade-${crypto
        .createHash('sha256')
        .update(
          `${input.token}|${input.direction}|${input.amountInBnb}|${Date.now()}`,
        )
        .digest('hex')
        .slice(0, 16)}`,
      title: `${input.direction} ${input.token}`,
      domain: this.settings.domain,
      createdAt: new Date().toISOString(),
      status: 'EXPLORING',
      foundationScore: assessment.score,
      lockedDecisions: [],
    };
    // The gate collapses CHP's multi-round session flow into one execution
    // step: every hardened trade opens as a provisional decision pending
    // human confirmation (apply_third_party_validation then locks it).
    kase.status = 'PROVISIONAL_LOCK';

    const foundationVerdict: ChpVerdict =
      assessment.score >= this.domainFloor ? 'PASS' : 'REFRAME';
    return { kase, assessment, r0Verdict: input.r0.verdict, foundationVerdict };
  }

  /** Third-party confirmation: PROVISIONAL_LOCK -> LOCKED. */
  confirm(kase: DecisionCase, confirmedBy: string): SessionStatus {
    return applyThirdPartyValidation(kase, {
      validator: confirmedBy,
      item: kase.decisionId,
      challenge: 'Confirm the trade decision matches the guarded portfolio state',
      result: 'CONFIRM',
      rationale: 'Named confirmer approved the trade via the CogniTrader CHP gate',
    });
  }

  /** Seal the decision into a CHP payload envelope and append the ledger. */
  record(input: RecordTradeInput): RevalidatedLedgerEntry {
    const body = canonicalJson({
      decision_id: input.kase.decisionId,
      title: input.kase.title,
      domain: input.kase.domain,
      token: input.token,
      direction: input.direction,
      amount_in_bnb: input.amountInBnb,
      reasoning: input.reasoning,
      r0_verdict: input.r0Verdict,
      foundation_verdict: input.foundationVerdict,
      foundation_score: input.kase.foundationScore,
      adversary_findings: input.assessment.findings,
      parity: input.assessment.parity,
      artifacts: input.artifacts,
      locked_decisions: [...input.kase.lockedDecisions],
    });
    const envelope = renderEnvelope(buildPayloadEnvelope(body, 'TRADE'));
    this.records.append({
      decision_id: input.kase.decisionId,
      created_at: input.kase.createdAt,
      domain: input.kase.domain,
      session_status: input.kase.status,
      r0_verdict: input.r0Verdict,
      foundation_verdict: input.foundationVerdict,
      foundation_score: input.kase.foundationScore,
      confirmed_by: input.confirmedBy,
      artifacts: input.artifacts,
      body,
      body_sha256: bodySha256(body),
      envelope,
    });
    return this.records.get(input.kase.decisionId) as RevalidatedLedgerEntry;
  }
}

export type { ParityEvidence };

// Facade re-exports: consumers import the protocol types from hardening.
export type { ChpVerdict, R0Criteria, R0Evaluation } from './r0';
export type { FoundationAssessment, TradeFoundationInput } from './foundation';
export type { LedgerEntry, RevalidatedLedgerEntry } from './ledger';
