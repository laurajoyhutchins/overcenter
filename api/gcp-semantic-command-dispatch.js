import { config } from 'hatchable';
import { createGitHubAppAuth } from 'lib/github-app-auth.js';
import { dispatchGitHubWorkflowWithGitHubApp } from 'lib/github-workflow-dispatch.js';

export const access = 'admin';
export const methods = ['POST'];

const REPO = 'laurajoyhutchins/overcenter';
const WORKFLOW = 'gcp-semantic-command.yml';
const REF = 'dev';
const SHA40 = /^[0-9a-f]{40}$/;
const PROJECT_REF = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TRANSITION = /^\S{1,256}$/;
const RESUME = /^\S{1,512}$/;
const PROJECT_COMMANDS = new Set(['project.inspect', 'project.advance']);
const PROJECT_AUTHORING_COMMANDS = new Set(['project.amend']);
const CONTROL_COMMANDS = new Set(['orchestration.maintain']);
const GITHUB_INTEGRATION_COMMANDS = new Set(['github.pull_request.mark_ready']);
const LEASE_MUTATION_COMMANDS = new Set(['github.apply_changeset', 'github.apply_text_replacements']);
const ALLOWED_COMMANDS = new Set([...PROJECT_COMMANDS, ...PROJECT_AUTHORING_COMMANDS, ...CONTROL_COMMANDS, ...GITHUB_INTEGRATION_COMMANDS, ...LEASE_MUTATION_COMMANDS]);
const ALLOWED_FIELDS = new Set(['command', 'project_ref', 'expected_head', 'transition_id', 'resume_ref', 'execution_result', 'input']);
const PROJECT_AMEND_INPUT_FIELDS = new Set(['project_ref', 'expected_revision', 'amendment']);
const GITHUB_PR_READY_INPUT_FIELDS = new Set(['repo', 'pull_request', 'expected_head', 'run_id']);
const COMMAND_INPUT_CHUNK_SIZE = 4000;
const MAX_COMMAND_INPUT_CHUNKS = 6;
const MAX_COMMAND_INPUT_CHARS = COMMAND_INPUT_CHUNK_SIZE * MAX_COMMAND_INPUT_CHUNKS;

const secrets = Object.freeze({ get(name) { return config.get(name); } });

function invalid(message, details = {}) {
  return Object.assign(new Error(message), { code: 'GCP_SEMANTIC_DISPATCH_INVALID', httpStatus: 422, may_have_mutated: false, details });
}

function normalizeExecutionResult(value) {
  if (value === undefined || value === null) return '';
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('execution_result must be an object when supplied');
  const encoded = JSON.stringify(value);
  if (encoded.length > 4096) throw invalid('execution_result is too large');
  return encoded;
}

function normalizeProjectAmendInput(value, projectRef) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('input must be an object for project.amend');
  const input = value;
  const unknown = Object.keys(input).filter((key) => !PROJECT_AMEND_INPUT_FIELDS.has(key));
  if (unknown.length) throw invalid('project.amend input contains unknown fields', { fields: unknown.sort() });
  const inputProjectRef = String(input.project_ref || '').trim();
  const expectedRevision = String(input.expected_revision || '').trim().toLowerCase();
  if (inputProjectRef !== projectRef) throw invalid('project.amend input project_ref must match request project_ref');
  if (!SHA40.test(expectedRevision)) throw invalid('project.amend expected_revision must be an exact 40-character Git SHA');
  if (!input.amendment || typeof input.amendment !== 'object' || Array.isArray(input.amendment)) throw invalid('project.amend amendment must be an object');
  const encoded = JSON.stringify({ project_ref: projectRef, expected_revision: expectedRevision, amendment: input.amendment });
  if (encoded.length > MAX_COMMAND_INPUT_CHARS) throw invalid('input is too large for the bounded GCP workflow bridge');
  return encoded;
}

function normalizeGitHubIntegrationInput(command, value) {
  if (command !== 'github.pull_request.mark_ready') throw invalid('unsupported GitHub integration command');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('input must be an object for GitHub integration commands');
  const input = value;
  const unknown = Object.keys(input).filter((key) => !GITHUB_PR_READY_INPUT_FIELDS.has(key));
  if (unknown.length) throw invalid('github.pull_request.mark_ready input contains unknown fields', { fields: unknown.sort() });
  const repo = String(input.repo || '').trim();
  const pullRequest = Number(input.pull_request);
  const expectedHead = String(input.expected_head || '').trim().toLowerCase();
  const runId = input.run_id === undefined ? '' : String(input.run_id).trim();
  if (!REPOSITORY.test(repo)) throw invalid('github.pull_request.mark_ready repo must be owner/repo');
  if (!Number.isInteger(pullRequest) || pullRequest < 1) throw invalid('github.pull_request.mark_ready pull_request must be a positive integer');
  if (!SHA40.test(expectedHead)) throw invalid('github.pull_request.mark_ready expected_head must be an exact 40-character Git SHA');
  if (runId && runId.length > 512) throw invalid('github.pull_request.mark_ready run_id is too large');
  const normalized = { repo, pull_request: pullRequest, expected_head: expectedHead };
  if (runId) normalized.run_id = runId;
  const encoded = JSON.stringify(normalized);
  if (encoded.length > MAX_COMMAND_INPUT_CHARS) throw invalid('input is too large for the bounded GCP workflow bridge');
  return encoded;
}

function normalizeLeaseMutationInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('input must be an object for lease-scoped GitHub mutations');
  const encoded = JSON.stringify(value);
  if (encoded.length > MAX_COMMAND_INPUT_CHARS) throw invalid('input is too large for the bounded GCP workflow bridge');
  return encoded;
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

