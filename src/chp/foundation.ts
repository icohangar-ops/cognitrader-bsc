// ============================================================
// CogniTrader BSC — CHP deterministic adversary (foundation pass)
// Port of chp.foundation (consensus-hardening-protocol 0.1.1):
// 40 guardrails + 30 bounded result + 30 parity, gated against a
// domain floor. Domain floors are the normative spec §5.3 map —
// this repo's domain is `defi` (floor 85), so only a parity-
// verified trade can self-certify; a plain guardrail+bounded
// trade scores 70 and cannot.
//
// Divergence from the erp-control-plane reference, documented per
// the rollout brief: the reference pins parity to a dbt-pinned
// golden set (golden_qa.yaml). This repo has no golden artifact
// for trades — parity is asserted against recomputed portfolio /
// market state instead (the decision's size must re-derive from
// the same sizing basis the portfolio state implies). State
// assertions serve in place of a golden set.
// ============================================================

/** Domain foundation-score floors (spec §5.3), ported verbatim. */
export const FOUNDATION_FLOORS: Readonly<Record<string, number>> = {
  general: 70,
  ai: 70,
  agents: 70,
  blockchain: 85,
  defi: 85,
  finance: 100,
  cfo: 100,
  capital_allocation: 100,
  board_decision: 100,
};

export const DEFAULT_FOUNDATION_FLOOR = 70;

/**
 * Resolve the foundation-score floor for a domain. Case-insensitive exact
 * match; unknown domains fall back to the general floor rather than failing
 * open at 0 or closed at 100.
 */
export function foundationFloor(domain?: string | null): number {
  const key = (domain ?? '').trim().toLowerCase();
  return FOUNDATION_FLOORS[key] ?? DEFAULT_FOUNDATION_FLOOR;
}

// Deterministic adversary scoring (out of 100).
export const GUARDRAIL_POINTS = 40;
export const BOUNDED_RESULT_POINTS = 30;
export const PARITY_POINTS = 30;
export const FULL_SCORE = GUARDRAIL_POINTS + BOUNDED_RESULT_POINTS + PARITY_POINTS;

export interface ParityEvidence {
  /** Which state assertion produced the comparison. */
  caseId: string;
  metric: string;
  unit: string;
  expected: number;
  tolerance: number;
  /** null = the result is not a single comparable scalar. */
  actual: number | null;
  withinTolerance: boolean | null;
}

export interface TradeFoundationInput {
  guardrailsPassed: boolean;
  guardrailDetail: string;
  boundedResult: boolean;
  boundedDetail: string;
  parity: ParityEvidence | null;
}

export interface FoundationAssessment {
  score: number;
  domain: string;
  findings: string[];
  parity: ParityEvidence | null;
  /** A state assertion matched and held (golden-match analog). */
  stateMatched: boolean;
}

export function assessTradeFoundation(input: TradeFoundationInput): FoundationAssessment {
  const findings: string[] = [];
  let score = 0;

  if (input.guardrailsPassed) {
    score += GUARDRAIL_POINTS;
    findings.push(`guardrails passed: ${input.guardrailDetail}`);
  } else {
    findings.push(`guardrails failed: ${input.guardrailDetail}`);
  }

  if (input.boundedResult) {
    score += BOUNDED_RESULT_POINTS;
    findings.push(`bounded result: ${input.boundedDetail}`);
  } else {
    findings.push(`${input.boundedDetail} — no bounded-execution evidence`);
  }

  const parity = input.parity;
  if (parity === null) {
    findings.push(
      'no portfolio/market state assertion matched this decision — parity evidence unavailable',
    );
  } else if (parity.actual === null || parity.withinTolerance === null) {
    findings.push(
      'state assertion matched but the result is not a single comparable scalar' +
        ' — parity evidence unavailable',
    );
  } else if (parity.withinTolerance) {
    score += PARITY_POINTS;
    findings.push(
      `state parity: ${parity.caseId} (${parity.metric}) expected` +
        ` ${parity.expected} ± ${parity.tolerance} ${parity.unit}, got ${parity.actual}`,
    );
  } else {
    findings.push(
      `state parity MISMATCH: ${parity.caseId} (${parity.metric}) expected` +
        ` ${parity.expected} ± ${parity.tolerance} ${parity.unit}, got ${parity.actual}`,
    );
  }

  return {
    score: Math.min(score, FULL_SCORE),
    domain: 'defi',
    findings,
    parity,
    stateMatched: parity !== null && parity.withinTolerance === true,
  };
}
