import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresTargetAwareOrchestrationRunService, statusForTargetAwareOrchestrationError } from 'lib/orchestration-run-target-runtime.js';

export const access = 'admin';

const contractRefSchema = {
  type: 'object',
  required: ['file_id', 'revision_id'],
  properties: {
    file_id: { type: 'string' },
    revision_id: { type: 'string' },
    sha256: { type: ['string', 'null'] },
  },
  additionalProperties: false,
};

const targetSchema = {
  type: 'object',
  required: ['project_ref', 'horizon'],
  properties: {
    project_ref: { type: 'string', minLength: 1, maxLength: 512 },
    horizon: {
      type: 'object',
      required: ['kind', 'ref'],
      properties: {
        kind: { type: 'string', enum: ['transition', 'milestone', 'project', 'release', 'portfolio'] },
        ref: { type: 'string', minLength: 1, maxLength: 512 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export default {
  name: 'orchestration.start',
  description: 'Start or idempotently recover one durable orchestration run with a bounded budget, compatible predecessor pointer, optional immutable worker-contract provenance, and optional immutable authority-bound project horizon target.',
  inputSchema: {
    type: 'object',
    required: ['run_id', 'worker', 'mode', 'continuation_key', 'scope'],
    properties: {
      run_id: { type: 'string' },
      worker: { type: 'string' },
      mode: { type: 'string', enum: ['scheduled', 'interactive'] },
      continuation_key: { type: 'string' },
      scope: {
        type: 'object',
        description: 'Select exactly one run authority anchor: legacy project or team. projects, lanes, repositories, and direction only filter work beneath that anchor.',
        oneOf: [
          { required: ['project'], not: { anyOf: [{ required: ['team'] }, { required: ['projects'] }] } },
          { required: ['team'], not: { required: ['project'] } },
        ],
        properties: {
          project: { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S', description: 'Legacy single-project authority anchor. Do not combine with team or projects.' },
          team: { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S', description: 'Team authority anchor for campaign-aware scope. Required when project is omitted.' },
          projects: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S' }, maxItems: 25, description: 'Optional project filter beneath scope.team. Empty means any project or unprojected issue in the team.' },
          lanes: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 128, pattern: '\\S' }, maxItems: 8, description: 'Optional lane filter beneath the selected authority anchor.' },
          repositories: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S' }, maxItems: 25, description: 'Optional repository filter beneath the selected authority anchor; it does not independently authorize a run.' },
          direction: { type: ['string', 'null'], maxLength: 1000, pattern: '\\S', description: 'Optional direction filter beneath the selected authority anchor.' },
        },
        additionalProperties: false,
      },
      target: targetSchema,
      budget_seconds: { type: 'integer' },
      settlement_reserve_seconds: { type: 'integer' },
      minimum_new_gate_seconds: { type: 'integer' },
      contract_provenance: {
        type: 'object',
        required: ['project_instructions', 'fast_forward_skill', 'execution_ownership_skill'],
        properties: {
          project_instructions: contractRefSchema,
          fast_forward_skill: contractRefSchema,
          execution_ownership_skill: contractRefSchema,
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'orchestration.start',
      args || {},
      (input) => createPostgresTargetAwareOrchestrationRunService({ db:ctx?.db }).start(input),
      {
        statusForFailure: statusForTargetAwareOrchestrationError,
        defaultError: 'ORCHESTRATION_START_ERROR',
        defaultMessage: 'orchestration.start failed',
        flattenDetails: true,
        db: ctx?.db,
      },
    );
    return response.body;
  },
};