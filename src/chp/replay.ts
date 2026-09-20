// ============================================================
// CogniTrader BSC — Receipt Nonce Replay Store
// Port of cubiczan-chp-mcp `src/replay.ts`: a receipt is
// single-use. Replaying the same nonce — even with a valid MAC
// and unexpired window — is a deny.
// ============================================================

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
