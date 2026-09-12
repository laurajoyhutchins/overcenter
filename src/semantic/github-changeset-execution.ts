import { executeBoundProviderEffect, executionAuthority } from './execution-provider-wrapper.js';
import type { ExecutionAuthorityRequest, ExecutionProviderWrapperPorts } from './execution-provider-wrapper.js';
import type { ExecutionTransactionResult } from './execution-transaction-runtime.js';
import type { JsonObject, JsonValue } from './execution-transaction.js';

export type GithubChangesetRequest = ExecutionAuthorityRequest & Readonly<{
  subject_key: string;
  repo: string;
  branch: string;
  base_revision: string;
  expected_head: string;
  changes: JsonValue;
  commit_message: string;
}>;

export type GithubChangesetPayload = JsonObject;
export type GithubChangesetPorts = ExecutionProviderWrapperPorts<GithubChangesetRequest, GithubChangesetPayload>;

export async function executeGithubChangeset(request: GithubChangesetRequest, ports: GithubChangesetPorts): Promise<ExecutionTransactionResult> {
  const authority = executionAuthority(request);
  return executeBoundProviderEffect({
    operation_kind: 'github.changeset.apply',
    request,
    authority,
    idempotency_scope: 'repository:' + authority.repository,
    payload: {
      repo: request.repo,
      branch: request.branch,
      base_revision: request.base_revision,
      expected_head: request.expected_head,
      changes: request.changes,
      commit_message: request.commit_message,
    } as GithubChangesetPayload,
    ports,
  });
}
