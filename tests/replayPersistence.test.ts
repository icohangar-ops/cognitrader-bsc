// ============================================================
// Tests for the JSONL-backed replay store (src/chp/replay.ts —
// FileReplayStore, review finding: consumed nonces must survive a
// restart so a pre-restart receipt cannot be replayed within its TTL)
// Proves: consume appends and persists; a reloaded store denies the
// nonce; a missing or corrupt file starts empty rather than failing.
// Run with: npm test
// ============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { FileReplayStore, InMemoryReplayStore } from '../src/chp/replay';

function tmpLogPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'cognitrader-replay-')), 'nonces.jsonl');
}

function record(nonce: string) {
  return {
    nonce,
    consumedAt: new Date(0).toISOString(),
    argsHash: 'a'.repeat(64),
    tool: 'execute_trade',
    resource: 'execute_trade:LONG:CAKE',
  };
}

test('a fresh store starts empty and accepts a nonce', () => {
  const store = new FileReplayStore(tmpLogPath());
  assert.equal(store.size, 0);
  assert.equal(store.seen('nonce-1'), false);
  store.consume(record('nonce-1'));
  assert.equal(store.seen('nonce-1'), true);
});

test('consume appends a JSON line to the log file', () => {
  const logPath = tmpLogPath();
  const store = new FileReplayStore(logPath);
  store.consume(record('nonce-1'));
  store.consume(record('nonce-2'));

  const lines = readFileSync(logPath, 'utf-8').split('\n').filter((l) => l.trim() !== '');
  assert.equal(lines.length, 2);
  assert.equal((JSON.parse(lines[0]) as { nonce: string }).nonce, 'nonce-1');
  assert.equal((JSON.parse(lines[1]) as { nonce: string }).nonce, 'nonce-2');
});

test('a reloaded store denies a nonce consumed before the restart', () => {
  const logPath = tmpLogPath();
  const first = new FileReplayStore(logPath);
  first.consume(record('nonce-1'));

  const second = new FileReplayStore(logPath); // "restart"
  assert.equal(second.size, 1);
  assert.equal(second.seen('nonce-1'), true);
  // The whole point: a replay of the pre-restart receipt nonce denies.
  assert.equal(second.seen('fresh-nonce'), false);
});

test('a corrupt log line is skipped; valid lines and blanks still load', () => {
  const logPath = tmpLogPath();
  writeFileSync(logPath, '{not json}\n\n' + JSON.stringify(record('nonce-ok')) + '\n');
  const store = new FileReplayStore(logPath);
  assert.equal(store.size, 1);
  assert.equal(store.seen('nonce-ok'), true);
  assert.equal(store.seen('nonce-missing'), false);
});

test('an unreadable log file starts empty (never a false deny)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cognitrader-replay-dir-'));
  // A directory at the log path is unreadable as a file (EISDIR).
  const asDir = path.join(dir, 'nonces.jsonl');
  mkdirSync(asDir);
  const store = new FileReplayStore(asDir);
  assert.equal(store.size, 0);
});

test('the in-memory store still works for tests and dry runs', () => {
  const store = new InMemoryReplayStore();
  store.consume(record('nonce-1'));
  assert.equal(store.seen('nonce-1'), true);
  assert.equal(store.seen('nonce-2'), false);
});
