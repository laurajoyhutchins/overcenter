import { api } from 'hatchable';

const ACTIONS = Object.freeze({
  issue_label_retire: {
    operation: 'RetireLinearIssueLabel',
    field: 'issueLabelRetire',
    mutation: `mutation RetireLinearIssueLabel($id: String!) { issueLabelRetire(id: $id) { success } }`,
  },
  issue_label_restore: {
    operation: 'RestoreLinearIssueLabel',
    field: 'issueLabelRestore',
    mutation: `mutation RestoreLinearIssueLabel($id: String!) { issueLabelRestore(id: $id) { success } }`,
  },
  workflow_state_archive: {
    operation: 'ArchiveLinearWorkflowState',
    field: 'workflowStateArchive',
    mutation: `mutation ArchiveLinearWorkflowState($id: String!) { workflowStateArchive(id: $id) { success } }`,
  },
  workflow_state_rename: {
    operation: 'RenameLinearWorkflowState',
    field: 'workflowStateUpdate',
    mutation: `mutation RenameLinearWorkflowState($id: String!, $name: String!, $description: String) { workflowStateUpdate(id: $id, input: { name: $name, description: $description }) { success } }`,
  },
  project_archive: {
    operation: 'ArchiveLinearProject',
    field: 'projectArchive',
    mutation: `mutation ArchiveLinearProject($id: String!) { projectArchive(id: $id, trash: false) { success } }`,
  },
  project_restore: {
    operation: 'RestoreLinearProject',
    field: 'projectUnarchive',
    mutation: `mutation RestoreLinearProject($id: String!) { projectUnarchive(id: $id) { success } }`,
  },
});

function maintenanceError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function normalizeAction(value) {
  const action = String(value || '').trim();
  if (!Object.hasOwn(ACTIONS, action)) {
    throw maintenanceError('LINEAR_MAINTENANCE_INVALID_ACTION', 'action is not an allowed Linear maintenance operation', { allowed: Object.keys(ACTIONS) });
  }
  return action;
}

function normalizeId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 128) throw maintenanceError('LINEAR_MAINTENANCE_INVALID_ID', 'id must be between 1 and 128 characters');
  return id;
}

async function invoke(apiBinding, spec, variables) {
  let response;
  try {
    response = await apiBinding.call('linear', {
      method: 'POST',
      path: '',
      headers: { 'Content-Type': 'application/json' },
      body: { query: spec.mutation, variables },
    });
  } catch (error) {
    throw maintenanceError('LINEAR_MAINTENANCE_INDETERMINATE', String(error?.message || 'Linear transport failed after mutation attempt'), {
      may_have_mutated: true,
      upstream_code: error?.code || null,
    });
  }

  if (!response || response.status < 200 || response.status >= 300) {
    throw maintenanceError('LINEAR_MAINTENANCE_INDETERMINATE', `Linear API returned HTTP ${response?.status ?? 'unknown'}`, {
      may_have_mutated: true,
      status: response?.status ?? null,
    });
  }

  let body = response.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch {
      throw maintenanceError('LINEAR_MAINTENANCE_INDETERMINATE', 'Linear API returned a non-JSON mutation response', { may_have_mutated: true });
    }
  }

  if (Array.isArray(body?.errors) && body.errors.length) {
    throw maintenanceError('LINEAR_MAINTENANCE_UPSTREAM_GRAPHQL', String(body.errors[0]?.message || 'Linear GraphQL mutation failed'), {
      may_have_mutated: false,
      errors: body.errors.map(error => ({ message: String(error?.message || 'Linear GraphQL error'), code: error?.extensions?.code || null })),
    });
  }

  if (body?.data?.[spec.field]?.success !== true) {
    throw maintenanceError('LINEAR_MAINTENANCE_NOT_CONFIRMED', `Linear did not confirm ${spec.field}`, { may_have_mutated: true });
  }
}

export function createLinearMaintenanceService({ apiBinding = api } = {}) {
  return {
    async apply({ action: rawAction, id: rawId, name: rawName, description: rawDescription, dry_run: dryRun = false } = {}) {
      const action = normalizeAction(rawAction);
      const id = normalizeId(rawId);
      const spec = ACTIONS[action];
      const variables = { id };
      if (action === 'workflow_state_rename') {
        const name = String(rawName || '').trim();
        if (!name || name.length > 64) throw maintenanceError('LINEAR_MAINTENANCE_INVALID_NAME', 'name must be between 1 and 64 characters for workflow_state_rename');
        const description = rawDescription == null ? null : String(rawDescription).trim().slice(0, 500);
        variables.name = name;
        variables.description = description || null;
      }
      if (dryRun === true) {
        return { ok: true, action, id, name: variables.name || null, changed: false, dry_run: true, operation: spec.operation };
      }
      await invoke(apiBinding, spec, variables);
      return { ok: true, action, id, name: variables.name || null, changed: true, operation: spec.operation };
    },
  };
}

export async function applyLinearMaintenance(input, options = {}) {
  return createLinearMaintenanceService(options).apply(input);
}

export const linearMaintenanceActions = Object.freeze(Object.keys(ACTIONS));