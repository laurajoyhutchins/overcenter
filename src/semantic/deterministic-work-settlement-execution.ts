import { executeBoundProviderEffect, executionAuthority } from './execution-provider-wrapper.js';
import type { ExecutionAuthorityRequest, ExecutionProviderWrapperPorts } from './execution-provider-wrapper.js';
import type { ExecutionTransactionResult } from './execution-transaction-runtime.js';
import type { JsonObject, JsonValue } from './execution-transaction.js';

export type DeterministicWorkSettlementRequest = ExecutionAuthorityRequest & Readonly<{
  subject_key: string;
  work_ref: string;
  predicate_key: string;
  target_state: string;
  evaluation: JsonObject;
}>;

export type DeterministicWorkSettlementPayload = JsonObject;
export type DeterministicWorkSettlementPorts = ExecutionProviderWrapperPorts<DeterministicWorkSettlementRequest, DeterministicWorkSettlementPayload>;

export async function executeDeterministicWorkSettlement(request: DeterministicWorkSettlementRequest, ports: DeterministicWorkSettlementPorts): Promise<ExecutionTransactionResult> {
  const authority = executionAuthority(request);
  return executeBoundProviderEffect({
    operation_kind: 'deterministic.work.settle',
    request,
    authority,
    idempotency_scope: 'repository:' + authority.repository,
    payload: {
      work_ref: request.work_ref,
      predicate_key: request.predicate_key,
      target_state: request.target_state,
      evaluation: request.evaluation,
    } as DeterministicWorkSettlementPayload,
    ports,
  });
}
