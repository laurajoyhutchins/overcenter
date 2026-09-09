import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionAuthorityService } from '../lib/execution-authority-core.js';
import { deriveProjectTransitionGithubWorkspace } from '../lib/project-transition-github-workspace.js';
import { applyGithubChangeset, coalesceGithubMechanicalChangeset, createGithubApiAdapter } from '../lib/github-apply-changeset.js';
import { coalesceGithubLeaseScopedChangeset } from '../lib/github-worker-mutations.js';
import { semanticCommandDescriptor } from '../lib/semantic-command-descriptors.js';

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

test('canonical mechanical coalescing command is lease-scoped and derives Git coordinates', () => {
  const descriptor = semanticCommandDescriptor('github.coalesce_changeset');
  assert.deepEqual(descriptor.required_fields, ['lease_ref', 'changes', 'commit_message']);
  assert.deepEqual(descriptor.semantic_fields, ['lease_ref', 'changes', 'commit_message']);
  assert.equal(descriptor.exposure.worker, true);
  assert.equal(descriptor.exposure.mcp, false);
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
    strategy:'canonical_command',
    command:'github.coalesce_changeset',
    expected_head:parentSha,
    base_sha:baseSha,
    instruction:'Coalesce the pending mechanical cleanup into the immediately preceding same-lease mechanical workspace head; do not relabel the cleanup or create a follow-up commit.',
  });
  assert.equal(mutationCalls, 0);
});

test('lease-scoped mechanical coalescing rejects a different lease before Git mutation', async () => {
  const parentSha = 'f'.repeat(40);
  let withGithubCalls = 0;
  const authority = fixture();
  const db = {
    async query(sql) {
      if (sql.includes('SELECT idempotency_key, receipt FROM github_changeset_receipts')) {
        return {
          rows: [{
            idempotency_key: 'project-transition-changeset-v1:other-lease',
            receipt: {
              ok: true,
              commit_sha: parentSha,
              execution_authority: { lease_ref: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
            },
          }],
        };
      }
      throw new Error(`unexpected db query: ${sql}`);
    },
  };

  await assert.rejects(
    () => coalesceGithubLeaseScopedChangeset({
      lease_ref: LEASE_REF,
      changes: [{ path: 'example.txt', operation: 'update', content: 'next\n' }],
      commit_message: 'format: normalize example',
    }, {
      executionAuthority: authority,
      readBranch: async () => ({ sha: parentSha }),
      withGithub: async () => { withGithubCalls += 1; throw new Error('must not mutate'); },
      db,
    }),
    (error) => error?.code === 'MECHANICAL_COALESCE_PARENT_AUTHORITY_MISMATCH'
      && error?.details?.may_have_mutated === false,
  );
  assert.equal(withGithubCalls, 0);
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
    async replaceBranch(repo, branch, expectedHead, sha) { replaced = { repo, branch, expectedHead, sha }; },
  };
  const result = await coalesceGithubMechanicalChangeset({ repo: 'example/project', branch: 'work/coalescing-contract', expected_head: parentSha, changes: [{ path: 'example.txt', operation: 'update', content: 'next', ensure_final_newline: true }], commit_message: 'format: normalize example' }, { github });
  assert.equal(result.ok, true);
  assert.equal(result.old_head, parentSha);
  assert.equal(result.parent_sha, grandparentSha);
  assert.equal(result.new_head, replacementSha);
  assert.deepEqual(replaced, { repo: 'example/project', branch: 'work/coalescing-contract', expectedHead: parentSha, sha: replacementSha });
});

