import { readFile, writeFile } from 'node:fs/promises';

async function replace(path, oldText, newText) {
  const current = await readFile(path, 'utf8');
  const first = current.indexOf(oldText);
  if (first < 0) throw new Error(`${path}: expected text not found`);
  if (current.indexOf(oldText, first + oldText.length) >= 0) throw new Error(`${path}: expected text is not unique`);
  await writeFile(path, current.slice(0, first) + newText + current.slice(first + oldText.length));
}

await replace('src/semantic/semantic-command-descriptors.ts',
`const orchestrationMaintainSchema = Object.freeze({
  type:'object',
  properties:{},
  additionalProperties:false,
});

const orchestrationDiagnoseSchema`,
`const orchestrationMaintainSchema = Object.freeze({
  type:'object',
  properties:{},
  additionalProperties:false,
});

const orchestrationDriveSchema = Object.freeze({
  type:'object',
  required:['run_id'],
  properties:{
    run_id:{type:'string',minLength:1,maxLength:512},
  },
  additionalProperties:false,
});

const orchestrationDiagnoseSchema`);

await replace('src/semantic/semantic-command-descriptors.ts',
`  'orchestration.maintain':descriptor(
    'orchestration.maintain',`,
`  'orchestration.drive':descriptor(
    'orchestration.drive',
    'orchestration.drive',
    'Drive one existing orchestration run through bounded deterministic project work until agent judgment, waiting, blocking, owner decision, off-nominal uncertainty, terminal state, no progress, or the server-owned advance budget stops execution. Run authority, exact project revision, leases, settlement, evidence, mutation certainty, and recovery remain owned by the underlying orchestration advance primitive.',
    orchestrationDriveSchema,
    'operator',
    INTERNAL_EXPOSURE,
  ),
  'orchestration.maintain':descriptor(
    'orchestration.maintain',`);

await replace('lib/worker-transport.js',
`import { createPostgresOrchestrationAdvanceService, createPostgresTargetAwareOrchestrationRunService, statusForOrchestrationAdvanceRuntimeError } from 'lib/orchestration-run-target-runtime.js';`,
`import { createPostgresOrchestrationAdvanceService, createPostgresOrchestrationDriveService, createPostgresTargetAwareOrchestrationRunService, statusForOrchestrationAdvanceRuntimeError, statusForOrchestrationDriveRuntimeError } from 'lib/orchestration-run-target-runtime.js';`);

await replace('lib/worker-transport.js',
`function orchestrationMaintenanceFor(runtime = {}) {`,
`function orchestrationDriveFor(runtime = {}) {
  if (runtime.orchestrationDrive && typeof runtime.orchestrationDrive.drive === 'function') return runtime.orchestrationDrive;
  return createPostgresOrchestrationDriveService({ ...runtime, db:requireRuntimeDb(runtime) });
}

function orchestrationMaintenanceFor(runtime = {}) {`);

await replace('lib/worker-transport.js',
`const orchestrationMaintainDescriptor = semanticCommandDescriptor('orchestration.maintain');`,
`const orchestrationDriveDescriptor = semanticCommandDescriptor('orchestration.drive');
const orchestrationMaintainDescriptor = semanticCommandDescriptor('orchestration.maintain');`);

await replace('lib/worker-transport.js',
`  'orchestration.maintain': {
    allowed: new Set(orchestrationMaintainDescriptor.semantic_fields),`,
`  'orchestration.drive': {
    allowed: new Set(orchestrationDriveDescriptor.semantic_fields),
    required: new Set(orchestrationDriveDescriptor.required_fields),
    canonicalize: async (input) => ({ ...input }),
    execute: (request, runtime) => orchestrationDriveFor(runtime).drive(request),
    statusForFailure: statusForOrchestrationDriveRuntimeError,
    defaultError: 'ORCHESTRATION_DRIVE_ERROR',
    defaultMessage: 'orchestration.drive failed',
  },
  'orchestration.maintain': {
    allowed: new Set(orchestrationMaintainDescriptor.semantic_fields),`);

