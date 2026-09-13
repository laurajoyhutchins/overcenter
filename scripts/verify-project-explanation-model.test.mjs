import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveProjectExplanation, queryProjectExplanation } from '../lib/project-explanation-model.js';

const REV = 'a'.repeat(40);
const OLD_REV = 'b'.repeat(40);

function nodes() {
  return [
    { id:'foundation', state:'READY', requires:[], unmet_requirements:[] },
    { id:'shared', state:'WAITING', requires:['foundation'], unmet_requirements:['foundation'] },
    { id:'leaf', state:'WAITING', requires:['shared'], unmet_requirements:['shared'] },
    { id:'occupied', state:'READY', requires:[], unmet_requirements:[] },
    { id:'faulted', state:'OFF_NOMINAL', requires:[], unmet_requirements:[] },
    { id:'done', state:'DONE', requires:[], unmet_requirements:[] },
  ];
}

test('derives blockers and downstream impact deterministically', () => {
  const input = { project_ref:'github:example/project', authority_revision:REV, nodes:nodes() };
  const result = deriveProjectExplanation(input);
  assert.deepEqual(result.transitions.find((item) => item.id === 'leaf').blockers, ['foundation','shared']);
  assert.equal(result.transitions.find((item) => item.id === 'foundation').impact.count, 2);
  assert.deepEqual(result, deriveProjectExplanation(input));
});

test('projects current occupancy and suspension without treating stale runtime as truth', () => {
  const result = deriveProjectExplanation({
    project_ref:'github:example/project',
    authority_revision:REV,
    nodes:nodes(),
    runtime_by_transition:{
      foundation:{ occupancy:{ occupied:false, suspended:true, suspension_reason:'blocked_settlement_promotion', authority_revision:REV, lease_ref:'lease-foundation' } },
      occupied:{ occupancy:{ occupied:true, authority_revision:OLD_REV, lease_ref:'stale-lease' } },
    },
  });
  const foundation = result.transitions.find((item) => item.id === 'foundation');
  const occupied = result.transitions.find((item) => item.id === 'occupied');
  assert.equal(foundation.status, 'waiting');
  assert.deepEqual(foundation.reason, { kind:'blocked_settlement_promotion', subjects:['foundation'] });
  assert.equal(occupied.status, 'ready');
  assert.deepEqual(occupied.stale, { value:true, facts:['occupancy'] });
});

test('binds explanation evidence to exact authority and runtime identity', () => {
  const result = deriveProjectExplanation({
    project_ref:'github:example/project', authority_revision:REV, nodes:nodes(),
    runtime_by_transition:{ occupied:{ occupancy:{ occupied:true, authority_revision:REV, lease_ref:'lease-occupied' } } },
  });
  const occupied = result.transitions.find((item) => item.id === 'occupied');
  assert.deepEqual(occupied.evidence.slice(0, 2), [
    { kind:'graph', subject:'transition:occupied', authority_revision:REV, ref:`github:example/project@${REV}#transition:occupied` },
    { kind:'occupancy', subject:'transition:occupied', authority_revision:REV, identity:'lease-occupied' },
  ]);
});

test('exposes bounded typed project and transition queries', () => {
  const input = { project_ref:'github:example/project', authority_revision:REV, nodes:nodes() };
  const transition = queryProjectExplanation(input, { kind:'transition', transition_id:'foundation' });
  assert.equal(transition.schema, 'project-explanation-query-v1');
  assert.equal(transition.result.id, 'foundation');
  assert.equal('transitions' in transition, false);
  const project = queryProjectExplanation(input, { kind:'project' });
  assert.deepEqual(project.result.ready, ['foundation','occupied']);
  assert.equal('transitions' in project.result, false);
});
