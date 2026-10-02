import { executionPermits, projectExecutionAuthority } from './transaction-admission.ts';
import type { ExecutionPermit, Run } from '../model.ts';

export interface RelationalExplanationInput {
  coordinates: readonly { id: string }[];
  objects: readonly { id: string; coordinate: string }[];
  events: readonly { id: string; coordinate: string }[];
  propositions: readonly { id: string; coordinate: string }[];
  permits: readonly { object: string; event: string }[];
  supports: readonly { object: string; proposition: string }[];
  requires: readonly { proposition: string; required: string }[];
}

export type RelationalRequirementState = 'supported' | 'stale-support' | 'unsupported';

export interface RelationalRequirementExplanation {
  proposition: string;
  coordinate: string;
  state: RelationalRequirementState;
  supporting_objects: string[];
  stale_supporting_objects: string[];
}

export interface RelationalEventExplanation {
  event: string;
  coordinate: string;
  root_proposition: string;
  permitted_by: string[];
  stale_authority: string[];
  requirements: RelationalRequirementExplanation[];
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function explainRelationalEvent(
  input: RelationalExplanationInput,
  eventId: string,
  rootPropositionId: string,
): RelationalEventExplanation {
  const coordinates = new Set(input.coordinates.map(({ id }) => id));
  const objects = new Map(input.objects.map((item) => [item.id, item]));
  const events = new Map(input.events.map((item) => [item.id, item]));
  const propositions = new Map(input.propositions.map((item) => [item.id, item]));
  const event = events.get(eventId);
  const root = propositions.get(rootPropositionId);
  if (!event) throw new Error(`RELATIONAL_EXPLANATION_EVENT_UNKNOWN:${eventId}`);
  if (!root) throw new Error(`RELATIONAL_EXPLANATION_PROPOSITION_UNKNOWN:${rootPropositionId}`);

  for (const item of [...objects.values(), ...events.values(), ...propositions.values()]) {
    if (!coordinates.has(item.coordinate)) {
      throw new Error(`RELATIONAL_EXPLANATION_COORDINATE_UNKNOWN:${item.coordinate}`);
    }
  }

  const required = new Set<string>();
  const visiting = new Set<string>();
  const visit = (propositionId: string): void => {
    if (visiting.has(propositionId)) {
      throw new Error(`RELATIONAL_EXPLANATION_REQUIREMENT_CYCLE:${propositionId}`);
    }
    visiting.add(propositionId);
    const edges = input.requires
      .filter((edge) => edge.proposition === propositionId)
      .sort((left, right) => left.required.localeCompare(right.required));
    for (const edge of edges) {
      if (!propositions.has(edge.required)) {
        throw new Error(`RELATIONAL_EXPLANATION_REQUIRED_PROPOSITION_UNKNOWN:${edge.required}`);
      }
      if (!required.has(edge.required)) {
        required.add(edge.required);
        visit(edge.required);
      }
    }
    visiting.delete(propositionId);
  };
  visit(root.id);

  const requirements = [...required]
    .sort((left, right) => left.localeCompare(right))
    .map((propositionId): RelationalRequirementExplanation => {
      const proposition = propositions.get(propositionId)!;
      const supporting = input.supports
        .filter((edge) => edge.proposition === propositionId)
        .map((edge) => {
          const object = objects.get(edge.object);
          if (!object) {
            throw new Error(`RELATIONAL_EXPLANATION_SUPPORT_OBJECT_UNKNOWN:${edge.object}`);
          }
          return object;
        });
      const supportingObjects = uniqueSorted(
        supporting
          .filter((object) => object.coordinate === proposition.coordinate)
          .map((object) => object.id),
      );
      const staleSupportingObjects = uniqueSorted(
        supporting
          .filter((object) => object.coordinate !== proposition.coordinate)
          .map((object) => object.id),
      );
      return {
        proposition: propositionId,
        coordinate: proposition.coordinate,
        state:
          supportingObjects.length > 0
            ? 'supported'
            : staleSupportingObjects.length > 0
              ? 'stale-support'
              : 'unsupported',
        supporting_objects: supportingObjects,
        stale_supporting_objects: staleSupportingObjects,
      };
    });

  const permitting = input.permits
    .filter((edge) => edge.event === eventId)
    .map((edge) => {
      const object = objects.get(edge.object);
      if (!object) {
        throw new Error(`RELATIONAL_EXPLANATION_PERMIT_OBJECT_UNKNOWN:${edge.object}`);
      }
      return object;
    });

  return {
    event: event.id,
    coordinate: event.coordinate,
    root_proposition: root.id,
    permitted_by: uniqueSorted(
      permitting
        .filter((object) => object.coordinate === event.coordinate)
        .map((object) => object.id),
    ),
    stale_authority: uniqueSorted(
      permitting
        .filter((object) => object.coordinate !== event.coordinate)
        .map((object) => object.id),
    ),
    requirements,
  };
}

export type EffectAdmissionDenial = 'STALE_EXECUTION_GENERATION' | 'UNRESOLVED_EFFECT' | null;

export interface EffectAdmissionDecision {
  readonly permits: boolean;
  readonly denial: EffectAdmissionDenial;
}

export function effectAdmissionDecision(
  run: Run,
  permit: ExecutionPermit,
  capabilitySha256: string,
  unresolvedEffect: boolean,
): EffectAdmissionDecision {
  if (!executionPermits(run, permit, capabilitySha256)) {
    return { permits: false, denial: 'STALE_EXECUTION_GENERATION' };
  }
  if (unresolvedEffect) return { permits: false, denial: 'UNRESOLVED_EFFECT' };
  return { permits: true, denial: null };
}

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
