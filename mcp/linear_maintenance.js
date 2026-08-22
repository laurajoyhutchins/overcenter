import { applyLinearMaintenance, linearMaintenanceActions } from 'lib/linear-maintenance.js';

export const access = 'admin';

export default {
  name: 'linear_maintenance',
  description: 'Apply one narrow native Linear maintenance operation that is not exposed by the primary connector. No arbitrary GraphQL is accepted.',
  inputSchema: {
    type: 'object',
    required: ['action', 'id'],
    properties: {
      action: { type: 'string', enum: linearMaintenanceActions },
      id: { type: 'string', minLength: 1, maxLength: 128 },
      name: { type: 'string', minLength: 1, maxLength: 64, description: 'Required only for workflow_state_rename.' },
      description: { type: 'string', maxLength: 500, description: 'Optional workflow-state description for workflow_state_rename.' },
      dry_run: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  async execute(input) { return applyLinearMaintenance(input); },
};