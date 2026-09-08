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
