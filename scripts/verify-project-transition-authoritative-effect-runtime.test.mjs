import test from 'node:test';
import assert from 'node:assert/strict';

import { projectTransitionAuthoritativeEffectConfirmationFor } from '../lib/project-transition-authoritative-effect.js';
import { resolveActiveProjectTransitionLeaseRef } from '../lib/project-transition-authoritative-effect-github-runtime.js';
import { projectTransitionPullRequestDetailNumbers, projectTransitionPullRequestReadQuery } from '../lib/project-transition-authoritative-effect-github-query.js';

test('authoritative-effect runtime resolves active project transition lease from durable lease authority', async () => {
  const queries = [];
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows:[{ lease_ref:'11111111-1111-4111-8111-111111111111' }] };
    },
  };
  const leaseRef = await resolveActiveProjectTransitionLeaseRef(db, 'run-1', '2026-09-09T17:00:00.000Z');
  assert.equal(leaseRef, '11111111-1111-4111-8111-111111111111');
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /FROM execution_state/);
  assert.match(queries[0].sql, /subject_kind\s*=\s*'project_transition'/);
  assert.match(queries[0].sql, /lifecycle\s*=\s*'executing'/);
  assert.match(queries[0].sql, /settled\s*=\s*false/);
  assert.doesNotMatch(queries[0].sql, /FROM work_leases/);
  assert.deepEqual(queries[0].params, ['run-1', '2026-09-09T17:00:00.000Z']);
});

test('authoritative-effect runtime fails closed when durable active lease authority is ambiguous', async () => {
  const db = {
    async query() {
      return { rows:[
        { lease_ref:'11111111-1111-4111-8111-111111111111' },
        { lease_ref:'22222222-2222-4222-8222-222222222222' },
      ] };
    },
  };
  await assert.rejects(
    () => resolveActiveProjectTransitionLeaseRef(db, 'run-1', '2026-09-09T17:00:00.000Z'),
    (error) => error?.code === 'PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_LEASE_AMBIGUOUS',
  );
});

const SHA = {
  authority:'1111111111111111111111111111111111111111',
  candidate:'2222222222222222222222222222222222222222',
  merge:'3333333333333333333333333333333333333333',
  development:'4444444444444444444444444444444444444444',
};

function fixture(overrides = {}) {
  const calls = [];
  const service = projectTransitionAuthoritativeEffectConfirmationFor({
    async readLeaseRef(runId) {
      calls.push(['readLeaseRef', runId]);
      return 'lease-1';
    },
    executionAuthority:{
      async require(input) {
        calls.push(['require', input]);
        return {
          subject:'project_transition',
          lease_ref:'lease-1',
          run_id:'run-1',
          repository:'laurajoyhutchins/overcenter',
          project_ref:'github:laurajoyhutchins/overcenter',
          transition_id:'transition-1',
          transition_definition_fingerprint:'f'.repeat(64),
          authority:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:SHA.authority },
        };
      },
    },
    async deriveWorkspace() {
      return { repository:'laurajoyhutchins/overcenter', branch:'work/transition-1-abc', authority_revision:SHA.authority };
    },
    async resolveBranchRoles() {
      return { development_branch:'dev' };
    },
    async readPullRequests(input) {
      calls.push(['readPullRequests', input]);
      return [{ number:599, state:'closed', merged_at:'2026-09-06T00:49:52Z', merge_commit_sha:SHA.merge, head:{ sha:SHA.candidate, ref:'work/transition-1-abc' }, base:{ ref:'dev' } }];
    },
    async readBranchHead(input) {
      calls.push(['readBranchHead', input]);
      return SHA.development;
    },
    async compareCommits(input) {
      calls.push(['compareCommits', input]);
      return { status:'ahead', behind_by:0 };
    },
    ...overrides,
  });
  return { service, calls };
}

const executionResult = {
  disposition:'completed',
  evidence:[
    { kind:'candidate_revision', ref:`github:laurajoyhutchins/overcenter@${SHA.candidate}` },
    { kind:'verification', ref:'exact-revision-tests:passed' },
  ],
};

