// ============================================================
// CogniTrader BSC — CHP Risk Policy loader
// Mirrors the donor `cm-policy` / `sfe-policy` YAML policy engine:
// load a flat policy YAML, fall back to a conservative default if
// the file is missing or unparseable. No external YAML dependency —
// the policy schema is flat (scalars + simple string/number maps and
// lists), so a tiny purpose-built parser keeps the change additive.
// ============================================================

import fs from 'fs';
import path from 'path';
import { getLogger } from '../utils/logger';

export type ChpAction = 'LONG' | 'SHORT' | 'HOLD';

export interface RiskPolicy {
  version: string;
  /** Hard ceiling per single trade (USD). Above => BLOCK. */
  maxNotionalUsd: number;
  /** Rolling daily cumulative notional cap (USD). */
  dailyNotionalCapUsd: number;
  /** HITL threshold (USD). At/above => human approval required. */
  hitlThresholdUsd: number;
  /** Actions the agent may take at all. */
  allowedActions: ChpAction[];
  /** Per-asset notional caps (USD). */
  perAssetLimits: Record<string, number>;
  /** Minimum aggregated signal confidence (0..1). */
  minConfidence: number;
}

/** Conservative built-in fallback used when policy.yaml is absent. */
export function defaultPolicy(): RiskPolicy {
  return {
    version: '1.0-default',
    maxNotionalUsd: 1000.0,
    dailyNotionalCapUsd: 5000.0,
    hitlThresholdUsd: 250.0,
    allowedActions: ['LONG', 'SHORT'],
    perAssetLimits: {},
    minConfidence: 0.6,
  };
}

/** Default location of the policy file (repo root). */
export function defaultPolicyPath(): string {
  return path.resolve(process.cwd(), 'policy.yaml');
}

/**
 * Load a risk policy from a flat YAML file. Returns a conservative
 * default (and logs a warning) if the file is missing or cannot be
 * parsed — the gate is intentionally non-breaking.
 */
export function loadPolicy(policyPath: string = defaultPolicyPath()): RiskPolicy {
  if (!fs.existsSync(policyPath)) {
    getLogger().warn(
      `[CHP] policy file not found at ${policyPath} — using conservative default policy`,
    );
    return defaultPolicy();
  }
  try {
    const raw = fs.readFileSync(policyPath, 'utf8');
    const parsed = parseFlatYaml(raw);
    return coercePolicy(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn(`[CHP] failed to parse policy ${policyPath} (${msg}) — using default policy`);
    return defaultPolicy();
  }
}

// ─── Minimal flat-YAML parser ───────────────────────────────
// Supports: `key: value` scalars, top-level `key:` followed by an
// indented `- item` list, and top-level `key:` followed by indented
// `subkey: value` maps. Comments (`#`) and blank lines are ignored.
// This covers the policy schema exactly; anything richer is out of
// scope and would fall through to the default policy.
type YamlValue = string | number | boolean | string[] | Record<string, number>;

function parseFlatYaml(text: string): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = stripComment(lines[i]);
    if (line.trim() === '') { i++; continue; }
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!m) { i++; continue; }
    const key = m[1];
    const inline = m[2].trim();
    if (inline !== '') {
      out[key] = parseScalar(inline);
      i++;
      continue;
    }
    // Block: collect indented children.
    const children: string[] = [];
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j])) {
      children.push(stripComment(lines[j]));
      j++;
    }
    const list: string[] = [];
    const map: Record<string, number> = {};
    for (const c of children) {
      const t = c.trim();
      if (t === '') continue;
      if (t.startsWith('- ')) {
        list.push(stripQuotes(t.slice(2).trim()));
      } else {
        const cm = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(t);
        if (cm) map[cm[1]] = Number(cm[2].trim());
      }
    }
    if (list.length > 0) out[key] = list;
    else out[key] = map;
    i = j;
  }
  return out;
}

function stripComment(line: string): string {
  // Only strip `#` that is not inside quotes (policy has no quoted #).
  const idx = line.indexOf('#');
  return idx === -1 ? line : line.slice(0, idx);
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

function parseScalar(s: string): string | number | boolean {
  const v = stripQuotes(s);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

function coercePolicy(p: Record<string, YamlValue>): RiskPolicy {
  const d = defaultPolicy();
  const num = (k: string, fallback: number): number =>
    typeof p[k] === 'number' ? (p[k] as number) : fallback;
  const actions = Array.isArray(p['allowed_actions'])
    ? (p['allowed_actions'] as string[]).map((a) => a.toUpperCase() as ChpAction)
    : d.allowedActions;
  const perAsset = (p['per_asset_limits'] && !Array.isArray(p['per_asset_limits']))
    ? (p['per_asset_limits'] as Record<string, number>)
    : {};
  return {
    version: typeof p['version'] === 'string' ? (p['version'] as string) : d.version,
    maxNotionalUsd: num('max_notional_usd', d.maxNotionalUsd),
    dailyNotionalCapUsd: num('daily_notional_cap_usd', d.dailyNotionalCapUsd),
    hitlThresholdUsd: num('hitl_threshold_usd', d.hitlThresholdUsd),
    allowedActions: actions,
    perAssetLimits: perAsset,
    minConfidence: num('min_confidence', d.minConfidence),
  };
}
