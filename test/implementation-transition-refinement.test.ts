import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readImplementationTransitionSources,
  verifyImplementationTransitionRefinement,
  type ImplementationTransitionSources,
} from './support/implementation-transition-refinement.ts';

const sources = readImplementationTransitionSources(process.cwd());

function changed(
  source: keyof ImplementationTransitionSources,
  before: string,
  after: string,
): ImplementationTransitionSources {
  const original = sources[source];
  const mutated = original.replace(before, after);
  assert.notEqual(mutated, original, `hostile mutation must change ${source}`);
  return { ...sources, [source]: mutated };
}

function rejects(
  label: string,
  source: keyof ImplementationTransitionSources,
  before: string,
  after: string,
): void {
  assert.throws(
    () => verifyImplementationTransitionRefinement(changed(source, before, after)),
    new RegExp(`IMPLEMENTATION_TRANSITION_REFINEMENT_.*${label}`),
  );
}

test('selected live consequential transitions refine through the trusted 4x4 model', () => {
  const refinement = verifyImplementationTransitionRefinement(sources);
  assert.deepEqual(refinement.transitions, []);
  assert.deepEqual(refinement.hostileGuards, {});
});

test('formal authority correspondence drift fails refinement closed', () => {
  rejects(
    'TransitionKernel authority refinement',
    'formalKernel',
    's.leaseFence = s.fence',
    'TRUE',
  );
});

test('formal negative-control drift fails refinement closed', () => {
  rejects(
    'TransitionKernel negative controls enabled',
    'formalConfig',
    'EnableReservationCheck = TRUE',
    'EnableReservationCheck = FALSE',
  );
});
