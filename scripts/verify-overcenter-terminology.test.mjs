import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LIVE_PRODUCT_PATHS = Object.freeze([
  'lib/execution-authority.js',
  'lib/project-controller-runtime.js',
  'mcp/github_apply_changeset.js',
]);

test('maintained production product language uses Overcenter terminology', () => {
  const offenders = [];
  for (const path of LIVE_PRODUCT_PATHS) {
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (/\bBusbar\b/.test(line)) offenders.push(`${path}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `obsolete Busbar product wording remains: ${offenders.join(', ')}`);
});