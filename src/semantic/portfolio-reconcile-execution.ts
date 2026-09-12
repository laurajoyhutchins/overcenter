import { executeBoundProviderEffect, executionAuthority } from './execution-provider-wrapper.js';
import type { ExecutionAuthorityRequest, ExecutionProviderWrapperPorts } from './execution-provider-wrapper.js';
import type { ExecutionTransactionResult } from './execution-transaction-runtime.js';
import type { JsonObject, JsonValue } from './execution-transaction.js';

export type PortfolioReconciliationRequest = ExecutionAuthorityRequest & Readonly<{
  subject_key: string;
  observation: JsonObject;
  plan: JsonObject;
}>;

export type PortfolioReconciliationPayload = JsonObject;
export type PortfolioReconciliationPorts = ExecutionProviderWrapperPorts<PortfolioReconciliationRequest, PortfolioReconciliationPayload>;

export async function executePortfolioReconciliation(request: PortfolioReconciliationRequest, ports: PortfolioReconciliationPorts): Promise<ExecutionTransactionResult> {
  const authority = executionAuthority(request);
  return executeBoundProviderEffect({
    operation_kind: 'portfolio.reconcile',
    request,
    authority,
    idempotency_scope: 'repository:' + authority.repository,
    payload: {
      observation: request.observation,
      plan: request.plan,
    } as JsonValue,
    ports,
  });
}