test('authoritative-effect confirmation proves an already-integrated exact candidate from fresh GitHub ancestry readback', async () => {
  const { service, calls } = fixture();
  const result = await service.confirm({
    run_id:'run-1',
    target:{ project_ref:'github:laurajoyhutchins/overcenter', horizon:{ kind:'transition', ref:'transition-1' } },
    execution_result:executionResult,
  });

  assert.equal(result.confirmed, true);
  assert.deepEqual(result.evidence, [
    { kind:'authoritative_effect', ref:`github:laurajoyhutchins/overcenter#599@${SHA.merge}` },
    { kind:'authority_readback', ref:`github:laurajoyhutchins/overcenter@${SHA.development}` },
  ]);
  assert.ok(calls.some(([kind, input]) => kind === 'compareCommits' && input.base === SHA.merge && input.head === SHA.development));
});

test('authoritative-effect confirmation proves squash-merged exact candidate by tree identity when provider omits merge commit SHA', async () => {
  const tree = 'a'.repeat(40);
  const { service, calls } = fixture({
    async readPullRequests() {
      return [{ number:599, state:'closed', merged_at:'2026-09-06T00:49:52Z', merge_commit_sha:null, head:{ sha:SHA.candidate, ref:'work/transition-1-abc' }, base:{ ref:'dev' } }];
    },
    async compareCommits(input) {
      calls.push(['compareCommits', input]);
      return {
        status:'diverged',
        behind_by:3,
        base_commit:{ commit:{ tree:{ sha:tree } } },
        commits:[{ sha:SHA.development, commit:{ tree:{ sha:tree } } }],
      };
    },
  });
  const result = await service.confirm({
    run_id:'run-1',
    target:{ project_ref:'github:laurajoyhutchins/overcenter', horizon:{ kind:'transition', ref:'transition-1' } },
    execution_result:executionResult,
  });

  assert.equal(result.confirmed, true);
  assert.deepEqual(result.evidence, [
    { kind:'authoritative_effect', ref:`github:laurajoyhutchins/overcenter#599@${SHA.development}` },
    { kind:'authority_readback', ref:`github:laurajoyhutchins/overcenter@${SHA.development}` },
  ]);
  assert.ok(calls.some(([kind, input]) => kind === 'compareCommits' && input.base === SHA.candidate && input.head === SHA.development));
});

test('authoritative-effect confirmation remains unconfirmed while only the exact candidate exists', async () => {
  const { service } = fixture({
    async readPullRequests() {
      return [{ number:599, state:'open', merged_at:null, merge_commit_sha:null, head:{ sha:SHA.candidate, ref:'work/transition-1-abc' }, base:{ ref:'dev' } }];
    },
  });
  const result = await service.confirm({
    run_id:'run-1',
    target:{ project_ref:'github:laurajoyhutchins/overcenter', horizon:{ kind:'transition', ref:'transition-1' } },
    execution_result:executionResult,
  });
  assert.deepEqual(result, { confirmed:false, reason:'authoritative_effect_not_observed' });
});

test('authoritative-effect confirmation deterministically integrates an exact open candidate before authoritative readback', async () => {
  let reads = 0;
  let headReads = 0;
  const integrations = [];
  const { service } = fixture({
    async readBranchHead() {
      headReads += 1;
      return headReads === 1 ? SHA.authority : SHA.development;
    },
    async readPullRequests() {
      reads += 1;
      if (reads === 1) return [{ number:599, state:'open', merged_at:null, merge_commit_sha:null, head:{ sha:SHA.candidate, ref:'work/transition-1-abc' }, base:{ ref:'dev' } }];
      return [{ number:599, state:'closed', merged_at:'2026-09-06T00:49:52Z', merge_commit_sha:SHA.merge, head:{ sha:SHA.candidate, ref:'work/transition-1-abc' }, base:{ ref:'dev' } }];
    },
    async integrateCandidate(input) {
      integrations.push(input);
      return { ok:true, outcome:'merged', merge_commit_sha:SHA.merge };
    },
  });
  const result = await service.confirm({
    run_id:'run-1',
    target:{ project_ref:'github:laurajoyhutchins/overcenter', horizon:{ kind:'transition', ref:'transition-1' } },
    execution_result:executionResult,
  });
  assert.equal(integrations.length, 1);
  assert.deepEqual(integrations[0], {
    repository:'laurajoyhutchins/overcenter',
    pull_request:599,
    workspace_branch:'work/transition-1-abc',
    development_branch:'dev',
    expected_base:SHA.authority,
    expected_head:SHA.candidate,
  });
  assert.equal(result.confirmed, true);
  assert.ok(result.evidence.some((entry) => entry.kind === 'authority_readback' && entry.ref.endsWith(`@${SHA.development}`)));
});

