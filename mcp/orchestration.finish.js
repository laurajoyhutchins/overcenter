import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresSubjectAwareOrchestrationRunService } from 'lib/orchestration-finish-runtime.js';
import { statusForOrchestrationRunError } from 'lib/orchestration-runs.js';
import { canonicalFinishCommand } from 'lib/operator-commands.js';

export const access = 'admin';

export default {
  name: 'orchestration.finish',
  description: 'Terminalize one orchestration run. If the run still owns a live lease, supply explicit active_lease_settlement semantics and the control plane will settle that exact lease through its authoritative subject-specific path before finishing. The control plane never guesses completed, requeue, or blocked.',
  inputSchema: {
    type: 'object',
    required: ['run_id','disposition'],
    properties: {
      run_id: { type: 'string', minLength: 1, maxLength: 512 },
      disposition: { type: 'string', enum: ['completed','clean-stop','clean_stop','blocked','failed','no-work','no_work'] },
      last_work_ref: { type: ['string','null'] },
      last_gate: { type: ['string','null'] },
      stop_reason: { type: ['string','null'] },
      active_lease_settlement: {
        type: ['object','null'],
        properties: {
          disposition: { type: 'string', enum: ['completed','requeue','blocked'] },
          evidence: { type: 'array', items: { type: 'object' } },
          reason: { type: ['string','null'] },
          promotion_condition: { type: ['string','null'] },
          requeue_class: { type: ['string','null'] },
          continuation: { type: ['object','null'] },
          next_state: { type: ['string','null'] },
          next_lane: { type: ['string','null'] },
        },
        required: ['disposition'],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const input = canonicalFinishCommand(args || {});
    const response = await executeCorrelatedCommand(
      'orchestration.finish',
      input,
      (request) => createPostgresSubjectAwareOrchestrationRunService({ db:ctx?.db }).finish(request),
      {
        statusForFailure: statusForOrchestrationRunError,
        defaultError: 'ORCHESTRATION_FINISH_ERROR',
        defaultMessage: 'orchestration.finish failed',
        flattenDetails: true,
        db: ctx?.db,
      },
    );
    return response.body;
  },
};