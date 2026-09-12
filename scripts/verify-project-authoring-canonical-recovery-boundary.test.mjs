import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('project authoring recovery is owned by the execution kernel', () => {
  assert.equal(fs.existsSync(path.join(root, 'lib/project-authoring-recovery.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'lib/project-authoring-recovery.test.js')), false);

  const host = read('lib/project-authoring-overcenter-host.js');
  const inspect = read('lib/project-inspect-github-runtime.js');
  const production = read('lib/project-authoring-production-runtime.js');
  const hostRuntime = read('lib/project-authoring-host-runtime.js');

  for (const source of [host, inspect, production, hostRuntime]) {
    assert.doesNotMatch(source, /CompactProviderOperation|ProjectAuthoringRecoveryService|beginProjectAuthoringRecovery|projectAuthoringRecovery/);
  }
  assert.match(inspect, /execution_state/);
  assert.match(inspect, /operation_state/);
});

test('uncertain project authoring does not expose an automatic same-request retry', () => {
  const failures = read('lib/orchestration-failures.js');
  assert.match(failures, /!mayHaveMutated &&/);
  assert.doesNotMatch(failures, /PROJECT_AUTHORING_INTEGRATION_PENDING'\) \{[\\s\\S]*?WAITING_EXTERNAL_VERIFICATION/);
});
