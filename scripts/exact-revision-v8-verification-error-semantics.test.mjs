import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const commandResponseUrl = new URL('../lib/command-response.js', import.meta.url);
const orchestrationFailuresUrl = new URL('../lib/orchestration-failures.js', import.meta.url);

test('missing project graph reader is setup-required without disabling the worker', async () => {
  const [commandResponse, orchestrationFailures] = await Promise.all([
    readFile(commandResponseUrl, 'utf8'),
    readFile(orchestrationFailuresUrl, 'utf8'),
  ]);

  assert.match(commandResponse, /PROJECT_GRAPH_READER_UNAVAILABLE/);
  assert.match(commandResponse, /restore_runtime_capability/);
  assert.match(orchestrationFailures, /RUNTIME_SETUP_REQUIRED/);
  assert.match(orchestrationFailures, /PROJECT_GRAPH_READER_UNAVAILABLE/);
  assert.match(
    orchestrationFailures,
    /failure_state === 'RUNTIME_SETUP_REQUIRED'\) return 'degraded'/,
  );
  assert.doesNotMatch(
    orchestrationFailures,
    /DISABLED_CODES[\s\S]*PROJECT_GRAPH_READER_UNAVAILABLE[\s\S]*AUTHORITY_CONFLICT_CODES/,
  );
});