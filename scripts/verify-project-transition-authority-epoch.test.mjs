import test from 'node:test';
import assert from 'node:assert/strict';

import { createExecutionAuthorityService } from '../lib/execution-authority-core.js';

const leaseRef = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId = 'run-project-transition';
const repository = 'laurajoyhutchins/overcenter';

function fixture(currentEpoch) {
  const lease = {
    lease_id:leaseRef,
    work_ref:'project_transition:overcenter:transition-a',
    gate:'project_transition',
    run_id:runId,
    status:'active',
    expires_at:'2026-09-01T21:30:00Z',
    hard_expires_at:'2026-09-01T22:00:00Z',
    claim_receipt:{
      subject:'project_transition',
      project_transition:{
        project_ref:'github:laurajoyhutchins/overcenter',
        transition_id:'transition-a',
        repository,
        authority_revision:'1'.repeat(40),
        graph_fingerprint:'f'.repeat(64),
        transition_definition_fingerprint:'d'.repeat(64),
        authority_epoch:1,
      },
    },
  };
  let authorityReads = 0;
  const store = {
    async getLeaseById(id) { return id === leaseRef ? lease : null; },
    async getLeaseByTokenHash() { return null; },
  };
  const projectTransitions = {
    async require() {
      authorityReads += 1;
      return {
        ok:true,
        lease_ref:leaseRef,
        subject:'project_transition',
        run_id:runId,
        authority_epoch:currentEpoch,
        project_ref:'github:laurajoyhutchins/overcenter',
        transition_id:'transition-a',
        repository,
        authority:{ kind:'github', repository, revision:'1'.repeat(40), derivation:'overcenter-project-graph-v1' },
        graph_fingerprint:'f'.repeat(64),
        transition_definition_fingerprint:'d'.repeat(64),
      };
    },
  };
  return {
    service:createExecutionAuthorityService({ store, projectTransitions, now:() => '2026-09-01T21:00:00Z' }),
    authorityReads:() => authorityReads,
  };
}

test('project transition execution authority returns the compact authority epoch', async () => {
  const f = fixture(1);
  const authority = await f.service.require({ lease_ref:leaseRef, repository });
  assert.equal(authority.subject, 'project_transition');
  assert.equal(authority.authority_epoch, 1);
  assert.equal(f.authorityReads(), 1);
});

test('project transition execution authority rejects a stale issued epoch', async () => {
  const f = fixture(2);
  await assert.rejects(
    f.service.require({ lease_ref:leaseRef, repository }),
    error => error?.code === 'EXECUTION_AUTHORITY_STALE'
      && error?.details?.issued_authority_epoch === 1
      && error?.details?.current_authority_epoch === 2,
  );
  assert.equal(f.authorityReads(), 1);
});
