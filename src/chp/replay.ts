// ============================================================
// CogniTrader BSC — Receipt Nonce Replay Store
// Port of cubiczan-chp-mcp `src/replay.ts`: a receipt is
// single-use. Replaying the same nonce — even with a valid MAC
// and unexpired window — is a deny.
// ============================================================

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { getLogger } from '../utils/logger';

export interface ReplayRecord {
  nonce: string;
  consumedAt: string;
  argsHash: string;
  tool: string;
  resource: string;
}

export interface ReplayStore {
  seen(nonce: string): boolean;
  consume(record: ReplayRecord): void;
}

export class InMemoryReplayStore implements ReplayStore {
  private readonly used = new Map<string, ReplayRecord>();

  seen(nonce: string): boolean {
    return this.used.has(nonce);
  }

  consume(record: ReplayRecord): void {
    this.used.set(record.nonce, record);
  }

  get(nonce: string): ReplayRecord | undefined {
    return this.used.get(nonce);
  }

  get size(): number {
    return this.used.size;
  }
}

/**
 * JSONL-backed replay store: consumed nonces survive a process restart, so
 * a receipt issued before a restart cannot be replayed within its TTL (the
 * in-memory store forgets them — flagged in review). Append-only, one JSON
 * record per line, stored next to the other `state/` artifacts. A missing
 * or corrupt file starts empty (worst case: a stale nonce is forgotten —
 * never a false deny); entries past a receipt TTL are harmless to keep.
 */
export class FileReplayStore implements ReplayStore {
  private readonly used = new Map<string, ReplayRecord>();

  constructor(private readonly filePath: string) {
    if (!existsSync(filePath)) return;
    try {
      for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          const record = JSON.parse(trimmed) as ReplayRecord;
          if (typeof record.nonce === 'string' && record.nonce.trim() !== '') {
            this.used.set(record.nonce, record);
          }
        } catch {
          getLogger().warn(`[chp] replay log ${this.filePath}: skipping corrupt line`);
        }
      }
    } catch (error) {
      getLogger().warn(
        `[chp] replay log ${this.filePath} unreadable, starting empty: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  seen(nonce: string): boolean {
    return this.used.has(nonce);
  }

  consume(record: ReplayRecord): void {
    this.used.set(record.nonce, record);
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`);
    } catch (error) {
      // The nonce is consumed in memory either way; persistence is the
      // restart-safety guarantee, so a failed append is loud, not silent.
      getLogger().warn(
        `[chp] replay log append failed for ${this.filePath} — restart replay protection degraded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  get size(): number {
    return this.used.size;
  }
}