test('authoritative-effect confirmation creates and integrates a missing exact candidate PR without a reasoning boundary', async () => {
  let reads = 0;
  let headReads = 0;
  const integrations = [];
  const { service } = fixture({
    async readBranchHead() {
      headReads += 1;
      return headReads === 1 ? SHA.authority : SHA.development;
    },
    async readPullRequests() {
      reads += 1;
      if (reads === 1) return [];
      return [{ number:600, state:'closed', merged_at:'2026-09-06T00:49:52Z', merge_commit_sha:SHA.merge, head:{ sha:SHA.candidate, ref:'work/transition-1-abc' }, base:{ ref:'dev' } }];
    },
    async integrateCandidate(input) {
      integrations.push(input);
      return { ok:true, outcome:'merged', pull_request:600, merge_commit_sha:SHA.merge };
    },
  });
  const result = await service.confirm({
    run_id:'run-1',
    target:{ project_ref:'github:laurajoyhutchins/overcenter', horizon:{ kind:'transition', ref:'transition-1' } },
    execution_result:executionResult,
  });
  assert.equal(integrations.length, 1);
  assert.deepEqual(integrations[0], {
    repository:'laurajoyhutchins/overcenter',
    pull_request:null,
    workspace_branch:'work/transition-1-abc',
    development_branch:'dev',
    expected_base:SHA.authority,
    expected_head:SHA.candidate,
  });
  assert.equal(result.confirmed, true);
});

test('authoritative-effect confirmation fails closed before integration when the development base moved after candidate verification', async () => {
  let integrations = 0;
  const moved = '5555555555555555555555555555555555555555';
  const { service } = fixture({
    async readPullRequests() { return []; },
    async readBranchHead() { return moved; },
    async integrateCandidate() { integrations += 1; return { ok:true, outcome:'merged' }; },
  });
  const result = await service.confirm({
    run_id:'run-1',
    target:{ project_ref:'github:laurajoyhutchins/overcenter', horizon:{ kind:'transition', ref:'transition-1' } },
    execution_result:executionResult,
  });
  assert.equal(integrations, 0);
  assert.deepEqual(result, { confirmed:false, reason:'authoritative_base_moved', observed_development_head:moved, verified_base:SHA.authority });
});

test('authoritative-effect confirmation refuses to claim completion while deterministic integration is pending', async () => {
  const { service } = fixture({
    async readBranchHead() { return SHA.authority; },
    async readPullRequests() {
      return [{ number:599, state:'open', merged_at:null, merge_commit_sha:null, head:{ sha:SHA.candidate, ref:'work/transition-1-abc' }, base:{ ref:'dev' } }];
    },
    async integrateCandidate() {
      return { ok:true, outcome:'merge_submitted', merge_request_uuid:'merge-1' };
    },
  });
  const result = await service.confirm({
    run_id:'run-1',
    target:{ project_ref:'github:laurajoyhutchins/overcenter', horizon:{ kind:'transition', ref:'transition-1' } },
    execution_result:executionResult,
  });
  assert.deepEqual(result, { confirmed:false, reason:'authoritative_effect_pending', recovery:{ mechanism:'github_integration_reconcile', merge_request_uuid:'merge-1' } });
});

