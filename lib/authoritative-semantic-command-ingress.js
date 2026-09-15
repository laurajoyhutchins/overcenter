import { randomUUID } from 'node:crypto';
import { dispatchGitHubWorkflowWithGitHubApp, readGitHubWorkflowSemanticReceipt } from './github-workflow-dispatch.js';
import { resolveAuthoritativeSemanticReceipt } from './authoritative-semantic-receipt-resolution.js';

const CONTROL_REPO = 'laurajoyhutchins/overcenter';
const CONTROL_REF = 'dev';
const WORKFLOW = 'gcp-semantic-command.yml';
const SHA40 = /^[0-9a-f]{40}$/;
const PROJECT_REF = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMAND = /^[a-z0-9_.-]+$/;
const COMMAND_INPUT_CHUNK_SIZE = 4000;
const MAX_COMMAND_INPUT_CHUNKS = 6;
const MAX_COMMAND_INPUT_CHARS = COMMAND_INPUT_CHUNK_SIZE * MAX_COMMAND_INPUT_CHUNKS;

function invalid(message, details = {}) {
  return Object.assign(new Error(message), {
    code:'AUTHORITATIVE_SEMANTIC_INGRESS_INVALID',
    may_have_mutated:false,
    details,
  });
}

function normalizeInvocation(value) {
  const request = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const command = String(request.command || '').trim();
  const projectRef = String(request.project_ref || '').trim();
  if (!COMMAND.test(command)) throw invalid('command must be a canonical semantic command name');
  if (!PROJECT_REF.test(projectRef)) throw invalid('project_ref must be a canonical github:owner/repo reference');
  if (!request.input || typeof request.input !== 'object' || Array.isArray(request.input)) throw invalid('input must be an object');
  if (String(request.input.project_ref || '').trim() !== projectRef) throw invalid('input project_ref must match project_ref');
  const commandInputJson = JSON.stringify(request.input);
  if (commandInputJson.length > MAX_COMMAND_INPUT_CHARS) throw invalid('semantic command input is too large for the bounded GCP workflow bridge');
  return Object.freeze({ command, project_ref:projectRef, command_input_json:commandInputJson });
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
      throw Object.assign(new Error('could not resolve exact Overcenter dev head for authoritative semantic ingress'), {
        code:'AUTHORITATIVE_SEMANTIC_INGRESS_HEAD_UNAVAILABLE',
        may_have_mutated:false,
        details:{ upstream_status:Number(response?.status || 0) || null },
      });
    }
    const revision = String(response?.body?.object?.sha || '').trim().toLowerCase();
    if (!SHA40.test(revision)) throw invalid('Overcenter dev head was not an exact Git revision');
    return revision;
  }, { permissionProfile:'workflow_dispatch' });
}

export async function invokeAuthoritativeSemanticCommand(input, options = {}) {
  const request = normalizeInvocation(input);
  const withGitHubAppApiClient = options.withGitHubAppApiClient;
  const expectedHead = await resolveControlPlaneHead(withGitHubAppApiClient);
  const requestId = randomUUID();
  const workflowInputs = {
    request_id:requestId,
    command:request.command,
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
  }, { withGitHubAppApiClient, sleep:options.sleep });
  const readReceipt = options.readGitHubWorkflowSemanticReceipt || readGitHubWorkflowSemanticReceipt;
  const terminalArtifact = await readReceipt({
    repo:CONTROL_REPO,
    workflow_run_id:dispatch.workflow_run_id,
    request_id:requestId,
    command:request.command,
    expected_head:expectedHead,
  }, { withGitHubAppApiClient, sleep:options.sleep });
  const terminal = await resolveAuthoritativeSemanticReceipt(terminalArtifact, {
    request_id:requestId,
    command:request.command,
    expected_head:expectedHead,
  }, { readAuthoritativeSemanticReceipt:options.readAuthoritativeSemanticReceipt });

  return Object.freeze({
    ok:true,
    schema:'gcp-semantic-invocation-v1',
    outcome:terminal.outcome,
    command:request.command,
    project_ref:request.project_ref,
    control_plane_revision:expectedHead,
    request_id:requestId,
    workflow_run_id:dispatch.workflow_run_id,
    workflow_run_head_sha:dispatch.workflow_run_head_sha,
    response:terminal.response,
    receipt:terminal.receipt,
    mutation_certainty:terminal.mutation_certainty,
    may_have_mutated:terminal.may_have_mutated,
  });
}
