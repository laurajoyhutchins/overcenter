import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const broker = await readFile(new URL('../api/gcp-semantic-command-dispatch.js', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../.github/workflows/gcp-semantic-command.yml', import.meta.url), 'utf8');
const descriptors = await readFile(new URL('../lib/semantic-command-descriptors.js', import.meta.url), 'utf8');
const workerTransport = await readFile(new URL('../lib/worker-transport.js', import.meta.url), 'utf8');

test('bounded GCP bridge admits production.reconcile without reimplementing reconciliation', () => {
  assert.match(broker, /PRODUCTION_COMMANDS = new Set\(\['production\.reconcile'\]\)/);
  assert.match(broker, /PRODUCTION_RECONCILE_INPUT_FIELDS = new Set\(\['repo'\]\)/);
  assert.match(broker, /normalizeProductionReconcileInput\(value\)/);
  assert.match(broker, /production\.reconcile repo must be owner\/repo/);
  assert.doesNotMatch(broker, /productionReconciliationFor/);
});

test('workflow validates typed repository input and forwards the semantic command unchanged', () => {
  assert.match(workflow, /- production\.reconcile/);
  assert.match(workflow, /production\.reconcile\)/);
  assert.match(workflow, /keys == \["repo"\]/);
  assert.match(workflow, /orchestration\.diagnose\|production\.reconcile\|project\.define/);
  assert.match(workflow, /\/api\/worker-command/);
  assert.doesNotMatch(workflow, /productionReconciliationFor/);
});

test('bridge preserves the existing production.reconcile descriptor and authoritative worker implementation', () => {
  assert.match(descriptors, /const productionReconcileSchema = productionPromoteSchema/);
  assert.match(workerTransport, /'production\.reconcile': \{/);
  assert.match(workerTransport, /productionReconciliationFor\(\{/);
});
