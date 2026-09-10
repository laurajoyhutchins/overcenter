import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveProjectExplanation } from '../lib/project-explanation-model.js';
const REV = 'a'.repeat(40);
function nodes() { return [
  { id:'foundation', state:'READY', requires:[], unmet_requirements:[] },
  { id:'shared', state:'WAITING', requires:['foundation'], unmet_requirements:['foundation'] },
  { id:'left', state:'WAITING', requires:['shared'], unmet_requirements:['shared'] },
  { id:'right', state:'WAITING', requires:['shared'], unmet_requirements:['shared'] },
  { id:'leaf', state:'WAITING', requires:['left'], unmet_requirements:['left'] },
  { id:'occupied', state:'READY', requires:[], unmet_requirements:[] },
  { id:'faulted', state:'OFF_NOMINAL', requires:[], unmet_requirements:[] },
  { id:'done', state:'DONE', requires:[], unmet_requirements:[] },
]; }

test('derives multi-hop blockers, shared prerequisites, impact, and deterministic replay', () => {
  const result = deriveProjectExplanation({ project_ref:'github:example/project', authority_revision:REV, nodes:nodes() });
  assert.deepEqual(result.transitions.find((item) => item.id === 'leaf').blockers, ['foundation','left','shared']);
  assert.equal(result.transitions.find((item) => item.id === 'foundation').impact.count, 4);
  assert.deepEqual(result.summary.highest_impact_blockers, ['foundation','shared','left']);
  assert.deepEqual(result, deriveProjectExplanation({ project_ref:'github:example/project', authority_revision:REV, nodes:nodes() }));
});

test('projects occupied, suspended, and unknown runtime state without guessing', () => {
  const result = deriveProjectExplanation({ project_ref:'github:example/project', authority_revision:REV, nodes:nodes(), runtime_by_transition:{
    foundation:{ occupancy:{ occupied:false, suspended:true, wait_reason:'blocked_settlement_promotion', authority_revision:REV } },
    occupied:{ occupancy:{ occupied:true, suspended:false, authority_revision:REV } },
  }});
  const foundation = result.transitions.find((item) => item.id === 'foundation');
  const occupied = result.transitions.find((item) => item.id === 'occupied');
  const faulted = result.transitions.find((item) => item.id === 'faulted');
  assert.equal(foundation.status, 'waiting');
  assert.deepEqual(foundation.reason, { kind:'blocked_settlement_promotion', subjects:['foundation'] });
  assert.equal(occupied.status, 'working');
  assert.equal(faulted.status, 'blocked');
  assert.equal(faulted.runtime_state, 'unknown');
});

test('marks stale facts and prevents stale occupancy from establishing project truth', () => {
  const old = 'b'.repeat(40);
  const result = deriveProjectExplanation({ project_ref:'github:example/project', authority_revision:REV, nodes:nodes(), runtime_by_transition:{ occupied:{
    occupancy:{ occupied:true, authority_revision:old }, confirmation:{ status:'confirmed', authority_revision:REV }, evidence:[{ kind:'test', ref:'x', authority_revision:old }],
  }}});
  const occupied = result.transitions.find((item) => item.id === 'occupied');
  assert.equal(occupied.status, 'ready');
  assert.equal(occupied.runtime_state, 'unknown');
  assert.deepEqual(occupied.stale, { value:true, facts:['evidence','occupancy'] });
  assert.deepEqual(occupied.evidence, [
    { kind:'graph', subject:'transition:occupied' }, { kind:'occupancy', subject:'transition:occupied' },
    { kind:'confirmation', subject:'transition:occupied' }, { kind:'evidence', subject:'transition:occupied' },
  ]);
});
