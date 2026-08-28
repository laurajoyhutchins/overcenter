import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../.github/workflows/exact-revision-v8.yml', import.meta.url);

test('exact-revision workflow verifies pull-request candidates at the exact PR head', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.match(workflow, /\n  pull_request:\s*\n/);
  assert.match(
    workflow,
    /TARGET_REVISION:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|\s*github\.event\.inputs\.revision\s*\|\|\s*github\.sha\s*\}\}/,
  );
});