await replace('api/gcp-semantic-command-dispatch.js',
`const CONTROL_COMMANDS = new Set(['orchestration.maintain']);
const DIAGNOSIS_COMMANDS`,
`const CONTROL_COMMANDS = new Set(['orchestration.maintain']);
const DRIVE_COMMANDS = new Set(['orchestration.drive']);
const DIAGNOSIS_COMMANDS`);

await replace('api/gcp-semantic-command-dispatch.js',
`...PROJECT_AUTHORING_COMMANDS, ...CONTROL_COMMANDS, ...DIAGNOSIS_COMMANDS`,
`...PROJECT_AUTHORING_COMMANDS, ...CONTROL_COMMANDS, ...DRIVE_COMMANDS, ...DIAGNOSIS_COMMANDS`);

await replace('api/gcp-semantic-command-dispatch.js',
`const ORCHESTRATION_DIAGNOSE_INPUT_FIELDS = new Set(['run_id', 'work_ref']);`,
`const ORCHESTRATION_DRIVE_INPUT_FIELDS = new Set(['run_id']);
const ORCHESTRATION_DIAGNOSE_INPUT_FIELDS = new Set(['run_id', 'work_ref']);`);

await replace('api/gcp-semantic-command-dispatch.js',
`function normalizeOrchestrationDiagnoseInput(value) {`,
`function normalizeOrchestrationDriveInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('input must be an object for orchestration.drive');
  const input = value;
  const unknown = Object.keys(input).filter((key) => !ORCHESTRATION_DRIVE_INPUT_FIELDS.has(key));
  if (unknown.length) throw invalid('orchestration.drive input contains unknown fields', { fields: unknown.sort() });
  if (typeof input.run_id !== 'string' || input.run_id.length === 0) throw invalid('orchestration.drive run_id is required');
  if (input.run_id.length > 512) throw invalid('orchestration.drive run_id is too large');
  return JSON.stringify({ run_id:input.run_id });
}

function normalizeOrchestrationDiagnoseInput(value) {`);

await replace('api/gcp-semantic-command-dispatch.js',
`  if (DIAGNOSIS_COMMANDS.has(command)) {`,
`  if (DRIVE_COMMANDS.has(command)) {
    if (projectRef || transitionId || resumeRef || executionResult) throw invalid('orchestration.drive does not accept caller-selected project or continuation state');
    return { command, project_ref: '', expected_head: expectedHead, transition_id: '', resume_ref: '', execution_result_json: '', command_input_json: normalizeOrchestrationDriveInput(body.input) };
  }

  if (DIAGNOSIS_COMMANDS.has(command)) {`);

await replace('.github/workflows/gcp-semantic-command.yml',
`          - orchestration.maintain
          - orchestration.diagnose`,
`          - orchestration.drive
          - orchestration.maintain
          - orchestration.diagnose`);

await replace('.github/workflows/gcp-semantic-command.yml',
`project.inspect|project.advance|project.define|project.amend|orchestration.maintain|orchestration.diagnose|production.reconcile`,
`project.inspect|project.advance|project.define|project.amend|orchestration.drive|orchestration.maintain|orchestration.diagnose|production.reconcile`);

await replace('.github/workflows/gcp-semantic-command.yml',
`            orchestration.maintain)
              test -z "$PROJECT_REF"`,
`            orchestration.drive)
              test -z "$PROJECT_REF"
              test -z "$TRANSITION_ID"
              test -z "$RESUME_REF"
              test -z "$EXECUTION_RESULT_JSON"
              test -n "$command_input_json"
              jq -e 'type == "object" and (keys == ["run_id"]) and (.run_id | type == "string" and length > 0 and length <= 512)' <<<"$command_input_json" >/dev/null
              ;;
            orchestration.maintain)
              test -z "$PROJECT_REF"`);

