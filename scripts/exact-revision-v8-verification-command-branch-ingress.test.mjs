import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

async function readOptional(url) {
  try {
    return await readFile(url, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

test('command branch ingress relays exact-revision commands through trusted dev workflow without issues or branch OIDC', async () => {
  const workflow = await readOptional(new URL('../.github/workflows/gcp-semantic-command-branch.yml', import.meta.url));

  assert.match(workflow, /push:/);
  assert.match(workflow, /overcenter-command\/\*/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /actions: write/);
  assert.doesNotMatch(workflow, /id-token:\s*write/);
  assert.doesNotMatch(workflow, /google-github-actions\/auth/);
  assert.doesNotMatch(workflow, /\/api\/worker-command/);
  assert.doesNotMatch(workflow, /issues:\s*write/);
  assert.doesNotMatch(workflow, /\/issues\//);
  assert.match(workflow, /\.overcenter-command\.json/);
  assert.match(workflow, /git fetch --no-tags --depth=1 origin dev/);
  assert.match(workflow, /git rev-parse HEAD\^/);
  assert.match(workflow, /git diff --name-only/);
  assert.match(workflow, /github-command-issue\.mjs/);
  assert.match(workflow, /actions\/workflows\/gcp-semantic-command\.yml\/dispatches/);
  assert.match(workflow, /--arg ref "dev"/);
  assert.match(workflow, /return_run_details:true/);
  assert.match(workflow, /\[ "\$http_status" = 200 \]/);
  assert.match(workflow, /\.workflow_run_id/);
  assert.match(workflow, /overcenter-github-command-branch-response-v1/);
  assert.match(workflow, /actions\/upload-artifact/);
  assert.match(workflow, /git\/refs\/heads\/\$GITHUB_REF_NAME/);
});
