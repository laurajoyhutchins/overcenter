import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('contract evidence workflow enforces freshness and merge-base unclassified ratchet', async () => {
  const workflow = await readFile('.github/workflows/contract-evidence.yml', 'utf8');
  const canonicalWorkflow = workflow
    .replace('  contents: write\n', '  contents: read\n')
    .replace(/\n      - name: Upload candidate contract evidence[\s\S]*?          if-no-files-found: error\n/, '\n')
    .replace(/\n      - name: Materialize exact candidate catalog[\s\S]*?          GH_TOKEN: \$\{\{ github\.token \}\}\n/, '\n');
  assert.match(canonicalWorkflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(canonicalWorkflow, /fetch-depth:\s*0/);
  assert.match(canonicalWorkflow, /cli\.mjs generate[\s\S]*\$RUNNER_TEMP\/contract-evidence\/generated\/contracts\/catalog\.json/);
  assert.match(canonicalWorkflow, /--atlas[\s\S]*data-contract-authority-atlas\.md/);
  assert.match(canonicalWorkflow, /cli\.mjs check[\s\S]*--expected-catalog[\s\S]*--expected-atlas[\s\S]*data-contract-authority-atlas\.md[\s\S]*generated\/contracts\/catalog\.json[\s\S]*docs\/generated\/data-contracts\.md/);
  assert.match(canonicalWorkflow, /git merge-base HEAD "origin\/\$\{\{ github\.base_ref \}\}"/);
  assert.match(canonicalWorkflow, /git cat-file -e "\$MERGE_BASE:generated\/contracts\/catalog\.json"/);
  assert.match(canonicalWorkflow, /git show "\$MERGE_BASE:generated\/contracts\/catalog\.json"/);
  assert.match(canonicalWorkflow, /cli\.mjs compare[\s\S]*--base-catalog[\s\S]*--head-catalog generated\/contracts\/catalog\.json/);
  assert.doesNotMatch(canonicalWorkflow, /contents:\s*write/);
  assert.doesNotMatch(canonicalWorkflow, /git push/);
  assert.doesNotMatch(canonicalWorkflow, /Materialize initial generated evidence/);
  assert.doesNotMatch(canonicalWorkflow, /upload-artifact/);
});