await replace('.github/workflows/gcp-semantic-command.yml',
`            orchestration.diagnose|production.reconcile|project.define|project.amend|github.pull_request.mark_ready|github.workflow.dispatch|github.apply_changeset|github.coalesce_changeset|github.apply_text_replacements) input="$command_input_json" ;;`,
`            orchestration.drive|orchestration.diagnose|production.reconcile|project.define|project.amend|github.pull_request.mark_ready|github.workflow.dispatch|github.apply_changeset|github.coalesce_changeset|github.apply_text_replacements) input="$command_input_json" ;;`);

await replace('.github/workflows/gcp-semantic-command-branch.yml',
`            orchestration.diagnose|production.reconcile|github.pull_request.mark_ready|github.workflow.dispatch|github.apply_changeset|github.coalesce_changeset|github.apply_text_replacements)`,
`            orchestration.drive|orchestration.diagnose|production.reconcile|github.pull_request.mark_ready|github.workflow.dispatch|github.apply_changeset|github.coalesce_changeset|github.apply_text_replacements)`);

await replace('scripts/github-command-issue.mjs',
`'project.inspect', 'project.advance', 'project.amend', 'orchestration.diagnose', 'orchestration.maintain'`,
`'project.inspect', 'project.advance', 'project.amend', 'orchestration.drive', 'orchestration.diagnose', 'orchestration.maintain'`);

await replace('scripts/github-command-issue.mjs',
`!['orchestration.diagnose', 'orchestration.maintain'].includes(command)`,
`!['orchestration.drive', 'orchestration.diagnose', 'orchestration.maintain'].includes(command)`);

await replace('scripts/github-command-issue.mjs',
`!['orchestration.diagnose', 'project.advance'].includes(command) && (hasRunId || hasWorkRef)`,
`!['orchestration.drive', 'orchestration.diagnose', 'project.advance'].includes(command) && (hasRunId || hasWorkRef)`);

await replace('scripts/github-command-issue.mjs',
`  if (command === 'orchestration.diagnose') {`,
`  if (command === 'orchestration.drive') {
    if (body.project_ref !== undefined || body.expected_revision !== undefined || transitionId || resumeRef || hasExecutionResult || hasAmendment || hasWorkRef) invalid('orchestration.drive does not accept project, continuation, amendment, or work_ref fields');
    if (typeof body.run_id !== 'string' || body.run_id.length < 1 || body.run_id.length > 512) invalid('orchestration.drive run_id must be a string between 1 and 512 characters');
  }
  if (command === 'orchestration.diagnose') {`);

await replace('scripts/github-command-issue.mjs',
`    : command === 'orchestration.diagnose'
      ? { run_id:body.run_id }`,
`    : command === 'orchestration.drive' || command === 'orchestration.diagnose'
      ? { run_id:body.run_id }`);

await replace('scripts/github-command-issue.mjs',
`  const durableRunId = command === 'orchestration.diagnose'
    ? String(body.run_id)`,
`  const durableRunId = command === 'orchestration.drive' || command === 'orchestration.diagnose'
    ? String(body.run_id)`);

await replace('scripts/verify-semantic-command-descriptors.test.mjs',
`'orchestration.diagnose', 'orchestration.maintain'`,
`'orchestration.diagnose', 'orchestration.drive', 'orchestration.maintain'`);

await replace('scripts/verify-semantic-command-descriptors.test.mjs',
`  ['orchestration.diagnose', 'operator'],
  ['orchestration.maintain', 'operator'],`,
`  ['orchestration.diagnose', 'operator'],
  ['orchestration.drive', 'operator'],
  ['orchestration.maintain', 'operator'],`);

await replace('scripts/verify-semantic-command-descriptors.test.mjs',
`  ['orchestration.diagnose', { worker:true, mcp:false }],
  ['orchestration.maintain', { worker:true, mcp:false }],`,
`  ['orchestration.diagnose', { worker:true, mcp:false }],
  ['orchestration.drive', { worker:true, mcp:false }],
  ['orchestration.maintain', { worker:true, mcp:false }],`);

console.log('orchestration.drive publication replacements applied');
