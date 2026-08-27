import { executeWorkClaimBoundary } from 'lib/work-claim-boundary.js';

export const access = 'admin';

export default {
  name: 'work.claim',
  description: 'Acquire one bounded exclusive lease for already-selected work using the exact authoritative revision returned by the control plane. Pass observed_revision; infrastructure rereads Linear, requires the current Todo gate to contain a handoff-ready Outcome and Next action, derives lifecycle and lane, enforces run scope and revision fences, and supplies retry identity and ordinary lease duration. Do not reconstruct lifecycle or lane strings.',
  inputSchema: {
    type: 'object',
    required: ['work_ref','run_id','observed_revision'],
    properties: {
      work_ref: { type: 'string' },
      run_id: { type: 'string', minLength: 1, maxLength: 512 },
      observed_revision: { type: 'string', description: 'Exact fresh authoritative revision returned by the control-plane observation/horizon path.' },
      lease_seconds: { type: 'integer', minimum: 60, maximum: 3600, description: 'Optional compatibility override. Ordinary workers should omit it so infrastructure derives the bounded default.' },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const response = await executeWorkClaimBoundary(args || {}, { db: ctx?.db });
    return response.body;
  },
};