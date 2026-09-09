import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const deployScript = await readFile(new URL('./gcp/deploy-command-ingress.sh', import.meta.url), 'utf8');

test('command ingress preserves buildpack runtime environment', () => {
  assert.match(deployScript, /--command=\/cnb\/lifecycle\/launcher/);
  assert.match(deployScript, /--args="--,node,scripts\/cloud-run-command-ingress\.mjs"/);
  assert.doesNotMatch(deployScript, /--command=node\b/);
});

test('command ingress remains physically separated from authoritative storage', () => {
  assert.doesNotMatch(deployScript, /--(?:add|set)-cloudsql-instances/);
  assert.doesNotMatch(deployScript, /--set-secrets=/);
  assert.match(deployScript, /roles\/run\.invoker/);
  assert.match(deployScript, /forbidden in \('PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','DATABASE_URL','GITHUB_APP_PRIVATE_KEY'\)/);
});

test('authoritative target remains private after ingress deployment', () => {
  assert.match(deployScript, /TARGET_UNAUTH_STATUS/);
  assert.match(deployScript, /TARGET_UNAUTH_STATUS" != "403"/);
});
