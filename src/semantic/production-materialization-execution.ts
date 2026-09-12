import { executeBoundProviderEffect, executionAuthority } from './execution-provider-wrapper.js';
import type { ExecutionAuthorityRequest, ExecutionProviderWrapperPorts } from './execution-provider-wrapper.js';
import type { ExecutionTransactionResult } from './execution-transaction-runtime.js';
import type { JsonObject, JsonValue } from './execution-transaction.js';

export type ProductionMaterializationRequest = ExecutionAuthorityRequest & Readonly<{
  subject_key: string;
  repo: string;
  branch: string;
  source_revision: string;
  runtime_ref: string;
  expected_version: number;
  source_manifest_sha256: string;
}>;

export type ProductionMaterializationPayload = JsonObject;
export type ProductionMaterializationPorts = ExecutionProviderWrapperPorts<ProductionMaterializationRequest, ProductionMaterializationPayload>;

export async function executeProductionMaterialization(request: ProductionMaterializationRequest, ports: ProductionMaterializationPorts): Promise<ExecutionTransactionResult> {
  const authority = executionAuthority(request);
  return executeBoundProviderEffect({
    operation_kind: 'production.materialize',
    request,
    authority,
    idempotency_scope: 'repository:' + authority.repository,
    payload: {
      repo: request.repo,
      branch: request.branch,
      source_revision: request.source_revision,
      runtime_ref: request.runtime_ref,
      expected_version: request.expected_version,
      source_manifest_sha256: request.source_manifest_sha256,
    } as ProductionMaterializationPayload,
    ports,
  });
}
