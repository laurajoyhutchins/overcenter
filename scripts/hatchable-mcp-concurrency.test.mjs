import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SHARED_GROUP = 'overcenter-hatchable-mcp';

function workflow(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function concurrencyGroup(source) {
  return source.match(/concurrency:\s*\n\s*group:\s*([^\n]+)/)?.[1]?.trim();
}

test('Hatchable MCP workflows share one account-rate concurrency lane', () => {
  const exactRevision = workflow('.github/workflows/exact-revision-v8.yml');
  const productionMaterialization = workflow('.github/workflows/production-materialization.yml');

  assert.equal(concurrencyGroup(exactRevision), SHARED_GROUP);
  assert.equal(concurrencyGroup(productionMaterialization), SHARED_GROUP);
  assert.match(exactRevision, /concurrency:\s*\n\s*group:\s*overcenter-hatchable-mcp\s*\n\s*cancel-in-progress:\s*false/);
  assert.match(productionMaterialization, /concurrency:\s*\n\s*group:\s*overcenter-hatchable-mcp\s*\n\s*cancel-in-progress:\s*false/);
});
