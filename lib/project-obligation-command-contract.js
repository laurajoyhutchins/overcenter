import { normalizeProjectAmendRequest } from './project-authoring-command-contract.js';

function fail(message, details = null) {
  const error = new Error(message);
  Object.assign(error, { code:'PROJECT_OBLIGATION_COMMAND_INVALID', details });
  throw error;
}

function record(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`, { field });
  return value;
}

function text(value, field) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail(`${field} must be a non-empty string`, { field });
  return normalized;
}

function exactKeys(input, allowed, field) {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length) fail(`${field} contains unsupported fields`, { field, unknown });
}

export function normalizeProjectAddObligationRequest(raw) {
  const input = record(raw, 'project.add_obligation request');
  exactKeys(input, ['project_ref', 'expected_revision', 'obligation'], 'project.add_obligation request');
  const obligation = record(input.obligation, 'obligation');
  exactKeys(obligation, ['id', 'desired_outcome', 'priority', 'requires', 'executor', 'acceptance_evidence'], 'obligation');

  const id = text(obligation.id, 'obligation.id');
  const desiredOutcome = text(obligation.desired_outcome, 'obligation.desired_outcome');
  const priority = obligation.priority === undefined ? 50 : obligation.priority;
  if (!Number.isInteger(priority)) fail('obligation.priority must be an integer', { field:'obligation.priority' });
  const requires = obligation.requires === undefined ? [] : obligation.requires;
  if (!Array.isArray(requires)) fail('obligation.requires must be an array', { field:'obligation.requires' });
  const executor = obligation.executor === undefined
    ? Object.freeze({ kind:'agent', role:'implementation', skill:'test-driven-development' })
    : record(obligation.executor, 'obligation.executor');
  const acceptanceEvidence = obligation.acceptance_evidence;
  if (!Array.isArray(acceptanceEvidence) || acceptanceEvidence.length === 0) fail('obligation.acceptance_evidence must be a non-empty array', { field:'obligation.acceptance_evidence' });

  return normalizeProjectAmendRequest({
    project_ref:input.project_ref,
    expected_revision:input.expected_revision,
    amendment:{
      upsert_transitions:[{
        id,
        priority,
        requires,
        executor,
        execution_intent:{
          schema:'project-execution-intent-v1',
          desired_outcome:desiredOutcome,
          acceptance_evidence:acceptanceEvidence,
        },
      }],
    },
  });
}