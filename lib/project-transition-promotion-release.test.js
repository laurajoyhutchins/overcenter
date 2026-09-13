import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectTransitionLeaseService } from './project-transition-leases.js';

const projectRef = 'github:laurajoyhutchins/overcenter';
const revision = '1'.repeat(40);
const transition = {
  id:'transition-a', priority:1, requires:[],
  lifecycle:{ current_stage:'ENABLE', responsibilities:{} },
  executor:{ kind:'agent', role:'engineering', skill:'implementation' },
  phase_bindings:{},
};
const graph = {
  schema:'project-graph-authority-v1', project_ref:projectRef,
  authority:{ definition:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision, derivation:'overcenter-project-graph-v1' }, observations:[] },
  nodes:[transition], horizons:[],
};

function fixture() {
  const releases = new Map();
  const latest = {
    lease_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    project_ref:projectRef,
    transition_id:'transition-a',
    disposition:'blocked',
    authority_revision:revision,
    transition_revision_fingerprint:null,
    transition_dependency_fingerprint:null,
    settlement_promotion_condition:'exact verification becomes authoritative',
    settlement_reason:'waiting for exact verification',
    settled_at:'2026-09-13T12:00:00Z',
  };
  const store = {
    async getRun(){ return null; }, async getLease(){ return null; }, async getLeaseByAcquireIdempotency(){ return null; },
    async getSlot(){ return null; }, async insertLease(){}, async insertSlot(){}, async updateLease(){}, async deleteSlot(){},
    async getLatestSettledLeaseForTransition(){ return latest; },
    async getPromotionRelease(leaseId){ return releases.get(leaseId) || null; },
    async insertPromotionRelease(leaseId, row){ if (!releases.has(leaseId)) releases.set(leaseId, row); return releases.get(leaseId); },
  };
  return { service:createProjectTransitionLeaseService({ store, readProjectGraph:async()=>graph }), latest, releases };
}

test('promotion release is exact, durable, idempotent, and removes the matching suspension', async () => {
  const { service } = fixture();
  const suspension = await service.suspensionFor({ project_ref:projectRef, transition_id:'transition-a' });
  assert.ok(suspension, 'expected blocked settlement suspension');
  const input = {
    project_ref:projectRef,
    transition_id:'transition-a',
    recovery_ref:suspension.recovery_ref,
    blocked_lease_ref:suspension.blocked_lease_ref,
    authority_revision:suspension.authority_revision,
    transition_revision_fingerprint:suspension.conditions.transition_revision_fingerprint,
    transition_dependency_fingerprint:suspension.conditions.transition_dependency_fingerprint,
    evidence:[{ kind:'check-run', ref:'github-check:123' }],
    idempotency_key:'promote-1',
  };
  const first = await service.releaseSuspension(input);
  assert.equal(first.released, true);
  assert.equal(first.idempotent_replay, false);
  const replay = await service.releaseSuspension(input);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(await service.suspensionFor({ project_ref:projectRef, transition_id:'transition-a' }), null);
});

test('promotion release fails closed for stale recovery identity and conflicting replay', async () => {
  const { service } = fixture();
  const suspension = await service.suspensionFor({ project_ref:projectRef, transition_id:'transition-a' });
  const exact = {
    project_ref:projectRef, transition_id:'transition-a', recovery_ref:suspension.recovery_ref,
    blocked_lease_ref:suspension.blocked_lease_ref, authority_revision:suspension.authority_revision,
    transition_revision_fingerprint:suspension.conditions.transition_revision_fingerprint,
    transition_dependency_fingerprint:suspension.conditions.transition_dependency_fingerprint,
    evidence:[{ kind:'check-run', ref:'github-check:123' }], idempotency_key:'promote-2',
  };
  await assert.rejects(() => service.releaseSuspension({ ...exact, recovery_ref:'project-transition-suspension:stale' }), { code:'PROJECT_TRANSITION_SUSPENSION_STALE' });
  await service.releaseSuspension(exact);
  await assert.rejects(() => service.releaseSuspension({ ...exact, evidence:[{ kind:'check-run', ref:'github-check:456' }] }), { code:'PROJECT_TRANSITION_IDEMPOTENCY_CONFLICT' });
});
