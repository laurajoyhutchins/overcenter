import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { archiveLinearIssue } from 'lib/linear-archive.js';

export const access = 'admin';

export default {
  name: 'archive_linear_issue',
  description: 'Archive one completed or canceled Linear issue after its durable outcome is established. Refuses non-terminal issues, is idempotent for already-archived issues, never deletes issues, and participates in canonical run correlation when run_id is supplied.',
  inputSchema: {
    type: 'object',
    required: ['issue'],
    properties: {
      issue: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Linear issue identifier such as LJH-123, or the issue UUID.',
      },
      dry_run: {
        type: 'boolean',
        default: false,
        description: 'When true, validate and report archive eligibility without archiving the issue.',
      },
      run_id: {
        type: 'string',
        minLength: 1,
        maxLength: 512,
        description: 'Optional orchestration run token used only for run correlation.',
      },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'linear.archive',
      args || {},
      (input) => archiveLinearIssue({ issue: input.issue, dryRun: input.dry_run === true }),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};