// ============================================================
// CogniTrader BSC — CHP Decision Gate
// Port of the CleanMandate / SwarmFi-Executor CHP gate:
//   - loads a risk policy (policy.yaml, conservative default fallback)
//   - drives a proposed action through decision states
//       EXPLORING -> PROVISIONAL -> LOCKED (or BLOCKED / HITL_REQUIRED)
//   - runs a lightweight adversarial / sanity check
//   - records per-decision provenance (an append-only in-memory ledger)
//   - BLOCKS or requires HITL approval when notional exceeds a threshold
//
// Capital-moving actions must pass gate.evaluate(action) before submission.
// ============================================================

import crypto from 'crypto';
import { getLogger } from '../utils/logger';
import { loadPolicy, defaultPolicyPath, type RiskPolicy, type ChpAction } from './policy';

export type { ChpAction } from './policy';

/** Lifecycle states a proposed action moves through. */
export type ChpState =
  | 'EXPLORING' // received, not yet checked
  | 'PROVISIONAL' // passed policy + sanity, pending final lock/HITL
  | 'LOCKED' // approved for execution
  | 'HITL_REQUIRED' // blocked pending human approval
  | 'BLOCKED'; // rejected outright

/** A capital-moving action proposed to the gate. */
export interface ProposedAction {
  /** LONG / SHORT / HOLD etc. */
  action: ChpAction;
  /** Asset / token symbol (e.g. "CAKE"). */
  asset: string;
  /** Notional value of the trade in USD. */
  notionalUsd: number;
  /** Aggregated signal confidence 0..1 (adversarial input). */
  confidence?: number;
  /** Free-form rationale carried into provenance. */
  rationale?: string;
}

export interface Provenance {
  decisionId: string;
  timestamp: string;
  action: ProposedAction;
  state: ChpState;
  contentHash: string;
  /** Per-claim checks that were run and their pass/fail result. */
  claims: { rule: string; passed: boolean; detail: string }[];
}

export interface ChpDecision {
  allowed: boolean;
  requiresHuman: boolean;
  state: ChpState;
  reason: string;
  provenance: Provenance;
}

export class ChpGate {
  private policy: RiskPolicy;
  private ledger: Provenance[] = [];
  private dailyNotionalUsd = 0;
  private dailyWindowStart = Date.now();

  constructor(policy?: RiskPolicy, policyPath: string = defaultPolicyPath()) {
    this.policy = policy ?? loadPolicy(policyPath);
    getLogger().info(
      `[CHP] gate active — policy v${this.policy.version}, ` +
        `max $${this.policy.maxNotionalUsd}, HITL >= $${this.policy.hitlThresholdUsd}, ` +
        `daily cap $${this.policy.dailyNotionalCapUsd}`,
    );
  }

  getPolicy(): RiskPolicy {
    return this.policy;
  }

  /** Append-only provenance ledger (per-decision records). */
  getLedger(): readonly Provenance[] {
    return this.ledger;
  }

  /**
   * Evaluate a proposed capital-moving action.
   *
   * States: EXPLORING (received) -> run policy + adversarial checks.
   *   - any hard violation                => BLOCKED  (allowed=false)
   *   - notional >= hitl_threshold        => HITL_REQUIRED (allowed=false, requiresHuman)
   *   - otherwise                         => PROVISIONAL -> LOCKED (allowed=true)
   */
  evaluate(proposed: ProposedAction): ChpDecision {
    const claims: Provenance['claims'] = [];
    let state: ChpState = 'EXPLORING';

    const add = (rule: string, passed: boolean, detail: string) =>
      claims.push({ rule, passed, detail });

    // ── Policy checks (hard blocks) ──────────────────────────
    const actionAllowed = this.policy.allowedActions.includes(proposed.action);
    add('allowed-action', actionAllowed, `action ${proposed.action}`);

    const assetCap = this.policy.perAssetLimits[proposed.asset];
    const effectiveCap = assetCap ?? this.policy.maxNotionalUsd;
    const underAssetCap = proposed.notionalUsd <= effectiveCap;
    add(
      'per-asset-cap',
      underAssetCap,
      `${proposed.asset} notional $${proposed.notionalUsd} vs cap $${effectiveCap}`,
    );

    const underMax = proposed.notionalUsd <= this.policy.maxNotionalUsd;
    add('max-notional', underMax, `$${proposed.notionalUsd} vs max $${this.policy.maxNotionalUsd}`);

    this.rollDailyWindow();
    const projectedDaily = this.dailyNotionalUsd + proposed.notionalUsd;
    const underDaily = projectedDaily <= this.policy.dailyNotionalCapUsd;
    add(
      'daily-cap',
      underDaily,
      `projected $${projectedDaily} vs daily cap $${this.policy.dailyNotionalCapUsd}`,
    );

    // ── Adversarial / sanity check ───────────────────────────
    const sane = this.adversarialCheck(proposed, add);

    const hardOk = actionAllowed && underAssetCap && underMax && underDaily && sane;

    if (!hardOk) {
      state = 'BLOCKED';
      const failed = claims.filter((c) => !c.passed).map((c) => c.rule);
      const decision = this.finalize(proposed, state, claims, false, false, `blocked: ${failed.join(', ')}`);
      getLogger().warn(`[CHP] BLOCKED ${proposed.asset} ${proposed.action} $${proposed.notionalUsd} (${failed.join(', ')})`);
      return decision;
    }

    // Passed all hard checks -> PROVISIONAL.
    state = 'PROVISIONAL';

    // ── HITL threshold ───────────────────────────────────────
    const requiresHuman = proposed.notionalUsd >= this.policy.hitlThresholdUsd;
    if (requiresHuman) {
      state = 'HITL_REQUIRED';
      const decision = this.finalize(
        proposed,
        state,
        claims,
        false,
        true,
        `human approval required: $${proposed.notionalUsd} >= HITL threshold $${this.policy.hitlThresholdUsd}`,
      );
      getLogger().warn(`[CHP] HITL_REQUIRED ${proposed.asset} ${proposed.action} $${proposed.notionalUsd}`);
      return decision;
    }

    // Auto-approve -> LOCKED and count against the daily cap.
    state = 'LOCKED';
    this.dailyNotionalUsd = projectedDaily;
    const decision = this.finalize(proposed, state, claims, true, false, 'auto-approved under CHP thresholds');
    getLogger().info(`[CHP] LOCKED ${proposed.asset} ${proposed.action} $${proposed.notionalUsd}`);
    return decision;
  }

