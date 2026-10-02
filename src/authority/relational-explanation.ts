import { projectExecutionAuthority } from './transaction-admission.ts';
import type { ExecutionPermit, Run } from '../model.ts';
import { explainRelationalEvent, type RelationalEventExplanation } from './project-state.ts';

export {
  explainRelationalEvent,
  type RelationalEventExplanation,
  type RelationalExplanationInput,
  type RelationalRequirementExplanation,
  type RelationalRequirementState,
} from './project-state.ts';

export function effectAdmissionExplanation(
  run: Run,
  permit: ExecutionPermit,
  capabilitySha256: string,
  unresolvedEffect: boolean,
): RelationalEventExplanation {
  const authority = projectExecutionAuthority(run, permit, capabilitySha256);
  const currentCoordinate = 'effect-admission:current';
  const attemptCoordinate =
    authority.current_authority && authority.exact_revision
      ? currentCoordinate
      : 'effect-admission:stale';
  return explainRelationalEvent(
    {
      coordinates: [...new Set([currentCoordinate, attemptCoordinate])].map((id) => ({ id })),
      objects: [
        { id: 'execution-authority', coordinate: currentCoordinate },
        ...(unresolvedEffect ? [] : [{ id: 'effect-state', coordinate: attemptCoordinate }]),
      ],
      events: [{ id: 'effect-attempt', coordinate: attemptCoordinate }],
      propositions: [
        { id: 'effect-admitted', coordinate: attemptCoordinate },
        { id: 'no-unresolved-effect', coordinate: attemptCoordinate },
      ],
      permits: [{ object: 'execution-authority', event: 'effect-attempt' }],
      supports: unresolvedEffect
        ? []
        : [{ object: 'effect-state', proposition: 'no-unresolved-effect' }],
      requires: [{ proposition: 'effect-admitted', required: 'no-unresolved-effect' }],
    },
    'effect-attempt',
    'effect-admitted',
  );
}
