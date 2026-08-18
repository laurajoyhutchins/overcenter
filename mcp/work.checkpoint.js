import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';

export const access = 'admin';

const evidence = {
  type: 'array',
  maxItems: 50,
  items: { type: 'object', required: ['kind','ref'], properties: { kind: { type: 'string' }, ref: { type: 'string' } }, additionalProperties: false },
};

export default {
  name: 'work.checkpoint',
  description: 'Persist one bounded non-authoritative progress checkpoint under an active work lease. It does not change Linear lifecycle or lane; a later requeue, expiry recovery, or successor claim may resume from it when the semantic execution fingerprint still matches.',
  inputSchema: {
    type: 'object',
    required: ['lease_token','checkpoint','idempotency_key'],
    properties: {
      lease_token: { type: 'string' },
      idempotency_key: { type: 'string' },
      run_id: { type: 'string', minLength: 1, maxLength: 512 },
      checkpoint: {
        type: 'object',
        required: ['phase','next_action_kind'],
        properties: {
          schema: { type: 'string', enum: ['work-checkpoint-v1'] },
          phase: { type: 'string' },
          next_action_kind: { type: 'string', enum: ['continue_research','apply_repository_change','run_materializer','verify_candidate','remediate_candidate','integrate_candidate','recheck_external_condition'] },
          candidate: { type: ['object','null'] },
          completed: evidence,
          evidence,
          authority_revisions: {
            type: 'array', maxItems: 25,
            items: { type: 'object', required: ['kind','ref','revision'], properties: { kind: { type: 'string' }, ref: { type: 'string' }, revision: { type: 'string' } }, additionalProperties: false },
          },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'work.checkpoint',
      args || {},
      (input) => createPostgresWorkLeaseService().checkpoint(input),
      {
        statusForFailure: statusForWorkLeaseError,
        defaultError: 'WORK_CHECKPOINT_ERROR',
        defaultMessage: 'work.checkpoint failed',
        flattenDetails: true,
        db: ctx?.db,
      },
    );
    return response.body;
  },
};