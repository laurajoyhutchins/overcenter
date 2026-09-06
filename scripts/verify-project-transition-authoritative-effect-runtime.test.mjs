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

test('authoritative-effect confirmation survives requeue after the candidate advances project authority', async () => {
  const previousAuthority = '0'.repeat(40);
  const historicalBranch = 'work/transition-1-historical';
  const currentBranch = 'work/transition-1-current';
  const { service } = fixture({
    async deriveWorkspace(authority) {
      const revision = authority.authority.revision;
      return {
        repository:'laurajoyhutchins/overcenter',
        branch: revision === previousAuthority ? historicalBranch : currentBranch,
        authority_revision:revision,
      };
    },
    async readPullRequests() {
      return [{
        number:600,
        state:'closed',
        merged_at:'2026-09-06T02:10:30Z',
        merge_commit_sha:SHA.merge,
        head:{ sha:SHA.candidate, ref:historicalBranch },
        base:{ ref:'dev', sha:previousAuthority },
      }];
    },
  });

  const result = await service.confirm({
    run_id:'run-1',
    target:{ project_ref:'github:laurajoyhutchins/overcenter', horizon:{ kind:'transition', ref:'transition-1' } },
    execution_result:executionResult,
  });

  assert.equal(result.confirmed, true);
});
