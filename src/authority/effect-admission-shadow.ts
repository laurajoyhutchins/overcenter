import type { ExecutionPermit } from '../model.ts';
import { sha256 } from '../digest.ts';
import type { FactCommit } from './facts.ts';
import {
  projectDurableEffectHistory,
  type FourByFourProjection,
} from './effect-history-projection.ts';
import { replayProjection } from './replay.ts';
import { mutationAdmitted, projectExecutionAuthority } from './transaction-admission.ts';

export interface ProjectedEffectAdmissionState {
  current_authority: boolean;
  exact_revision: boolean;
  unresolved_effect: boolean;
}

export interface EffectAdmissionShadowResult {
  run_id: string;
  lifecycle_executing: boolean;
  legacy: boolean;
  permits: boolean;
  legacy_state: ProjectedEffectAdmissionState;
  projected_state: ProjectedEffectAdmissionState;
}

function coordinate(
  projection: FourByFourProjection,
  id: string,
): FourByFourProjection['coordinates'][number] | undefined {
  return projection.coordinates.find((item) => item.id === id);
}

function projectedUnresolvedEffect(projection: FourByFourProjection, runId: string): boolean {
  const asserted = new Set(projection.asserts.map((edge) => edge.proposition));
  const released = new Set(
    projection.propositions
      .filter((item) => item.role === 'not-dispatched' && asserted.has(item.id))
      .flatMap((item) => {
        const reservation = coordinate(projection, item.coordinate)?.value.reservation_commit;
        return typeof reservation === 'string' ? [reservation] : [];
      }),
  );
  return projection.events.some(
    (event) =>
      event.role === 'effect-attempt' &&
      event.value.run_id === runId &&
      typeof event.value.reservation_commit === 'string' &&
      projection.permits.some((edge) => edge.event === event.id) &&
      !released.has(event.value.reservation_commit),
  );
}

export function projectEffectAdmissionState(
  projection: FourByFourProjection,
  permit: ExecutionPermit,
): ProjectedEffectAdmissionState {
  const authorities = projection.objects.filter(
    (item) =>
      item.role === 'execution-authority' &&
      item.value.run_id === permit.id &&
      item.value.obligation_id === permit.obligation_id,
  );
  const currentGeneration = Math.max(
    0,
    ...authorities.map((item) => Number(item.value.generation)),
  );
  const current = authorities.find((item) => Number(item.value.generation) === currentGeneration);
  const at = current ? coordinate(projection, current.coordinate) : undefined;
  const capability = sha256(permit.execution_capability);
  return {
    current_authority:
      current !== undefined &&
      permit.execution_generation === currentGeneration &&
      current.value.execution_authority_commit === permit.execution_authority_commit &&
      current.value.execution_capability_sha256 === permit.execution_capability_sha256 &&
      current.value.execution_capability_sha256 === capability,
    exact_revision:
      at !== undefined &&
      at.value.claimed_revision === permit.claimed_revision &&
      at.value.claim_commit === permit.claim_commit &&
      at.value.obligation_key === permit.obligation_key,
    unresolved_effect: projectedUnresolvedEffect(projection, permit.id),
  };
}

export function effectPermitsFromProjection(state: ProjectedEffectAdmissionState): boolean {
  return state.current_authority && state.exact_revision && !state.unresolved_effect;
}

export function assertEffectAdmissionAgreement(result: EffectAdmissionShadowResult): void {
  if (result.legacy === result.permits) return;
  throw new Error(
    `EFFECT_ADMISSION_SHADOW_DIVERGENCE:${JSON.stringify({
      run_id: result.run_id,
      lifecycle_executing: result.lifecycle_executing,
      legacy: result.legacy,
      permits: result.permits,
      legacy_state: result.legacy_state,
      projected_state: result.projected_state,
    })}`,
  );
}

export function shadowEffectAdmission(
  history: readonly FactCommit[],
  permit: ExecutionPermit,
): EffectAdmissionShadowResult {
  const legacyProjection = replayProjection([...history]);
  const run = legacyProjection.history.runs.get(permit.id);
  if (!run) throw new Error('UNKNOWN_RUN');
  const lifecycle = legacyProjection.project.lifecycles.get(run.obligation_id);
  const lifecycleExecuting = lifecycle?.run?.id === run.id && lifecycle.status === 'EXECUTING';
  const authority = projectExecutionAuthority(run, permit, sha256(permit.execution_capability));
  const legacyState = {
    ...authority,
    unresolved_effect: legacyProjection.history.unresolvedReservationsByRun.has(run.id),
  };
  const projectedState = projectEffectAdmissionState(projectDurableEffectHistory(history), permit);
  const result: EffectAdmissionShadowResult = {
    run_id: run.id,
    lifecycle_executing: lifecycleExecuting,
    legacy: lifecycleExecuting && mutationAdmitted(legacyState),
    permits: lifecycleExecuting && effectPermitsFromProjection(projectedState),
    legacy_state: legacyState,
    projected_state: projectedState,
  };
  assertEffectAdmissionAgreement(result);
  return result;
}
