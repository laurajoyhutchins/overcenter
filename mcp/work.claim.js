import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';
import { canonicalClaimCommand } from 'lib/operator-commands.js';

export const access = 'admin';

export default {
  name: 'work.claim',
  description: 'Acquire one bounded exclusive lease for already-selected work. Supply the exact fresh Linear state and lane you observed; deterministic infrastructure supplies the retry identity and ordinary lease duration.',
  inputSchema: {
    type: 'object',
    required: ['work_ref','run_id','observed_state','observed_lane'],
    properties: {
      work_ref: { type: 'string' },
      run_id: { type: 'string', minLength: 1, maxLength: 512 },
      observed_state: { type: 'string', description: 'Exact fresh Linear lifecycle state used to select this gate.' },
      observed_lane: { type: 'string', description: 'Exact fresh execution lane used to select this gate.' },
      lease_seconds: { type: 'integer', minimum: 60, maximum: 3600, description: 'Optional narrower/explicit lease duration. Omit for the ordinary bounded default.' },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const input = await canonicalClaimCommand(args || {}, ctx?.db);
    const response = await executeCorrelatedCommand(
      'work.claim', input,
      (request) => createPostgresWorkLeaseService({ db: ctx?.db }).claim(request),
      { statusForFailure: statusForWorkLeaseError, defaultError: 'WORK_CLAIM_ERROR', defaultMessage: 'work.claim failed', flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};