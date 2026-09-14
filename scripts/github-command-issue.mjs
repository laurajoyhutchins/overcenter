import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SHA40 = /^[0-9a-f]{40}$/;
const PROJECT_REF = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TRANSITION = /^\S{1,256}$/;
const RESUME = /^\S{1,512}$/;
const LEASE_MUTATION_COMMANDS = new Set([
  'github.apply_changeset',
  'github.coalesce_changeset',
  'github.apply_text_replacements',
]);
const ALLOWED_FIELDS = new Set([
  'schema',
  'expected_head',
  'command',
  'project_ref',
  'transition_id',
  'resume_ref',
  'execution_result',
  'amendment',
  'run_id',
  'work_ref',
  'input',
]);
const MAX_BODY_CHARS = 16_384;
const MAX_AMENDMENT_CHARS = 12_000;
const MAX_LEASE_MUTATION_INPUT_CHARS = 14_000;

function invalid(message) {
  throw Object.assign(new Error(message), { code:'GITHUB_COMMAND_ISSUE_INVALID' });
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name} must be an object`);
  return value;
}

export function prepareIssueCommand(eventInput, authorityRevisionInput) {
  const event = object(eventInput, 'event');
  if (event.action !== 'opened') invalid('only newly opened command issues are accepted');
  const issue = object(event.issue, 'issue');
  const repository = object(event.repository, 'repository');
  const owner = String(repository.owner?.login || '').trim();
  const issueUser = String(issue.user?.login || '').trim();
  if (!owner || issueUser !== owner) invalid('command issue must be authored by the repository owner');
  if (String(issue.title || '') !== '[overcenter-command]') invalid('command issue title is invalid');

  const bodyText = String(issue.body || '');
  if (!bodyText || bodyText.length > MAX_BODY_CHARS) invalid('command issue body is empty or too large');
  let body;
  try { body = JSON.parse(bodyText); } catch { invalid('command issue body must be valid JSON'); }
  object(body, 'command issue body');
  const unknown = Object.keys(body).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length) invalid(`command issue contains unknown fields: ${unknown.sort().join(', ')}`);
  if (body.schema !== 'overcenter-github-command-v1') invalid('command issue schema is invalid');

  const authorityRevision = String(authorityRevisionInput || '').trim().toLowerCase();
  const expectedHead = String(body.expected_head || '').trim().toLowerCase();
  if (!SHA40.test(authorityRevision) || !SHA40.test(expectedHead)) invalid('expected_head and authority revision must be full Git SHAs');
  if (expectedHead !== authorityRevision) invalid('command issue is stale relative to the trusted dev revision');

  const command = String(body.command || '').trim();
  const admitted = new Set(['project.inspect', 'project.advance', 'project.amend', 'orchestration.diagnose', ...LEASE_MUTATION_COMMANDS]);
  if (!admitted.has(command)) invalid('command is not admitted by the bounded GitHub issue ingress');
  const isLeaseMutation = LEASE_MUTATION_COMMANDS.has(command);
  const projectRef = String(body.project_ref || '').trim();
  if (!isLeaseMutation && command !== 'orchestration.diagnose' && !PROJECT_REF.test(projectRef)) invalid('project_ref must be a canonical github:owner/repo reference');

  const transitionId = body.transition_id === undefined ? '' : String(body.transition_id).trim();
  const resumeRef = body.resume_ref === undefined ? '' : String(body.resume_ref).trim();
  const hasExecutionResult = body.execution_result !== undefined && body.execution_result !== null;
  const hasAmendment = body.amendment !== undefined && body.amendment !== null;
  const hasRunId = body.run_id !== undefined;
  const hasWorkRef = body.work_ref !== undefined;
  const hasInput = body.input !== undefined && body.input !== null;
  if (transitionId && !TRANSITION.test(transitionId)) invalid('transition_id is invalid');
  if (resumeRef && !RESUME.test(resumeRef)) invalid('resume_ref is invalid');
  if (hasExecutionResult) object(body.execution_result, 'execution_result');
  if (JSON.stringify(body.execution_result ?? {}).length > 4096) invalid('execution_result is too large');
  if (hasAmendment) object(body.amendment, 'amendment');
  if (JSON.stringify(body.amendment ?? {}).length > MAX_AMENDMENT_CHARS) invalid('amendment is too large');

  if (isLeaseMutation) {
    if (body.project_ref !== undefined || transitionId || resumeRef || hasExecutionResult || hasAmendment || hasRunId || hasWorkRef) invalid(`${command} accepts only its bounded input envelope`);
    if (!hasInput) invalid(`${command} requires input`);
    const input = object(body.input, 'input');
    if (JSON.stringify(input).length > MAX_LEASE_MUTATION_INPUT_CHARS) invalid('lease mutation input is too large');
    if (typeof input.lease_ref !== 'string' || input.lease_ref.length < 1 || input.lease_ref.length > 128) invalid('lease mutation input requires a bounded lease_ref');
  } else if (hasInput) {
    invalid(`${command} does not accept input`);
  }

  if (!isLeaseMutation && !['orchestration.diagnose', 'project.advance'].includes(command) && (hasRunId || hasWorkRef)) invalid(`${command} does not accept diagnose fields`);
  if (command === 'project.inspect' && (transitionId || resumeRef || hasExecutionResult || hasAmendment)) invalid('project.inspect does not accept continuation or amendment fields');
  if (command === 'project.advance') {
    if (hasExecutionResult && !resumeRef) invalid('execution_result requires resume_ref');
    if (hasAmendment || hasWorkRef) invalid('project.advance does not accept amendment or work_ref');
    if (hasRunId) {
      if (!resumeRef) invalid('project.advance run_id is accepted only for a continuation with resume_ref');
      if (typeof body.run_id !== 'string' || body.run_id.length < 1 || body.run_id.length > 512) invalid('project.advance run_id must be a string between 1 and 512 characters');
    }
  }
  if (command === 'project.amend') {
    if (!hasAmendment) invalid('project.amend requires amendment');
    if (transitionId || resumeRef || hasExecutionResult) invalid('project.amend does not accept continuation fields');
  }
  if (command === 'orchestration.diagnose') {
    if (body.project_ref !== undefined || transitionId || resumeRef || hasExecutionResult || hasAmendment) invalid('orchestration.diagnose does not accept project or continuation fields');
    if (typeof body.run_id !== 'string' || body.run_id.length < 1 || body.run_id.length > 512) invalid('orchestration.diagnose run_id must be a string between 1 and 512 characters');
    if (hasWorkRef && (typeof body.work_ref !== 'string' || body.work_ref.length < 1 || body.work_ref.length > 128)) invalid('orchestration.diagnose work_ref must be a string between 1 and 128 characters');
  }

  const issueNumber = Number(issue.number);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) invalid('issue number is invalid');
  const requestId = `github-issue:${issueNumber}:${authorityRevision}`;
  const input = isLeaseMutation
    ? body.input
    : command === 'orchestration.diagnose'
      ? { run_id:body.run_id }
      : { project_ref:projectRef };
  if (command === 'orchestration.diagnose' && hasWorkRef) input.work_ref = body.work_ref;
  if (command === 'project.advance') {
    if (transitionId) input.transition_id = transitionId;
    if (resumeRef) input.resume_ref = resumeRef;
    if (hasExecutionResult) input.execution_result = body.execution_result;
  }
  if (command === 'project.amend') {
    input.expected_revision = authorityRevision;
    input.amendment = body.amendment;
  }
  return {
    schema:'overcenter-github-command-prepared-v1',
    request_id:requestId,
    command,
    expected_head:authorityRevision,
    payload:{
      command,
      input,
      invocation_context:{ run_id:command === 'project.advance' && hasRunId ? body.run_id : requestId },
    },
  };
}

async function main() {
  const [eventPath, authorityRevision] = process.argv.slice(2);
  if (!eventPath || !authorityRevision) throw new Error('usage: node scripts/github-command-issue.mjs <event-json-path> <authority-revision>');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  process.stdout.write(`${JSON.stringify(prepareIssueCommand(event, authorityRevision))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok:false, error:error?.code || 'GITHUB_COMMAND_ISSUE_ERROR', message:String(error?.message || error) }));
    process.exit(2);
  });
}
