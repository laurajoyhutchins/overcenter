import { classifyCommandError, commandFailure } from '../lib/command-response.js';

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

const code = 'PROJECT_DEFINITION_MUTATION_AUTHORITY_STALE';
const classification = classifyCommandError(code);
assert(classification.error_class === 'precondition', `expected precondition, got ${classification.error_class}`);
assert(classification.http_status === 409, `expected HTTP 409, got ${classification.http_status}`);
assert(classification.retryable === false, 'stale mutation authority must not be retryable');
assert(classification.rejection === true, 'stale mutation authority must be an expected rejection');

const response = commandFailure('project.amend', {
  ok: false,
  error: code,
  message: 'project definition authority is stale',
  may_have_mutated: false,
});
assert(response.status === 409, `expected worker boundary HTTP 409, got ${response.status}`);
assert(response.body.error === code, `stable error was sanitized to ${response.body.error}`);
assert(response.body.error_code === code, `canonical error_code was ${response.body.error_code}`);
assert(response.body.error_class === 'precondition', `worker boundary class was ${response.body.error_class}`);
assert(response.body.rejection === true, 'worker boundary lost rejection semantics');
assert(response.body.may_have_mutated === false, 'stale precondition must remain non-mutating');

console.log('project authoring stale worker boundary regression passed');