test('lease-scoped mechanical coalescing persists the replacement as replayable same-lease effect evidence', async () => {
  const parentSha = '8'.repeat(40);
  const grandparentSha = '9'.repeat(40);
  const replacementSha = 'a'.repeat(40);
  const treeSha = 'b'.repeat(40);
  let currentHead = parentSha;
  let replaceCalls = 0;
  const authority = fixture();
  const parentAuthority = await authority.require({ lease_ref: LEASE_REF });
  let durableRow = {
    idempotency_key: 'project-transition-changeset-v1:parent',
    commit_sha: parentSha,
    tree_sha: 'c'.repeat(40),
    receipt: {
      ok: true,
      commit_sha: parentSha,
      execution_authority: parentAuthority,
      idempotency_key: 'project-transition-changeset-v1:parent',
    },
  };
  const db = {
    async query(sql, params) {
      if (sql.includes('SELECT idempotency_key, receipt FROM github_changeset_receipts')) {
        return { rows: durableRow.commit_sha === params[2] ? [{ idempotency_key: durableRow.idempotency_key, receipt: durableRow.receipt }] : [] };
      }
      if (sql.includes('UPDATE github_changeset_receipts')) {
        assert.equal(params[6], parentSha);
        durableRow = { ...durableRow, commit_sha: params[3], tree_sha: params[4], receipt: JSON.parse(params[5]) };
        return { rowCount: 1, rows: [{ idempotency_key: durableRow.idempotency_key }] };
      }
      throw new Error(`unexpected db query: ${sql}`);
    },
  };
  const github = {
    async getBranch() { return { sha: currentHead }; },
    async getCommit() { return { sha: parentSha, tree_sha: 'd'.repeat(40), message: 'lint: normalize fixtures', parents: [grandparentSha] }; },
    async getPathEntries() { return new Map([['example.txt', { path: 'example.txt', mode: '100644', type: 'blob', sha: 'e'.repeat(40) }]]); },
    async createTree() { return treeSha; },
    async createCommit() { return replacementSha; },
    async replaceBranch(repo, branch, expectedHead, sha) {
      assert.equal(expectedHead, parentSha);
      assert.equal(sha, replacementSha);
      replaceCalls += 1;
      currentHead = replacementSha;
    },
  };
  const options = {
    executionAuthority: authority,
    readBranch: async () => ({ sha: currentHead }),
    withGithub: async (_request, callback) => callback(github),
    db,
  };
  const request = {
    lease_ref: LEASE_REF,
    changes: [{ path: 'example.txt', operation: 'update', content: 'next', ensure_final_newline: true }],
    commit_message: 'format: normalize example',
  };

  const first = await coalesceGithubLeaseScopedChangeset(request, options);
  assert.equal(first.ok, true);
  assert.equal(first.commit_sha, replacementSha);
  assert.equal(first.coalesced_from, parentSha);
  assert.equal(first.idempotency_key, durableRow.idempotency_key);
  assert.match(first.coalesce_request_sha256, /^[0-9a-f]{64}$/);
  assert.equal(durableRow.commit_sha, replacementSha);
  assert.equal(durableRow.receipt.coalesce_request_sha256, first.coalesce_request_sha256);

  const replay = await coalesceGithubLeaseScopedChangeset(request, options);
  assert.equal(replay.ok, true);
  assert.equal(replay.commit_sha, replacementSha);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.coalesce_request_sha256, first.coalesce_request_sha256);
  assert.equal(replaceCalls, 1, 'exact replay must not replace the branch twice');
});

test('mechanical head replacement uses atomic GraphQL beforeOid fencing', async () => {
  const expectedHead = '8'.repeat(40);
  const replacementSha = '9'.repeat(40);
  const calls = [];
  const apiClient = {
    async call(provider, request) {
      calls.push({ provider, request });
      if (request.method === 'GET' && request.path === '/repos/example/project') {
        return { status: 200, body: { node_id: 'R_example' }, headers: {} };
      }
      if (request.method === 'POST' && request.path === '/graphql') {
        return { status: 200, body: { data: { updateRefs: { clientMutationId: null } } }, headers: {} };
      }
      throw new Error(`unexpected GitHub request ${request.method} ${request.path}`);
    },
  };
  const github = createGithubApiAdapter(apiClient);
  await github.replaceBranch('example/project', 'work/coalescing-contract', expectedHead, replacementSha);
  const mutation = calls.find(call => call.request.path === '/graphql')?.request;
  assert.ok(mutation, 'expected GraphQL ref mutation');
  assert.deepEqual(mutation.body.variables.refUpdates, [{
    name: 'refs/heads/work/coalescing-contract',
    beforeOid: expectedHead,
    afterOid: replacementSha,
    force: true,
  }]);
});

