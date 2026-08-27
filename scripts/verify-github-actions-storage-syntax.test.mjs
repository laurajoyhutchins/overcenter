import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('GitHub Actions storage module parses as JavaScript', () => {
  const result = spawnSync(process.execPath, ['--check', 'lib/github-actions-storage.js'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || 'node --check failed');
});