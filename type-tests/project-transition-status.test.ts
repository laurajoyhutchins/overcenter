import { projectTransitionStatus } from '../src/semantic/project-transition-status.js';

const status = projectTransitionStatus({
  project_ref: 'github:owner/repo',
  authority: { revision: 'a'.repeat(40) },
  nodes: [
    {
      id: 'build',
      state: 'READY',
      unmet_requirements: [],
      lifecycle: { current_stage: 'ENABLE', next_stage: 'ENABLE' },
      executor: { kind: 'agent', role: 'implementation', skill: 'test-driven-development' },
    },
  ],
  active_leases: [{ transition_id: 'build', lease_ref: 'lease-1', run_id: 'run-1', authority_revision: 'a'.repeat(40) }],
});

const executing: 'EXECUTING' = status.transitions[0]!.state;
const phase: 'EXECUTE' = status.transitions[0]!.lifecycle_phase;
void executing;
void phase;