function normalize(bodyInput) {
  const body = bodyInput && typeof bodyInput === 'object' && !Array.isArray(bodyInput) ? bodyInput : {};
  const unknown = Object.keys(body).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length) throw invalid('request contains unknown fields', { fields: unknown.sort() });
  const command = String(body.command || '').trim();
  if (!ALLOWED_COMMANDS.has(command)) throw invalid('command is not admitted by the bounded GCP semantic bridge');
  const expectedHead = String(body.expected_head || '').trim().toLowerCase();
  if (!SHA40.test(expectedHead)) throw invalid('expected_head must be an exact 40-character control-plane Git SHA');
  const projectRef = body.project_ref === undefined ? '' : String(body.project_ref).trim();
  if (projectRef && !PROJECT_REF.test(projectRef)) throw invalid('project_ref must be a canonical github:owner/repo reference');
  const transitionId = body.transition_id === undefined ? '' : String(body.transition_id).trim();
  const resumeRef = body.resume_ref === undefined ? '' : String(body.resume_ref).trim();
  const executionResult = normalizeExecutionResult(body.execution_result);

  if (CONTROL_COMMANDS.has(command)) {
    if (projectRef || transitionId || resumeRef || executionResult || body.input !== undefined) throw invalid('control commands do not accept caller-selected semantic state');
    return { command, project_ref: '', expected_head: expectedHead, transition_id: '', resume_ref: '', execution_result_json: '', command_input_json: '' };
  }

  if (PROJECT_COMMANDS.has(command)) {
    if (!projectRef) throw invalid('project commands require project_ref');
    if (body.input !== undefined) throw invalid('project commands do not accept input');
    if (command === 'project.inspect' && (transitionId || resumeRef || executionResult)) throw invalid('project.inspect does not accept advance continuation fields');
    if (transitionId && !TRANSITION.test(transitionId)) throw invalid('transition_id is invalid');
    if (resumeRef && !RESUME.test(resumeRef)) throw invalid('resume_ref is invalid');
    if (executionResult && !resumeRef) throw invalid('execution_result requires resume_ref');
    return { command, project_ref: projectRef, expected_head: expectedHead, transition_id: transitionId, resume_ref: resumeRef, execution_result_json: executionResult, command_input_json: '' };
  }

  if (PROJECT_AUTHORING_COMMANDS.has(command)) {
    if (!projectRef) throw invalid('project authoring commands require project_ref');
    if (transitionId || resumeRef || executionResult) throw invalid('project authoring commands do not accept project.advance continuation fields');
    return { command, project_ref: projectRef, expected_head: expectedHead, transition_id: '', resume_ref: '', execution_result_json: '', command_input_json: normalizeProjectAmendInput(body.input, projectRef) };
  }

  if (GITHUB_INTEGRATION_COMMANDS.has(command)) {
    if (projectRef) throw invalid('GitHub integration commands derive their target from input and do not accept project_ref');
    if (transitionId || resumeRef || executionResult) throw invalid('GitHub integration commands do not accept project.advance continuation fields');
    return { command, project_ref: '', expected_head: expectedHead, transition_id: '', resume_ref: '', execution_result_json: '', command_input_json: normalizeGitHubIntegrationInput(command, body.input) };
  }

  if (projectRef) throw invalid('lease-scoped GitHub mutations derive their target from the lease and do not accept project_ref');
  if (transitionId || resumeRef || executionResult) throw invalid('lease-scoped GitHub mutations do not accept project.advance continuation fields');
  return { command, project_ref: '', expected_head: expectedHead, transition_id: '', resume_ref: '', execution_result_json: '', command_input_json: normalizeLeaseMutationInput(body.input) };
}

export default async function (req, res) {
  try {
    const request = normalize(req.body);
    const requestId = crypto.randomUUID();
    const githubAppAuth = createGitHubAppAuth({ secrets });
    const workflowInputs = {
      request_id: requestId,
      command: request.command,
      project_ref: request.project_ref,
      expected_head: request.expected_head,
    };
    if (PROJECT_COMMANDS.has(request.command)) {
      Object.assign(workflowInputs, {
        transition_id: request.transition_id,
        resume_ref: request.resume_ref,
        execution_result_json: request.execution_result_json,
      });
    } else {
      chunkCommandInput(request.command_input_json).forEach((chunk, index) => {
        workflowInputs[`command_input_${index}`] = chunk;
      });
    }
    const dispatch = await dispatchGitHubWorkflowWithGitHubApp({
      repo: REPO,
      workflow: WORKFLOW,
      ref: REF,
      expected_head: request.expected_head,
      inputs: workflowInputs,
    }, { withGitHubAppApiClient: githubAppAuth.withApiClient });

    return res.status(202).json({ ok: true, request_id: requestId, command: request.command, project_ref: request.project_ref, expected_head: request.expected_head, workflow_run_id: dispatch.workflow_run_id, workflow_run_head_sha: dispatch.workflow_run_head_sha, mutation_certainty: dispatch.mutation_certainty, may_have_mutated: dispatch.may_have_mutated });
  } catch (error) {
    const status = Number(error?.httpStatus || 500);
    return res.status(status >= 400 && status <= 599 ? status : 500).json({ ok: false, error: error?.code || 'GCP_SEMANTIC_DISPATCH_ERROR', message: String(error?.message || error), may_have_mutated: error?.may_have_mutated === true, details: error?.details || null });
  }
}
