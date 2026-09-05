import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionAuthorityService } from '../lib/execution-authority-core.js';
import { deriveProjectTransitionGithubWorkspace } from '../lib/project-transition-github-workspace.js';

const REPOSITORY = 'laurajoyhutchins/overcenter';
const PROJECT_REF = `github:${REPOSITORY}`;
const TRANSITION_ID = 'transition-a';
const LEASE_REF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_ID = 'run-project-transition';
const ISSUED_REVISION = '1'.repeat(40);
const CURRENT_REVISION = '2'.repeat(40);
const DERIVATION = 'overcenter-project-graph-v1';
const GRAPH_FINGERPRINT = 'f'.repeat(64);
const TRANSITION_FINGERPRINT = 'd'.repeat(64);

function fixture({ includeIssuedAuthority = true } = {}) {
  const subject = {
    project_ref: PROJECT_REF,
    transition_id: TRANSITION_ID,
    repository: REPOSITORY,
    graph_fingerprint: GRAPH_FINGERPRINT,
    transition_definition_fingerprint: TRANSITION_FINGERPRINT,
    ...(includeIssuedAuthority ? {
      authority_revision: ISSUED_REVISION,
      authority_derivation: DERIVATION,
    } : {}),
  };
  const lease = {
    lease_id: LEASE_REF,
    run_id: RUN_ID,
    status: 'active',
    expires_at: '2026-09-05T06:00:00Z',
    hard_expires_at: '2026-09-05T07:00:00Z',
    claim_receipt: {
      subject: 'project_transition',
      project_transition: subject,
    },
  };
  const graphRevisionChange = {
    schema: 'project-graph-revision-change-v1',
    previous_authority: { kind:'github', repository:REPOSITORY, revision:ISSUED_REVISION, derivation:DERIVATION },
    current_authority: { kind:'github', repository:REPOSITORY, revision:CURRENT_REVISION, derivation:DERIVATION },
    changes: [],
  };
  const store = {
    async getLeaseById(id) { return id === LEASE_REF ? lease : null; },
    async getLeaseByTokenHash() { return null; },
  };
  const projectTransitions = {
    async require() {
      return {
        ok: true,
        lease_ref: LEASE_REF,
        subject: 'project_transition',
        run_id: RUN_ID,
        project_ref: PROJECT_REF,
        transition_id: TRANSITION_ID,
        repository: REPOSITORY,
        authority: { kind:'github', repository:REPOSITORY, revision:CURRENT_REVISION, derivation:DERIVATION },
        graph_fingerprint: GRAPH_FINGERPRINT,
        transition_definition_fingerprint: TRANSITION_FINGERPRINT,
        graph_revision_change: graphRevisionChange,
      };
    },
  };
  return createExecutionAuthorityService({
    store,
    projectTransitions,
    now: () => '2026-09-05T05:30:00Z',
  });
}

test('compatible graph revision continuation preserves the lease issuance authority for Git mutation workspace identity', async () => {
  const authority = await fixture().require({ lease_ref:LEASE_REF, repository:REPOSITORY });

  assert.equal(authority.authority.revision, ISSUED_REVISION,
    'mutation authority must remain pinned to the revision under which the lease was issued');
  assert.equal(authority.authority.derivation, DERIVATION);
  assert.equal(authority.current_authority.revision, CURRENT_REVISION,
    'current graph authority should remain available as observation evidence');
  assert.equal(authority.graph_revision_change.current_authority.revision, CURRENT_REVISION);

  const actualWorkspace = await deriveProjectTransitionGithubWorkspace(authority);
  const issuedWorkspace = await deriveProjectTransitionGithubWorkspace({
    ...authority,
    authority: { kind:'github', repository:REPOSITORY, revision:ISSUED_REVISION, derivation:DERIVATION },
  });
  assert.equal(actualWorkspace.authority_revision, ISSUED_REVISION);
  assert.equal(actualWorkspace.workspace_digest, issuedWorkspace.workspace_digest);
  assert.equal(actualWorkspace.branch, issuedWorkspace.branch);
});

test('project transition mutation authority fails closed when durable lease issuance authority is unavailable', async () => {
  await assert.rejects(
    () => fixture({ includeIssuedAuthority:false }).require({ lease_ref:LEASE_REF, repository:REPOSITORY }),
    (error) => error?.code === 'EXECUTION_AUTHORITY_INVALID'
      && error?.details?.reason === 'issued_authority_unavailable',
  );
});