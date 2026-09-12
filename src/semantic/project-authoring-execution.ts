import { executeBoundProviderEffect, executionAuthority } from './execution-provider-wrapper.js';
import type { ExecutionAuthorityRequest, ExecutionProviderWrapperPorts } from './execution-provider-wrapper.js';
import type { ExecutionTransactionResult } from './execution-transaction-runtime.js';
import type { JsonObject, JsonValue } from './execution-transaction.js';

export type ProjectAuthoringRequest = ExecutionAuthorityRequest & Readonly<{
  subject_key: string;
  expected_revision: string;
  definition: JsonObject;
  amendment: JsonObject;
}>;

export type ProjectAuthoringPayload = JsonObject;
export type ProjectAuthoringPorts = ExecutionProviderWrapperPorts<ProjectAuthoringRequest, ProjectAuthoringPayload>;

export async function executeProjectAuthoring(request: ProjectAuthoringRequest, ports: ProjectAuthoringPorts): Promise<ExecutionTransactionResult> {
  const authority = executionAuthority(request);
  return executeBoundProviderEffect({
    operation_kind: 'project.authoring',
    request,
    authority,
    idempotency_scope: 'repository:' + authority.repository,
    payload: {
      expected_revision: request.expected_revision,
      definition: request.definition,
      amendment: request.amendment,
    } as ProjectAuthoringPayload,
    ports,
  });
}
