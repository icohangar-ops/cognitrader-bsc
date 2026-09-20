// ============================================================
// CogniTrader BSC — CHP R0 gate (port of chp.gates,
// consensus-hardening-protocol 0.1.1)
// Runs BEFORE the trading engine: a trade decision must be
// solvable from the current portfolio state, scoped to a bounded
// execution window, valid against a real backing, and worth it
// (metric-bearing signal). Any FATAL result HALTs the decision
// before any guardrail, risk, or execution machinery runs.
// ============================================================

export type ChpVerdict = 'PASS' | 'HALT' | 'REFRAME';

/** Per-criterion R0 result. Failures are FATAL, never warnings. */
export type R0Result = 'PASS' | 'FATAL';

export interface R0Criteria {
  /** A trade is constructible from the current portfolio state. */
  solvable: boolean;
  /** Execution is bounded: sane slippage and a live deadline. */
  scoped: boolean;
  /** Well-formed backing: base-asset LONG, or an existing position to sell. */
  valid: boolean;
  /** Metric-bearing signal above the agent's own thresholds. */
  worth_it: boolean;
}

export interface R0Evaluation {
  /** Keys are capitalized exactly as the CHP spec; failures are FATAL. */
  results: {
    Solvable: R0Result;
    Scoped: R0Result;
    Valid: R0Result;
    Worth_it: R0Result;
  };
  verdict: ChpVerdict;
}

export function evaluateR0Gate(criteria: R0Criteria): R0Evaluation {
  const results: R0Evaluation['results'] = {
    Solvable: criteria.solvable ? 'PASS' : 'FATAL',
    Scoped: criteria.scoped ? 'PASS' : 'FATAL',
    Valid: criteria.valid ? 'PASS' : 'FATAL',
    Worth_it: criteria.worth_it ? 'PASS' : 'FATAL',
  };
  const verdict: ChpVerdict = Object.values(results).every((v) => v === 'PASS')
    ? 'PASS'
    : 'HALT';
  return { results, verdict };
}

/** Criteria that failed R0, sorted, for the audit trail. */
export function failedR0Criteria(evaluation: R0Evaluation): string[] {
  const results = evaluation.results;
  return (Object.keys(results) as (keyof R0Evaluation['results'])[])
    .filter((key) => results[key] !== 'PASS')
    .sort();
}
