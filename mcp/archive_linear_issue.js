import { archiveLinearIssue } from 'lib/linear-archive.js';

export const access = 'admin';

export default {
  name: 'archive_linear_issue',
  description: 'Archive one completed or canceled Linear issue after its durable outcome is established. Refuses non-terminal issues, is idempotent for already-archived issues, and never deletes issues. Use dry_run to check eligibility without changing Linear.',
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
    },
  },
  async handler(args) {
    try {
      return await archiveLinearIssue({
        issue: args?.issue,
        dryRun: args?.dry_run === true,
      });
    } catch (error) {
      if (error?.code === 'SetupRequired') {
        return {
          ok: false,
          action: 'archive_linear_issue',
          error: 'LINEAR_SETUP_REQUIRED',
          message: 'Connect the Linear API in the Portfolio Control Plane Hatchable Setup page.',
        };
      }
      throw error;
    }
  },
};