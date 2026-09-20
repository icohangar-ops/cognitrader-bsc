// ============================================================
// CogniTrader BSC — CHP decision ledger (port of the reference
// DecisionLedger in erp-control-plane api/genbi/chp.py)
// Append-only JSONL of CHP decision records. The CHP payload
// envelope validates structure only, so the ledger adds its own
// SHA-256 digest over the sealed body — reads re-validate both,
// and a tampered record reads as integrity_valid: false.
//
// Ledger field names are snake_case deliberately: the ledger is a
// cross-repo protocol artifact shared with the Python reference
// (erp-control-plane), so its shape matches there exactly.
// ============================================================

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { validatePayloadEnvelope } from './envelope';

export interface LedgerEntry {
  decision_id: string;
  created_at: string;
  domain: string;
  session_status: string;
  r0_verdict: string;
  foundation_verdict: string;
  foundation_score: number;
  confirmed_by: string | null;
  artifacts: Record<string, unknown>;
  /** Canonical-JSON sealed body — the digest input. */
  body: string;
  body_sha256: string;
  envelope: string;
}

export interface RevalidatedLedgerEntry extends LedgerEntry {
  envelope_valid: boolean;
  integrity_valid: boolean;
}

export function bodySha256(body: string): string {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

export class DecisionLedger {
  constructor(readonly path: string) {}

  append(entry: LedgerEntry): void {
    const line = JSON.stringify(entry);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.appendFileSync(this.path, `${line}\n`, 'utf8');
  }

  /** Newest-first records with envelope and body integrity re-validated on read. */
  list(limit = 100): RevalidatedLedgerEntry[] {
    return this.readAll()
      .slice(-limit)
      .reverse()
      .map((entry) => DecisionLedger.checked(entry));
  }

  get(decisionId: string): RevalidatedLedgerEntry | null {
    const all = this.readAll();
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].decision_id === decisionId) return DecisionLedger.checked(all[i]);
    }
    return null;
  }

  private readAll(): LedgerEntry[] {
    if (!fs.existsSync(this.path)) return [];
    const lines = fs.readFileSync(this.path, 'utf8').split(/\r?\n/);
    const out: LedgerEntry[] = [];
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as LedgerEntry);
      } catch (err) {
        // A corrupt line must never pass silently — surface it.
        throw new Error(
          `CHP decision ledger ${this.path} has a corrupt JSONL line: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    return out;
  }

  /**
   * Re-validate a record on read: envelope structure and body digest.
   * The CHP payload envelope validates structure only, so the ledger adds
   * its own SHA-256 digest over the sealed body — a tampered record reads
   * as integrity_valid: false.
   */
  private static checked(entry: LedgerEntry): RevalidatedLedgerEntry {
    const digest = bodySha256(entry.body ?? '');
    return {
      ...entry,
      envelope_valid: validatePayloadEnvelope(entry.envelope ?? ''),
      integrity_valid: digest === entry.body_sha256,
    };
  }
}