test('GitHub authoritative-effect readback survives workspace drift by scanning bounded base PR history', () => {
  const query = projectTransitionPullRequestReadQuery({ base:'dev' });
  assert.deepEqual(query, { state:'all', base:'dev', per_page:100 });
  assert.equal(Object.hasOwn(query, 'head'), false);
});

test('GitHub authoritative-effect readback hydrates every exact-workspace PR detail before settlement proof', () => {
  const pulls = [
    { number:689, merged_at:'2026-09-07T01:04:30Z', merge_commit_sha:null, head:{ ref:'work/transition-1-prior' } },
    { number:688, merged_at:'2026-09-07T00:31:18Z', merge_commit_sha:SHA.merge, head:{ ref:'work/transition-1-prior' } },
    { number:687, merged_at:null, merge_commit_sha:SHA.merge, head:{ ref:'work/transition-1-prior' } },
    { number:686, merged_at:'2026-09-07T00:15:08Z', merge_commit_sha:null, head:{ ref:'work/other' } },
  ];
  assert.deepEqual(projectTransitionPullRequestDetailNumbers({ pulls, head:'work/transition-1-prior' }), [689,688,687]);
});

test('authoritative-effect confirmation rejects a merged candidate that is not in current development authority', async () => {
  const { service } = fixture({
    async compareCommits() { return { status:'diverged', behind_by:1 }; },
  });
  const result = await service.confirm({
    run_id:'run-1',
    target:{ project_ref:'github:laurajoyhutchins/overcenter', horizon:{ kind:'transition', ref:'transition-1' } },
    execution_result:executionResult,
  });
  assert.deepEqual(result, { confirmed:false, reason:'authoritative_effect_not_in_development' });
});

test('authoritative-effect confirmation accepts the exact merged candidate from a prior lease epoch for the unchanged transition definition', async () => {
  const currentAuthority = {
    subject:'project_transition',
    lease_ref:'lease-2',
    run_id:'run-1',
    repository:'laurajoyhutchins/overcenter',
    project_ref:'github:laurajoyhutchins/overcenter',
    transition_id:'transition-1',
    transition_definition_fingerprint:'f'.repeat(64),
    authority:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:'5555555555555555555555555555555555555555' },
  };
  const historicalAuthority = {
    ...currentAuthority,
    lease_ref:'lease-1',
    run_id:'run-prior',
    authority:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:SHA.authority },
  };
  const service = projectTransitionAuthoritativeEffectConfirmationFor({
    async readLeaseRef() { return 'lease-2'; },
    executionAuthority:{ async require() { return currentAuthority; } },
    async readHistoricalAuthorities(input) {
      assert.deepEqual(input, {
        project_ref:'github:laurajoyhutchins/overcenter',
        transition_id:'transition-1',
        transition_definition_fingerprint:'f'.repeat(64),
      });
      return [historicalAuthority];
    },
    async deriveWorkspace(authority) {
      return authority.lease_ref === 'lease-1'
        ? { repository:'laurajoyhutchins/overcenter', branch:'work/transition-1-prior', authority_revision:SHA.authority }
        : { repository:'laurajoyhutchins/overcenter', branch:'work/transition-1-current', authority_revision:currentAuthority.authority.revision };
    },
    async resolveBranchRoles() { return { development_branch:'dev' }; },
    async readPullRequests({ head }) {
      if (head !== 'work/transition-1-prior') return [];
      return [{ number:615, state:'closed', merged_at:'2026-09-06T02:17:33Z', merge_commit_sha:SHA.merge, head:{ sha:SHA.candidate, ref:head }, base:{ ref:'dev' } }];
    },
    async readBranchHead() { return SHA.development; },
    async compareCommits() { return { status:'ahead', behind_by:0 }; },
  });

  const result = await service.confirm({
    run_id:'run-1',
    target:{ project_ref:'github:laurajoyhutchins/overcenter', horizon:{ kind:'transition', ref:'transition-1' } },
    execution_result:executionResult,
  });

  assert.equal(result.confirmed, true);
  assert.equal(result.evidence[0].ref, `github:laurajoyhutchins/overcenter#615@${SHA.merge}`);
});