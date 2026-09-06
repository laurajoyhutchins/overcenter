import test from 'node:test';
import assert from 'node:assert/strict';

import { projectTransitionAuthoritativeEffectConfirmationFor } from '../lib/project-transition-authoritative-effect.js';

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
  const integrations = [];
  const { service } = fixture({
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
  const integrations = [];
  const { service } = fixture({
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