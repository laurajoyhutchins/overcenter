import { invokeAuthoritativeSemanticCommand } from './authoritative-semantic-command-ingress.js';
import { normalizeProjectAmendInput } from './project-amend-command-input.js';

export async function dispatchGcpProjectAmendViaWorkflow(input, options = {}) {
  const request = normalizeProjectAmendInput(input);
  const invocation = await invokeAuthoritativeSemanticCommand({
    command:'project.amend',
    project_ref:request.project_ref,
    input:request,
  }, options);
  return Object.freeze({
    ...invocation,
    expected_revision:request.expected_revision,
  });
}
