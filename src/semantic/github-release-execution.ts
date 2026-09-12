import { executeBoundProviderEffect, executionAuthority } from './execution-provider-wrapper.js';
import type { ExecutionAuthorityRequest, ExecutionProviderWrapperPorts } from './execution-provider-wrapper.js';
import type { ExecutionTransactionResult } from './execution-transaction-runtime.js';
import type { JsonObject, JsonValue } from './execution-transaction.js';

export type GithubReleaseRequest = ExecutionAuthorityRequest & Readonly<{
  subject_key: string;
  repo: string;
  target_revision: string;
  tag_name: string;
  body: string;
}>;

export type GithubReleasePayload = JsonObject;
export type GithubReleasePorts = ExecutionProviderWrapperPorts<GithubReleaseRequest, GithubReleasePayload>;

export async function executeGithubRelease(request: GithubReleaseRequest, ports: GithubReleasePorts): Promise<ExecutionTransactionResult> {
  const authority = executionAuthority(request);
  return executeBoundProviderEffect({
    operation_kind: 'github.release.create',
    request,
    authority,
    idempotency_scope: 'repository:' + authority.repository,
    payload: {
      repo: request.repo,
      target_revision: request.target_revision,
      tag_name: request.tag_name,
      body: request.body,
    } as JsonValue,
    ports,
  });
}
