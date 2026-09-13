import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { resolveWithinBase } from '../src/utils/safePath';
import { defaultPolicy, defaultPolicyPath, loadPolicy } from '../src/chp/policy';

const repoRoot = path.resolve(process.cwd());

test('resolveWithinBase keeps in-tree relative paths', () => {
  assert.equal(resolveWithinBase('policy.yaml'), path.join(repoRoot, 'policy.yaml'));
  assert.equal(resolveWithinBase('./policy.yaml'), path.join(repoRoot, 'policy.yaml'));
  assert.equal(
    resolveWithinBase(path.join('src', '..', 'policy.yaml')),
    path.join(repoRoot, 'policy.yaml'),
  );
});

test('resolveWithinBase keeps an already-resolved in-tree absolute path', () => {
  assert.equal(resolveWithinBase(defaultPolicyPath()), defaultPolicyPath());
});

test('resolveWithinBase rejects parent-directory traversal', () => {
  assert.throws(() => resolveWithinBase('../etc/passwd'), /escapes allowed directory/);
  assert.throws(() => resolveWithinBase('..'), /escapes allowed directory/);
  assert.throws(() => resolveWithinBase(path.join('src', '..', '..', 'etc', 'passwd')), /escapes allowed directory/);
});

test('resolveWithinBase rejects absolute paths outside the base', () => {
  assert.throws(() => resolveWithinBase('/etc/passwd'), /escapes allowed directory/);
});

test('loadPolicy still reads the in-tree policy.yaml', () => {
  const policy = loadPolicy('policy.yaml');
  // Distinct from defaultPolicy() (1000 / 5000 / 250).
  assert.equal(policy.maxNotionalUsd, 5000);
  assert.equal(policy.dailyNotionalCapUsd, 20000);
  assert.equal(policy.hitlThresholdUsd, 1000);
});

test('loadPolicy rejects traversal and falls back to the default policy', () => {
  const policy = loadPolicy('../etc/passwd');
  assert.deepEqual(policy, defaultPolicy());
});
