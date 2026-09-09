import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionAuthorityService } from '../lib/execution-authority-core.js';
import { deriveProjectTransitionGithubWorkspace } from '../lib/project-transition-github-workspace.js';
import { applyGithubChangeset, coalesceGithubMechanicalChangeset } from '../lib/github-apply-changeset.js';

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

test('project transition mutation authority accepts the opaque plink lease reference emitted by project.advance', async () => {
  const authority = await fixture().require({ lease_ref:`plink:${LEASE_REF}`, repository:REPOSITORY });
  assert.equal(authority.lease_ref, LEASE_REF);
  assert.equal(authority.transition_id, TRANSITION_ID);
});

test('consecutive mechanical changesets fail before mutation with an executable coalescing remedy', async () => {
  const baseSha = '3'.repeat(40);
  const parentSha = '4'.repeat(40);
  let mutationCalls = 0;
  const github = {
    async resolveCommit() { return { sha:baseSha, tree_sha:'5'.repeat(40) }; },
    async getBranch() { return { sha:parentSha }; },
    async getCommit() { return { sha:parentSha, tree_sha:'6'.repeat(40), message:'lint: normalize fixtures' }; },
    async getPathEntries() { throw new Error('mechanical coalescing must fail before path planning'); },
    async createTree() { mutationCalls += 1; throw new Error('must not mutate'); },
    async createCommit() { mutationCalls += 1; throw new Error('must not mutate'); },
    async createBranch() { mutationCalls += 1; throw new Error('must not mutate'); },
    async updateBranch() { mutationCalls += 1; throw new Error('must not mutate'); },
  };

  const result = await applyGithubChangeset({
    repo:'example/project',
    base_sha:baseSha,
    branch:'fix/coalescing-contract',
    expected_head:parentSha,
    changes:[{ path:'example.txt', operation:'update', content:'next\n' }],
    commit_message:'format: normalize example',
  }, { github });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'MECHANICAL_CHANGESET_MUST_COALESCE');
  assert.equal(result.phase, 'preflight');
  assert.equal(result.may_have_mutated, false);
  assert.deepEqual(result.remedy, {
    strategy:'coalesce_or_chain',
    grouped_patch:{
      action:'replace_parent_and_current_with_one_changeset',
      base_sha:baseSha,
      expected_head:parentSha,
      instruction:'Combine the parent mechanical cleanup and this cleanup into one changeset against the parent commit parent.',
    },
    dependency_chain:{
      action:'use_non_mechanical_followup_with_exact_revision_dependency',
      depends_on:parentSha,
      instruction:'If the second edit requires the first edit as an intermediate state, express that dependency explicitly and use a non-mechanical follow-up commit message.',
    },
  });
  assert.equal(mutationCalls, 0);
});

test('mechanical coalescing replaces the exact mechanical head with one linear repair commit', async () => {
  const grandparentSha = '2'.repeat(40);
  const parentSha = '3'.repeat(40);
  const replacementSha = '4'.repeat(40);
  const treeSha = '5'.repeat(40);
  let replaced = null;
  const github = {
    async getBranch() { return { sha: parentSha }; },
    async getCommit() { return { sha: parentSha, tree_sha: '6'.repeat(40), message: 'lint: normalize fixtures', parents: [grandparentSha] }; },
    async getPathEntries() { return new Map([['example.txt', { path: 'example.txt', mode: '100644', type: 'blob', sha: '7'.repeat(40) }]]); },
    async createTree(repo, baseTree, entries) { assert.equal(baseTree, '6'.repeat(40)); assert.equal(entries[0].content, 'next\n'); return treeSha; },
    async createCommit(repo, request) { assert.equal(request.parentSha, grandparentSha); assert.equal(request.treeSha, treeSha); return replacementSha; },
    async replaceBranch(repo, branch, sha) { replaced = { repo, branch, sha }; },
  };
  const result = await coalesceGithubMechanicalChangeset({ repo: 'example/project', branch: 'work/coalescing-contract', expected_head: parentSha, changes: [{ path: 'example.txt', operation: 'update', content: 'next', ensure_final_newline: true }], commit_message: 'format: normalize example' }, { github });
  assert.equal(result.ok, true);
  assert.equal(result.old_head, parentSha);
  assert.equal(result.parent_sha, grandparentSha);
  assert.equal(result.new_head, replacementSha);
  assert.deepEqual(replaced, { repo: 'example/project', branch: 'work/coalescing-contract', sha: replacementSha });
});
