import test from 'node:test';
import assert from 'node:assert/strict';

import { projectTransitionAuthoritativeEffectConfirmationFor } from '../lib/project-transition-authoritative-effect.js';

const SHA = Object.freeze({
  authority:'1111111111111111111111111111111111111111',
  candidate:'2222222222222222222222222222222222222222',
  merge:'3333333333333333333333333333333333333333',
  development:'4444444444444444444444444444444444444444',
});

const executionResult = Object.freeze({
  disposition:'completed',
  evidence:Object.freeze([
    Object.freeze({ kind:'candidate_revision', ref:`github:laurajoyhutchins/overcenter@${SHA.candidate}` }),
    Object.freeze({ kind:'verification', ref:'exact-revision-tests:passed' }),
  ]),
});

function fixture(overrides = {}) {
  let integrated = false;
  const calls = [];
  const service = projectTransitionAuthoritativeEffectConfirmationFor({
    async readLeaseRef() { return 'lease-1'; },
    executionAuthority:{
      async require() {
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
    async resolveBranchRoles() { return { development_branch:'dev' }; },
    async readPullRequests() {
      calls.push('readPullRequests');
      return [integrated
        ? { number:599, state:'closed', merged_at:'2026-09-05T23:59:00Z', merge_commit_sha:SHA.merge, head:{ sha:SHA.candidate, ref:'work/transition-1-abc' }, base:{ ref:'dev' } }
        : { number:599, state:'open', merged_at:null, merge_commit_sha:null, head:{ sha:SHA.candidate, ref:'work/transition-1-abc' }, base:{ ref:'dev' } }];
    },
    async readBranchHead() {
      calls.push('readBranchHead');
      return integrated ? SHA.development : SHA.authority;
    },
    async compareCommits() { return { status:'ahead', behind_by:0 }; },
    async integrateCandidate() {
      calls.push('integrateCandidate');
      integrated = true;
      return {
        ok:false,
        error:'GITHUB_INTEGRATION_INDETERMINATE',
        message:'transport lost after merge submission',
        phase:'merge_direct',
        may_have_mutated:true,
      };
    },
    ...overrides,
  });
  return { service, calls, setIntegrated(value) { integrated = value; } };
}

function request() {
  return {
    run_id:'run-1',
    target:{ project_ref:'github:laurajoyhutchins/overcenter', horizon:{ kind:'transition', ref:'transition-1' } },
    execution_result:executionResult,
  };
}

test('indeterminate integration reconciles authoritative GitHub readback before any retry', async () => {
  const { service, calls } = fixture();
  const result = await service.confirm(request());

  assert.equal(result.confirmed, true);
  assert.equal(calls.filter((call) => call === 'integrateCandidate').length, 1, 'indeterminate integration must not be blindly replayed');
  assert.ok(calls.filter((call) => call === 'readPullRequests').length >= 2, 'authoritative PR state must be re-read after uncertain mutation');
  assert.ok(result.evidence.some((entry) => entry.kind === 'authority_readback' && entry.ref.endsWith(`@${SHA.development}`)));
});

test('uncertain integration that is still absent remains pending after reconciliation rather than retrying', async () => {
  let integrationCalls = 0;
  let reads = 0;
  const { service } = fixture({
    async readPullRequests() {
      reads += 1;
      return [{ number:599, state:'open', merged_at:null, merge_commit_sha:null, head:{ sha:SHA.candidate, ref:'work/transition-1-abc' }, base:{ ref:'dev' } }];
    },
    async readBranchHead() { return SHA.authority; },
    async integrateCandidate() {
      integrationCalls += 1;
      return { ok:false, error:'GITHUB_INTEGRATION_INDETERMINATE', phase:'merge_direct', may_have_mutated:true };
    },
  });

  const result = await service.confirm(request());
  assert.equal(result.confirmed, false);
  assert.equal(result.reason, 'authoritative_effect_pending');
  assert.equal(result.mutation_certainty, 'possible');
  assert.equal(result.recovery?.mechanism, 'github_integration_reconcile');
  assert.equal(integrationCalls, 1);
  assert.ok(reads >= 2, 'indeterminate effect must be reconciled by readback before any future retry');
});

test('already-integrated candidate continues idempotently without a duplicate integration mutation', async () => {
  let integrationCalls = 0;
  const { service, setIntegrated } = fixture({
    async integrateCandidate() {
      integrationCalls += 1;
      return { ok:true, outcome:'merged', merge_commit_sha:SHA.merge };
    },
  });
  setIntegrated(true);

  const result = await service.confirm(request());
  assert.equal(result.confirmed, true);
  assert.equal(integrationCalls, 0);
});
