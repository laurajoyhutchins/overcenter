import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  applyProjectTransitionObservations,
  projectTransitionDefinitionFingerprint,
} from '../lib/project-transition-observations.js';

const apiSource = await readFile('api/github-apply-changeset.js', 'utf8');
const leaseScopedSource = await readFile('lib/github-lease-scoped-changeset.js', 'utf8');

test('github.apply_changeset remains an internal authority-aware capability without a secret lease token', () => {
  assert.match(apiSource, /createPostgresExecutionAuthorityService/);
  assert.match(apiSource, /lease_ref/);
  assert.match(apiSource, /applyGithubLeaseScopedChangeset/);
  assert.match(leaseScopedSource, /executionAuthority\.require/);
  assert.doesNotMatch(apiSource, /lease_token/);
});

test('github.apply_changeset is not registered as an ordinary MCP tool', async () => {
  await assert.rejects(readFile('mcp/github_apply_changeset.js', 'utf8'), /ENOENT/);
});

test('sealed GitHub recovery seed confirmations satisfy matching project transitions', async () => {
  const node = {
    id:'migrated-transition',
    priority:1,
    requires:[],
    executor:{ kind:'operator', command:'github.review_packet' },
  };
  const fingerprint = await projectTransitionDefinitionFingerprint(node);
  const result = await applyProjectTransitionObservations({
    project_ref:'github:laurajoyhutchins/overcenter',
    authority:{
      kind:'github',
      repository:'laurajoyhutchins/overcenter',
      revision:'b'.repeat(40),
      derivation:'overcenter-project-graph-v1',
    },
    nodes:[node],
    observations:[{
      schema:'project-transition-observation-v1',
      kind:'project_transition_confirmation',
      project_ref:'github:laurajoyhutchins/overcenter',
      transition_id:node.id,
      transition_definition_fingerprint:fingerprint,
      disposition:'completed',
      authority:{
        kind:'github',
        repository:'laurajoyhutchins/overcenter',
        revision:'a'.repeat(40),
        derivation:'overcenter-project-graph-v1',
      },
      provenance:{
        kind:'github_recovery_seed',
        ref:'.overcenter/recovery/hatchable-cutover-v1.json',
        settled_at:'2026-09-08T01:49:46.389Z',
      },
    }],
  });
  assert.equal(result[0].lifecycle.current_stage, 'CONFIRM');
  assert.equal(result[0].lifecycle.condition, 'NOMINAL');
});

test('unrecognized project transition observation provenance still fails closed', async () => {
  const node = {
    id:'unsupported-provenance',
    priority:1,
    requires:[],
    executor:{ kind:'operator', command:'github.review_packet' },
  };
  const fingerprint = await projectTransitionDefinitionFingerprint(node);
  await assert.rejects(
    applyProjectTransitionObservations({
      project_ref:'github:laurajoyhutchins/overcenter',
      authority:{
        kind:'github',
        repository:'laurajoyhutchins/overcenter',
        revision:'b'.repeat(40),
        derivation:'overcenter-project-graph-v1',
      },
      nodes:[node],
      observations:[{
        schema:'project-transition-observation-v1',
        kind:'project_transition_confirmation',
        project_ref:'github:laurajoyhutchins/overcenter',
        transition_id:node.id,
        transition_definition_fingerprint:fingerprint,
        disposition:'completed',
        authority:{
          kind:'github',
          repository:'laurajoyhutchins/overcenter',
          revision:'a'.repeat(40),
          derivation:'overcenter-project-graph-v1',
        },
        provenance:{ kind:'anything_goes', settled_at:'2026-09-08T01:49:46.389Z' },
      }],
    }),
    error => error?.code === 'PROJECT_GRAPH_OBSERVATIONS_INVALID',
  );
});

test('post-cutover GCP deployment path cannot demote authoritative runtime to shadow', async () => {
  for (const retiredPath of [
    '.github/workflows/gcp-hosted-shadow-deploy.yml',
    'scripts/gcp/deploy-shadow.sh',
  ]) {
    await assert.rejects(readFile(retiredPath, 'utf8'), /ENOENT/);
  }

  const workflow = await readFile('.github/workflows/gcp-authoritative-deploy.yml', 'utf8');
  const deploy = await readFile('scripts/gcp/deploy-authoritative.sh', 'utf8');
  const bootstrap = await readFile('scripts/gcp/bootstrap-github-oidc.sh', 'utf8');

  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n\s*push:/);
  assert.match(workflow, /refs\/heads\/main/);
  assert.match(workflow, /deploy-authoritative\.sh/);

  assert.match(deploy, /BEFORE_MODE/);
  assert.match(deploy, /BEFORE_FREEZE/);
  assert.match(deploy, /OVERCENTER_AUTHORITY_MODE=authoritative/);
  assert.doesNotMatch(deploy, /OVERCENTER_AUTHORITY_MODE=shadow/);

  assert.doesNotMatch(bootstrap, /gcp-hosted-shadow-deploy/);
  assert.doesNotMatch(bootstrap, /gcp-cloud-run-cloud-sql-bootstrap/);
  assert.doesNotMatch(bootstrap, /gh workflow run/);
});

test('authoritative deployment proves a reversible ordinary GCP transition and durable settlement', async () => {
  const workflow = await readFile('.github/workflows/gcp-authoritative-deploy.yml', 'utf8');
  const proof = await readFile('scripts/gcp/prove-authoritative-runtime.sh', 'utf8');
  const inspector = await readFile('scripts/cloud-run-authority-proof-inspect.mjs', 'utf8');

  assert.match(workflow, /token_format:\s*id_token/);
  assert.match(workflow, /id_token_audience:/);
  assert.match(workflow, /prove-authoritative-runtime\.sh inspect-failed/);
  assert.match(workflow, /deploy-authoritative\.sh/);
  assert.match(workflow, /prove-authoritative-runtime\.sh prove/);
  assert.match(workflow, /finish-hatchable-gcp-authoritative-state-migration/);
  assert.doesNotMatch(workflow, /production\.promote/);

  assert.match(proof, /\/health/);
  assert.match(proof, /\/api\/authoritative-state\/project-inspect/);
  assert.match(proof, /\/api\/worker-command/);
  assert.match(proof, /project\.advance/);
  assert.match(proof, /AGENT_EXECUTION_REQUIRED/);
  assert.match(proof, /disposition:\"requeue\"/);
  assert.match(proof, /requeue_class:\"insufficient_execution_window\"/);
  assert.match(proof, /settle_receipt/);
  assert.match(proof, /active_transition_leases/);
  assert.match(proof, /source_only_migrations/);
  assert.doesNotMatch(proof, /disposition:\"completed\"/);

  assert.match(inspector, /READ ONLY/);
  assert.match(inspector, /FROM orchestration_runs/);
  assert.match(inspector, /FROM work_leases/);
  assert.match(inspector, /FROM execution_state/);
  assert.match(inspector, /FROM work_lease_slots/);
  assert.match(inspector, /overcenter_authority_freeze/);
});
