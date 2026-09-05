import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/production-materialization.yml', import.meta.url), 'utf8');

test('production materialization supports exact-revision recovery dispatch and fences before mutation', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /exact_revision:/);
  assert.match(workflow, /production-materialization-head-fence\.mjs/);
  const fence = workflow.indexOf('production-materialization-head-fence.mjs');
  const materialize = workflow.indexOf('production-materialization-dist-http.mjs');
  assert.ok(fence >= 0 && materialize > fence, 'exact production head must be fenced before Hatchable materialization');
  assert.match(workflow, /EXACT_REVISION:/);
  assert.match(workflow, /PRODUCTION_BRANCH: main/);
});