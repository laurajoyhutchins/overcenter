import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('contract evidence workflow enforces freshness and merge-base unclassified ratchet', async () => {
  const workflow = await readFile('.github/workflows/contract-evidence.yml', 'utf8');
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /cli\.mjs generate[\s\S]*\$RUNNER_TEMP\/contract-evidence\/generated\/contracts\/catalog\.json/);
  assert.match(workflow, /--atlas[\s\S]*data-contract-authority-atlas\.md/);
  assert.match(workflow, /cli\.mjs check[\s\S]*--expected-catalog[\s\S]*--expected-atlas[\s\S]*data-contract-authority-atlas\.md[\s\S]*generated\/contracts\/catalog\.json[\s\S]*docs\/generated\/data-contracts\.md/);
  assert.match(workflow, /git merge-base HEAD "origin\/\$\{\{ github\.base_ref \}\}"/);
  assert.match(workflow, /git cat-file -e "\$MERGE_BASE:generated\/contracts\/catalog\.json"/);
  assert.match(workflow, /git show "\$MERGE_BASE:generated\/contracts\/catalog\.json"/);
  assert.match(workflow, /cli\.mjs compare[\s\S]*--base-catalog[\s\S]*--head-catalog generated\/contracts\/catalog\.json/);
  assert.doesNotMatch(workflow, /contents:\s*write/);
  assert.doesNotMatch(workflow, /git push/);
  assert.doesNotMatch(workflow, /Materialize initial generated evidence/);
  assert.doesNotMatch(workflow, /upload-artifact/);
});