  /**
   * Register an explicit human approval for a HITL-gated action,
   * promoting it to LOCKED. Mirrors the donor `principal_approve`.
   */
  approveHuman(proposed: ProposedAction, approver: string): ChpDecision {
    this.rollDailyWindow();
    const projectedDaily = this.dailyNotionalUsd + proposed.notionalUsd;
    if (projectedDaily > this.policy.dailyNotionalCapUsd || proposed.notionalUsd > this.policy.maxNotionalUsd) {
      const decision = this.finalize(
        proposed,
        'BLOCKED',
        [{ rule: 'post-approval-recheck', passed: false, detail: 'exceeds hard caps even with approval' }],
        false,
        false,
        'human approval rejected: exceeds hard caps',
      );
      return decision;
    }
    this.dailyNotionalUsd = projectedDaily;
    getLogger().info(`[CHP] human-approved by ${approver}: ${proposed.asset} $${proposed.notionalUsd} -> LOCKED`);
    return this.finalize(
      proposed,
      'LOCKED',
      [{ rule: 'human-approval', passed: true, detail: `approved by ${approver}` }],
      true,
      false,
      `human-approved by ${approver}`,
    );
  }

  // ── Internals ──────────────────────────────────────────────

  private adversarialCheck(
    proposed: ProposedAction,
    add: (rule: string, passed: boolean, detail: string) => void,
  ): boolean {
    let ok = true;

    // Sanity: notional must be a positive finite number.
    const finitePositive = Number.isFinite(proposed.notionalUsd) && proposed.notionalUsd > 0;
    add('sane-notional', finitePositive, `notional=${proposed.notionalUsd}`);
    if (!finitePositive) ok = false;

    // Adversarial: reject low-confidence signals (a "what if this is noise?" check).
    if (proposed.confidence !== undefined) {
      const confidentEnough = proposed.confidence >= this.policy.minConfidence;
      add(
        'min-confidence',
        confidentEnough,
        `confidence ${proposed.confidence} vs min ${this.policy.minConfidence}`,
      );
      if (!confidentEnough) ok = false;
    }

    // Sanity: HOLD is never a capital-moving action and should not reach the gate.
    const notHold = proposed.action !== 'HOLD';
    add('non-hold', notHold, `action ${proposed.action}`);
    if (!notHold) ok = false;

    return ok;
  }

  private rollDailyWindow(): void {
    const DAY_MS = 24 * 60 * 60 * 1000;
    if (Date.now() - this.dailyWindowStart >= DAY_MS) {
      this.dailyWindowStart = Date.now();
      this.dailyNotionalUsd = 0;
    }
  }

  private finalize(
    action: ProposedAction,
    state: ChpState,
    claims: Provenance['claims'],
    allowed: boolean,
    requiresHuman: boolean,
    reason: string,
  ): ChpDecision {
    const timestamp = new Date().toISOString();
    const canonical = JSON.stringify({ action, state, claims, timestamp });
    const contentHash = crypto.createHash('sha256').update(canonical).digest('hex');
    const provenance: Provenance = {
      decisionId: crypto.randomUUID(),
      timestamp,
      action,
      state,
      contentHash,
      claims,
    };
    this.ledger.push(provenance);
    return { allowed, requiresHuman, state, reason, provenance };
  }
}
