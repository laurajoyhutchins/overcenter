import { dispatchGitHubWorkflowWithGitHubApp } from './github-workflow-dispatch.js';

const CONTROL_REPO = 'laurajoyhutchins/overcenter';
const CONTROL_REF = 'dev';
const WORKFLOW = 'gcp-semantic-command.yml';
const SHA40 = /^[0-9a-f]{40}$/;
const PROJECT_REF = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMAND_INPUT_CHUNK_SIZE = 4000;
const MAX_COMMAND_INPUT_CHUNKS = 6;
const MAX_COMMAND_INPUT_CHARS = COMMAND_INPUT_CHUNK_SIZE * MAX_COMMAND_INPUT_CHUNKS;

function invalid(message, details = {}) {
  return Object.assign(new Error(message), {
    code:'GCP_SEMANTIC_RELAY_INVALID',
    may_have_mutated:false,
    details,
  });
}

function normalizeProjectAmendInput(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const projectRef = String(input.project_ref || '').trim();
  const expectedRevision = String(input.expected_revision || '').trim().toLowerCase();
  if (!PROJECT_REF.test(projectRef)) throw invalid('project_ref must be a canonical github:owner/repo reference');
  if (!SHA40.test(expectedRevision)) throw invalid('expected_revision must be an exact 40-character Git SHA');
  if (!input.amendment || typeof input.amendment !== 'object' || Array.isArray(input.amendment)) throw invalid('amendment must be an object');
  const encoded = JSON.stringify({ project_ref:projectRef, expected_revision:expectedRevision, amendment:input.amendment });
  if (encoded.length > MAX_COMMAND_INPUT_CHARS) throw invalid('project.amend input is too large for the bounded GCP workflow bridge');
  return Object.freeze({ project_ref:projectRef, expected_revision:expectedRevision, command_input_json:encoded });
}

function chunkCommandInput(encoded) {
  const chunks = [];
  for (let offset = 0; offset < encoded.length;) {
    let end = Math.min(offset + COMMAND_INPUT_CHUNK_SIZE, encoded.length);
    if (end < encoded.length) {
      const last = encoded.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    }
    chunks.push(encoded.slice(offset, end));
    offset = end;
  }
  return chunks;
}

async function resolveControlPlaneHead(withGitHubAppApiClient) {
  if (typeof withGitHubAppApiClient !== 'function') throw invalid('GitHub App transport is unavailable');
  return withGitHubAppApiClient(CONTROL_REPO, async (apiClient) => {
    const response = await apiClient.call('github', {
      path:'/repos/laurajoyhutchins/overcenter/git/ref/heads/dev',
      method:'GET',
    });
    if (response?.status !== 200) {
      throw Object.assign(new Error('could not resolve exact Overcenter dev head for GCP semantic relay'), {
        code:'GCP_SEMANTIC_RELAY_HEAD_UNAVAILABLE',
        may_have_mutated:false,
        details:{ upstream_status:Number(response?.status || 0) || null },
      });
    }
    const revision = String(response?.body?.object?.sha || '').trim().toLowerCase();
    if (!SHA40.test(revision)) throw invalid('Overcenter dev head was not an exact Git revision');
    return revision;
  }, { permissionProfile:'workflow_dispatch' });
}

export async function dispatchGcpProjectAmendViaWorkflow(input, options = {}) {
  const request = normalizeProjectAmendInput(input);
  const withGitHubAppApiClient = options.withGitHubAppApiClient;
  const expectedHead = await resolveControlPlaneHead(withGitHubAppApiClient);
  const requestId = crypto.randomUUID();
  const workflowInputs = {
    request_id:requestId,
    command:'project.amend',
    project_ref:request.project_ref,
    expected_head:expectedHead,
  };
  chunkCommandInput(request.command_input_json).forEach((chunk, index) => {
    workflowInputs[`command_input_${index}`] = chunk;
  });
  const dispatch = await dispatchGitHubWorkflowWithGitHubApp({
    repo:CONTROL_REPO,
    workflow:WORKFLOW,
    ref:CONTROL_REF,
    expected_head:expectedHead,
    inputs:workflowInputs,
  }, { withGitHubAppApiClient });

  return Object.freeze({
    ok:true,
    schema:'gcp-semantic-invocation-v1',
    outcome:'accepted',
    command:'project.amend',
    project_ref:request.project_ref,
    expected_revision:request.expected_revision,
    control_plane_revision:expectedHead,
    request_id:requestId,
    workflow_run_id:dispatch.workflow_run_id,
    workflow_run_head_sha:dispatch.workflow_run_head_sha,
    mutation_certainty:dispatch.mutation_certainty,
    may_have_mutated:dispatch.may_have_mutated,
  });
}
