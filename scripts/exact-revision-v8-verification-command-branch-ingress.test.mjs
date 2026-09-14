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

test('command branch ingress is bounded, exact-revision, artifact-backed, and issue-free', async () => {
  const workflow = await readOptional(new URL('../.github/workflows/gcp-semantic-command-branch.yml', import.meta.url));

  assert.match(workflow, /push:/);
  assert.match(workflow, /overcenter-command\/\*/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /id-token: write/);
  assert.doesNotMatch(workflow, /issues:\s*write/);
  assert.doesNotMatch(workflow, /\/issues\//);
  assert.match(workflow, /\.overcenter-command\.json/);
  assert.match(workflow, /git fetch --no-tags --depth=1 origin dev/);
  assert.match(workflow, /git rev-parse HEAD\^/);
  assert.match(workflow, /git diff --name-only/);
  assert.match(workflow, /github-command-issue\.mjs/);
  assert.match(workflow, /\/api\/worker-command/);
  assert.match(workflow, /actions\/upload-artifact/);
  assert.match(workflow, /overcenter-github-command-branch-response-v1/);
  assert.match(workflow, /git\/refs\/heads\/\$GITHUB_REF_NAME/);
  assert.match(workflow, /Assert semantic command succeeded/);
  assert.match(workflow, /jq -e '\.ok == true'/);
});
