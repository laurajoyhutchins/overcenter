import assert from 'node:assert/strict';

import { classifyOrchestrationFailure } from 'lib/orchestration-failures.js';

const classification = classifyOrchestrationFailure({
  command: 'github.apply_changeset',
  error_code: 'CREATE_TARGET_EXISTS',
  error_class: 'precondition',
  may_have_mutated: false,
  details: { path: 'scripts/test-audit-core.mjs' },
});

assert.equal(classification.failure_state, 'REQUEST_PRECONDITION_CHANGED');
assert.equal(classification.automatic_recovery_allowed, false);
assert.equal(classification.escalation_required, false);
assert.equal(classification.recovery_operation?.command, 'github.apply_changeset');
assert.equal(classification.recovery_operation?.mode, 'reread_exact_workspace_tree_and_recompute_request');
assert.equal(classification.recovery_operation?.use_original_request, false);
assert.deepEqual(classification.recovery_operation?.requires, [
  'exact_workspace_tree',
  'corrected_changeset_operation',
]);

console.log(JSON.stringify({
  ok: true,
  failure_state: classification.failure_state,
  recovery_mode: classification.recovery_operation?.mode,
}));
