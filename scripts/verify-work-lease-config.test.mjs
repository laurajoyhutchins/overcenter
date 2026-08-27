import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SOURCE = new URL('../lib/work-leases.js', import.meta.url);

test('workLeaseConfig binds active_state to the declared executable-state constant', async () => {
  const source = await readFile(SOURCE, 'utf8');

  assert.match(source, /const\s+EXECUTABLE_STATE\s*=\s*['"]Todo['"]\s*;/);
  assert.match(source, /active_state\s*:\s*EXECUTABLE_STATE\b/);
  assert.doesNotMatch(source, /active_state\s*:\s*ACTIVE_STATE\b/);
});
