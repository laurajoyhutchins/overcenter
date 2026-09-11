import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRODUCTIVE_STAGES,
  OPERATING_CONDITIONS,
  STAGE_COMMANDS,
  successfulStageResponsibilities,
  resolveCompletedStage,
  resolveWorkLifecycle,
  resolveLifecycleAfterRecovery,
} from './work-lifecycle.js';
import {
  LEGACY_LANE_BY_STAGE,
  STAGE_BY_LEGACY_LANE,
  legacyProjectionForStage,
} from './legacy-lane-compatibility.js';

function factsFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [stage, { applicable: true, satisfied: stageIndex < index }]));
}
function doneFacts() { return Object.fromEntries(PRODUCTIVE_STAGES.map((stage) => [stage, { applicable:true, satisfied:true }])); }

test('canonical productive stages and commands are exact', () => {
  assert.deepEqual(PRODUCTIVE_STAGES, ['ENABLE','ACQUIRE','EXECUTE','COMMIT','CONFIRM']);
  assert.deepEqual(Object.values(STAGE_COMMANDS), ['work.enable','work.acquire','work.execute','work.commit','work.confirm']);
});

test('all twenty directed productive transitions emerge from one resolver', () => {
  let count = 0;
  for (const from of PRODUCTIVE_STAGES) for (const to of PRODUCTIVE_STAGES) if (from !== to) {
    const result = resolveWorkLifecycle({ current_stage:from, responsibilities:factsFor(to) });
    assert.equal(result.next_stage, to, `${from}->${to} resolved to ${result.next_stage}`);
    count += 1;
  }
  assert.equal(count, 20);
});

test('forward skip is derived from satisfied responsibilities', () => {
  const result = resolveWorkLifecycle({ current_stage:'ENABLE', responsibilities:factsFor('COMMIT') });
  assert.equal(result.next_stage, 'COMMIT');
  assert.equal(result.transition_kind, 'forward_bypass');
});

test('feedback transition is derived from newly unsatisfied responsibility', () => {
  const result = resolveWorkLifecycle({ current_stage:'CONFIRM', responsibilities:factsFor('ACQUIRE') });
  assert.equal(result.next_stage, 'ACQUIRE');
  assert.equal(result.transition_kind, 'feedback');
});

test('all satisfied responsibilities resolve to DONE', () => {
  const result = resolveWorkLifecycle({ current_stage:'CONFIRM', responsibilities:doneFacts() });
  assert.equal(result.complete, true);
  assert.equal(result.next_stage, 'DONE');
  assert.equal(result.command, null);
});

test('not-applicable responsibilities are skipped', () => {
  const facts = doneFacts();
  facts.ACQUIRE = { applicable:false, satisfied:false };
  facts.EXECUTE = { applicable:true, satisfied:false };
  assert.equal(resolveWorkLifecycle({ current_stage:'ENABLE', responsibilities:facts }).next_stage, 'EXECUTE');
});

test('off-nominal conditions preserve productive responsibility', () => {
  for (const condition of OPERATING_CONDITIONS.filter((value) => value !== 'NOMINAL')) {
    const result = resolveWorkLifecycle({ current_stage:'EXECUTE', condition, responsibilities:factsFor('COMMIT') });
    assert.equal(result.condition, condition);
    assert.equal(result.next_stage, 'EXECUTE');
    assert.equal(result.transition_kind, 'off_nominal');
  }
});

test('recovery performs fresh resolution rather than returning to prior stage', () => {
  assert.equal(resolveLifecycleAfterRecovery({ current_stage:'EXECUTE', condition:'NOMINAL', responsibilities:factsFor('ACQUIRE') }).next_stage, 'ACQUIRE');
});

test('invalid stage condition and responsibility input fail closed', () => {
  for (const invoke of [
    () => resolveWorkLifecycle({ current_stage:'MAGIC', responsibilities:doneFacts() }),
    () => resolveWorkLifecycle({ current_stage:'ENABLE', condition:'MAYBE', responsibilities:doneFacts() }),
    () => resolveWorkLifecycle({ current_stage:'ENABLE', responsibilities:{ ...doneFacts(), MAGIC:{ applicable:true, satisfied:false } } }),
  ]) assert.throws(invoke);
});

test('completed stage defaults to the next productive responsibility', () => {
  assert.equal(resolveCompletedStage({ current_stage:'ACQUIRE' }).next_stage, 'EXECUTE');
  assert.equal(resolveCompletedStage({ current_stage:'EXECUTE' }).next_stage, 'COMMIT');
  assert.equal(resolveCompletedStage({ current_stage:'COMMIT' }).next_stage, 'CONFIRM');
  assert.equal(resolveCompletedStage({ current_stage:'CONFIRM' }).next_stage, 'DONE');
  assert.equal(successfulStageResponsibilities('EXECUTE').EXECUTE.satisfied, true);
  assert.equal(successfulStageResponsibilities('EXECUTE').COMMIT.satisfied, false);
});

test('caller reports facts rather than a successor', () => {
  const result = resolveCompletedStage({ current_stage:'CONFIRM', lifecycle_facts:{ responsibilities:factsFor('EXECUTE') } });
  assert.equal(result.next_stage, 'EXECUTE');
  assert.equal(result.transition_kind, 'feedback');
  assert.throws(() => resolveCompletedStage({ current_stage:'EXECUTE', lifecycle_facts:{ next_stage:'CONFIRM', responsibilities:factsFor('CONFIRM') } }));
});

test('legacy lanes are projection-only mappings from canonical stages', () => {
  assert.equal(LEGACY_LANE_BY_STAGE.ENABLE, 'lane:enable');
  assert.equal(LEGACY_LANE_BY_STAGE.ACQUIRE, 'lane:source-implementation');
  assert.equal(LEGACY_LANE_BY_STAGE.EXECUTE, 'lane:repo-implementation');
  assert.equal(LEGACY_LANE_BY_STAGE.COMMIT, 'lane:integration');
  assert.equal(LEGACY_LANE_BY_STAGE.CONFIRM, 'lane:verification');
  assert.equal(STAGE_BY_LEGACY_LANE['lane:verification'], 'CONFIRM');
  assert.equal(legacyProjectionForStage('DONE', 'lane:verification').state, 'Done');
});
