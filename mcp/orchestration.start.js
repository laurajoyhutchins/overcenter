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
        properties: {
          project: { type: 'string', description: 'Legacy single-project scope. Do not combine with team/projects.' },
          team: { type: 'string', description: 'Team name or ID for campaign-aware scope when project is omitted.' },
          projects: { type: 'array', items: { type: 'string' }, maxItems: 25, description: 'Optional allowed project names or IDs within team scope. Empty means any project or unprojected issue in the team.' },
          lanes: { type: 'array', items: { type: 'string' }, maxItems: 8 },
          repositories: { type: 'array', items: { type: 'string' }, maxItems: 25 },
          direction: { type: ['string', 'null'] },
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