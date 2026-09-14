import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function repositoryText(path) {
  try {
    return await readFile(new URL(path, root), 'utf8');
  } catch {
    return '';
  }
}

test('Codex GCP live smoke proves exact dev OIDC wiring with read-only project.inspect', async () => {
  const workflow = await repositoryText('.github/workflows/codex-gcp-live-smoke.yml');

  assert.match(workflow, /^name:\s*Codex GCP live smoke/m);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /push:[\s\S]*branches:\s*\[dev\][\s\S]*codex-gcp-live-smoke\.yml/);
  assert.match(workflow, /permissions:[\s\S]*contents:\s*read[\s\S]*id-token:\s*write/);
  assert.match(workflow, /runs-on:\s*ubuntu-latest/);
  assert.match(workflow, /SERVICE_AUDIENCE:\s*https:\/\/overcenter-shadow-bwcce2cokq-uw\.a\.run\.app/);
  assert.match(workflow, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/);
  assert.match(workflow, /ref:\s*\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/dev"/);
  assert.match(workflow, /git rev-parse HEAD/);
  assert.match(workflow, /git ls-remote origin refs\/heads\/dev/);
  assert.match(workflow, /google-github-actions\/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093/);
  assert.match(workflow, /workload_identity_provider:\s*\$\{\{ vars\.GCP_WORKLOAD_IDENTITY_PROVIDER \}\}/);
  assert.match(workflow, /service_account:\s*\$\{\{ vars\.GCP_DEPLOY_SERVICE_ACCOUNT \}\}/);
  assert.match(workflow, /token_format:\s*id_token/);
  assert.match(workflow, /id_token_audience:\s*\$\{\{ env\.SERVICE_AUDIENCE \}\}/);
  assert.match(workflow, /create_credentials_file:\s*false/);
  assert.match(workflow, /export_environment_variables:\s*false/);
  assert.match(workflow, /Authorization: Bearer \$ID_TOKEN/);
  assert.match(workflow, /x-overcenter-authority-mode: authoritative/);
  assert.match(workflow, /x-overcenter-request-id:/);
  assert.match(workflow, /"command":"project\.inspect"/);
  assert.match(workflow, /"project_ref":"github:laurajoyhutchins\/overcenter"/);
  assert.match(workflow, /\.ok == true/);
  assert.match(workflow, /\.project_ref == "github:laurajoyhutchins\/overcenter"/);
  assert.match(workflow, /\.authority_revision == \$revision/);
  assert.match(workflow, /\.frontier \| type == "array"/);
  assert.doesNotMatch(workflow, /project\.advance|github\.apply_changeset|production\.promote|project\.amend/);
});
