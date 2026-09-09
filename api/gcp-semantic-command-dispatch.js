import { config } from 'hatchable';
import { createGitHubAppAuth } from 'lib/github-app-auth.js';
import { dispatchGitHubWorkflowWithGitHubApp } from 'lib/github-workflow-dispatch.js';

export const access = 'admin';
export const methods = ['POST'];

const REPO = 'laurajoyhutchins/overcenter';
const PROJECT_REF = 'github:laurajoyhutchins/overcenter';
const WORKFLOW = 'gcp-semantic-command.yml';
const REF = 'main';
const SHA40 = /^[0-9a-f]{40}$/;
const TRANSITION = /^\S{1,256}$/;
const RESUME = /^\S{1,512}$/;
const ALLOWED_COMMANDS = new Set(['project.inspect', 'project.advance']);
const ALLOWED_FIELDS = new Set(['command', 'expected_head', 'transition_id', 'resume_ref', 'execution_result']);

const secrets = Object.freeze({
  get(name) {
    return config.get(name);
  },
});

function invalid(message, details = {}) {
  return Object.assign(new Error(message), {
    code: 'GCP_SEMANTIC_DISPATCH_INVALID',
    httpStatus: 422,
    may_have_mutated: false,
    details,
  });
}

function normalizeExecutionResult(value) {
  if (value === undefined || value === null) return '';
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('execution_result must be an object when supplied');
  }
  const encoded = JSON.stringify(value);
  if (encoded.length > 4096) throw invalid('execution_result is too large');
  return encoded;
}

function normalize(bodyInput) {
  const body = bodyInput && typeof bodyInput === 'object' && !Array.isArray(bodyInput) ? bodyInput : {};
  const unknown = Object.keys(body).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length) throw invalid('request contains unknown fields', { fields: unknown.sort() });

  const command = String(body.command || '').trim();
  if (!ALLOWED_COMMANDS.has(command)) throw invalid('command must be project.inspect or project.advance');

  const expectedHead = String(body.expected_head || '').trim().toLowerCase();
  if (!SHA40.test(expectedHead)) throw invalid('expected_head must be an exact 40-character Git SHA');

  const transitionId = body.transition_id === undefined ? '' : String(body.transition_id).trim();
  const resumeRef = body.resume_ref === undefined ? '' : String(body.resume_ref).trim();
  const executionResult = normalizeExecutionResult(body.execution_result);

  if (command === 'project.inspect' && (transitionId || resumeRef || executionResult)) {
    throw invalid('project.inspect does not accept advance continuation fields');
  }
  if (transitionId && !TRANSITION.test(transitionId)) throw invalid('transition_id is invalid');
  if (resumeRef && !RESUME.test(resumeRef)) throw invalid('resume_ref is invalid');
  if (executionResult && !resumeRef) throw invalid('execution_result requires resume_ref');

  return {
    command,
    expected_head: expectedHead,
    transition_id: transitionId,
    resume_ref: resumeRef,
    execution_result_json: executionResult,
  };
}

export default async function (req, res) {
  try {
    const request = normalize(req.body);
    const requestId = crypto.randomUUID();
    const githubAppAuth = createGitHubAppAuth({ secrets });
    const dispatch = await dispatchGitHubWorkflowWithGitHubApp({
      repo: REPO,
      workflow: WORKFLOW,
      ref: REF,
      expected_head: request.expected_head,
      inputs: {
        request_id: requestId,
        command: request.command,
        project_ref: PROJECT_REF,
        expected_head: request.expected_head,
        transition_id: request.transition_id,
        resume_ref: request.resume_ref,
        execution_result_json: request.execution_result_json,
      },
    }, {
      // Deliberately use the raw GitHub App identity rather than the Hatchable
      // source-authority fence. This route cannot write project state or Git;
      // it can only dispatch the fixed, allowlisted GCP semantic workflow.
      withGitHubAppApiClient: githubAppAuth.withApiClient,
    });

    return res.status(202).json({
      ok: true,
      request_id: requestId,
      command: request.command,
      project_ref: PROJECT_REF,
      expected_head: request.expected_head,
      workflow_run_id: dispatch.workflow_run_id,
      workflow_run_head_sha: dispatch.workflow_run_head_sha,
      mutation_certainty: dispatch.mutation_certainty,
      may_have_mutated: dispatch.may_have_mutated,
    });
  } catch (error) {
    const status = Number(error?.httpStatus || 500);
    return res.status(status >= 400 && status <= 599 ? status : 500).json({
      ok: false,
      error: error?.code || 'GCP_SEMANTIC_DISPATCH_ERROR',
      message: String(error?.message || error),
      may_have_mutated: error?.may_have_mutated === true,
      details: error?.details || null,
    });
  }
}
