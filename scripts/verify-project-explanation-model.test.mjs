import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveProjectExplanation, queryProjectExplanation } from '../lib/project-explanation-model.js';
const REV = 'a'.repeat(40);
const OLD_REV = 'b'.repeat(40);
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
  const input = { project_ref:'github:example/project', authority_revision:REV, nodes:nodes() };
  const result = deriveProjectExplanation(input);
  assert.deepEqual(result.transitions.find((item) => item.id === 'leaf').blockers, ['foundation','left','shared']);
  assert.equal(result.transitions.find((item) => item.id === 'foundation').impact.count, 4);
  assert.deepEqual(result.summary.highest_impact_blockers, ['foundation','shared','left']);
  assert.deepEqual(result, deriveProjectExplanation(input));
});

test('projects occupied, suspended, and unknown runtime state without guessing', () => {
  const result = deriveProjectExplanation({ project_ref:'github:example/project', authority_revision:REV, nodes:nodes(), runtime_by_transition:{
    foundation:{ occupancy:{ occupied:false, suspended:true, wait_reason:'blocked_settlement_promotion', authority_revision:REV, lease_ref:'lease-foundation' } },
    occupied:{ occupancy:{ occupied:true, suspended:false, authority_revision:REV, lease_ref:'lease-occupied' } },
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

test('binds explanation provenance to exact graph authority, runtime identities, and evidence refs', () => {
  const result = deriveProjectExplanation({ project_ref:'github:example/project', authority_revision:REV, nodes:nodes(), runtime_by_transition:{ occupied:{
    occupancy:{ occupied:true, authority_revision:REV, lease_ref:'lease-occupied' },
    execution:{ authority_revision:REV, run_id:'run-42' },
    evidence:[{ kind:'test', ref:'github:example/project@'+REV+':test-proof', authority_revision:REV }],
  }}});
  const occupied = result.transitions.find((item) => item.id === 'occupied');
  assert.deepEqual(occupied.evidence, [
    { kind:'graph', subject:'transition:occupied', authority_revision:REV, ref:'github:example/project@'+REV+'#transition:occupied' },
    { kind:'occupancy', subject:'transition:occupied', authority_revision:REV, identity:'lease-occupied' },
    { kind:'execution', subject:'transition:occupied', authority_revision:REV, identity:'run-42' },
    { kind:'evidence', subject:'transition:occupied', authority_revision:REV, ref:'github:example/project@'+REV+':test-proof' },
  ]);
});

test('marks stale facts and prevents stale occupancy from establishing project truth', () => {
  const result = deriveProjectExplanation({ project_ref:'github:example/project', authority_revision:REV, nodes:nodes(), runtime_by_transition:{ occupied:{
    occupancy:{ occupied:true, authority_revision:OLD_REV, lease_ref:'stale-lease' }, confirmation:{ status:'confirmed', authority_revision:REV }, evidence:[{ kind:'test', ref:'x', authority_revision:OLD_REV }],
  }}});
  const occupied = result.transitions.find((item) => item.id === 'occupied');
  assert.equal(occupied.status, 'ready');
  assert.equal(occupied.runtime_state, 'unknown');
  assert.deepEqual(occupied.stale, { value:true, facts:['evidence','occupancy'] });
  assert.equal(occupied.evidence.find((item) => item.kind === 'occupancy').authority_revision, OLD_REV);
  assert.equal(occupied.evidence.find((item) => item.kind === 'evidence').authority_revision, OLD_REV);
});

test('derives deterministic change explanations between exact authority revisions', () => {
  const previousNodes = nodes().map((node) => node.id === 'foundation' ? { ...node, state:'WAITING', unmet_requirements:[] } : node);
  const input = {
    project_ref:'github:example/project', authority_revision:REV, nodes:nodes(),
    previous:{ authority_revision:OLD_REV, nodes:previousNodes, runtime_by_transition:{} },
  };
  const result = deriveProjectExplanation(input);
  const foundation = result.transitions.find((item) => item.id === 'foundation');
  assert.deepEqual(foundation.changed, { value:true, from_authority_revision:OLD_REV, facts:['status'] });
  assert.deepEqual(result.summary.changed, ['foundation']);
  assert.deepEqual(result, deriveProjectExplanation(input));
});

test('exposes bounded typed project and transition queries without prose authority', () => {
  const input = { project_ref:'github:example/project', authority_revision:REV, nodes:nodes() };
  const transition = queryProjectExplanation(input, { kind:'transition', transition_id:'occupied' });
  assert.equal(transition.schema, 'project-explanation-query-v1');
  assert.deepEqual(transition.query, { kind:'transition', transition_id:'occupied' });
  assert.equal(transition.project_ref, 'github:example/project');
  assert.equal(transition.authority_revision, REV);
  assert.equal(transition.result.id, 'occupied');
  assert.equal(transition.result.status, 'ready');
  assert.equal('transitions' in transition, false);

  const project = queryProjectExplanation(input, { kind:'project' });
  assert.deepEqual(project.query, { kind:'project' });
  assert.deepEqual(project.result.ready, ['foundation','occupied']);
  assert.equal('transitions' in project.result, false);
});