test('mechanical coalescing rejects stale head before creating Git objects', async () => {
  const expectedHead = 'a'.repeat(40);
  let mutationCalls = 0;
  const github = {
    async getBranch() { return { sha: 'b'.repeat(40) }; },
    async getCommit() { throw new Error('must not read stale parent'); },
    async getPathEntries() { throw new Error('must not plan stale changes'); },
    async createTree() { mutationCalls += 1; },
    async createCommit() { mutationCalls += 1; },
    async replaceBranch() { mutationCalls += 1; },
  };
  await assert.rejects(
    () => coalesceGithubMechanicalChangeset({ repo: 'example/project', branch: 'work/coalescing-contract', expected_head: expectedHead, changes: [{ path: 'example.txt', operation: 'update', content: 'next\n' }], commit_message: 'format: normalize example' }, { github }),
    (error) => error?.code === 'HEAD_MISMATCH' && error?.details?.may_have_mutated === false,
  );
  assert.equal(mutationCalls, 0);
});

test('mechanical coalescing rejects a non-mechanical parent before mutation', async () => {
  const expectedHead = 'c'.repeat(40);
  let mutationCalls = 0;
  const github = {
    async getBranch() { return { sha: expectedHead }; },
    async getCommit() { return { sha: expectedHead, tree_sha: 'd'.repeat(40), message: 'feat: substantive work', parents: ['e'.repeat(40)] }; },
    async getPathEntries() { throw new Error('must not plan non-mechanical parent'); },
    async createTree() { mutationCalls += 1; },
    async createCommit() { mutationCalls += 1; },
    async replaceBranch() { mutationCalls += 1; },
  };
  await assert.rejects(
    () => coalesceGithubMechanicalChangeset({ repo: 'example/project', branch: 'work/coalescing-contract', expected_head: expectedHead, changes: [{ path: 'example.txt', operation: 'update', content: 'next\n' }], commit_message: 'format: normalize example' }, { github }),
    (error) => error?.code === 'MECHANICAL_COALESCE_PARENT_NOT_MECHANICAL' && error?.details?.may_have_mutated === false,
  );
  assert.equal(mutationCalls, 0);
});

test('atomic ref replacement classifies explicit GraphQL rejection as not mutated', async () => {
  const apiClient = {
    async call(provider, request) {
      if (request.method === 'GET') return { status: 200, body: { node_id: 'R_example' }, headers: {} };
      return { status: 200, body: { errors: [{ message: 'beforeOid does not match' }] }, headers: {} };
    },
  };
  const github = createGithubApiAdapter(apiClient);
  await assert.rejects(
    () => github.replaceBranch('example/project', 'work/coalescing-contract', '1'.repeat(40), '2'.repeat(40)),
    (error) => error?.code === 'GITHUB_REF_REJECTED' && error?.details?.may_have_mutated === false,
  );
});

test('atomic ref replacement preserves possible mutation on transport loss', async () => {
  const apiClient = {
    async call(provider, request) {
      if (request.method === 'GET') return { status: 200, body: { node_id: 'R_example' }, headers: {} };
      throw Object.assign(new Error('connection lost after send'), { status: 0 });
    },
  };
  const github = createGithubApiAdapter(apiClient);
  await assert.rejects(
    () => github.replaceBranch('example/project', 'work/coalescing-contract', '3'.repeat(40), '4'.repeat(40)),
    (error) => error?.code === 'GITHUB_TRANSPORT_ERROR' && error?.details?.may_have_mutated === true,
  );
});
