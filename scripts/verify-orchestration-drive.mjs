import assert from 'node:assert/strict';
import { CANONICAL_COMMANDS } from '../lib/canonical-commands.js';
import { createOrchestrationDriveService } from '../lib/orchestration-drive.js';

assert.ok(CANONICAL_COMMANDS.includes('orchestration.drive'), 'orchestration.drive must be registered as a canonical command');

const deterministic = [];
const service = createOrchestrationDriveService({
  max_advances:4,
  advance:async ({ run_id }) => {
    deterministic.push(run_id);
    if (deterministic.length < 3) return { ok:true, outcome:'TRANSITION_CONFIRMED', run_id, project_ref:'github:owner/repo', transition:{ id:`operator-${deterministic.length}`, executor:{ kind:'operator', command:'orchestration.maintain' } }, frontier:[`next-${deterministic.length}`], authority:{ kind:'github', repository:'owner/repo', revision:'a'.repeat(40), derivation:'test' } };
    return { ok:true, outcome:'AGENT_EXECUTION_REQUIRED', run_id, project_ref:'github:owner/repo', transition:{ id:'agent-work', executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }, lease_ref:'lease-ref', frontier:['agent-work'], authority:{ kind:'github', repository:'owner/repo', revision:'a'.repeat(40), derivation:'test' } };
  },
});
const result = await service.drive({ run_id:'driver-red' });
assert.equal(result.stop_class, 'AGENT_EXECUTION_REQUIRED');
assert.equal(result.transitions_attempted, 3);
assert.equal(result.transitions_confirmed, 2);
assert.equal(result.deterministic_transitions_completed, 2);
assert.equal(result.agent_boundary?.transition?.id, 'agent-work');
assert.deepEqual(deterministic, ['driver-red','driver-red','driver-red']);