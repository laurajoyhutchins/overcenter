import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const deployScript = await readFile(new URL('./gcp/deploy-authoritative.sh', import.meta.url), 'utf8');

test('target activation preserves the Cloud Native Buildpacks launcher environment', () => {
  assert.match(deployScript, /--command=\/cnb\/lifecycle\/launcher/);
  assert.match(deployScript, /--args="--,node,scripts\/cloud-run-target-activate\.mjs"/);
  assert.doesNotMatch(deployScript, /--command=node\b/);
});
