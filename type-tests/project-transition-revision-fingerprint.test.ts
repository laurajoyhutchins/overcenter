import { projectTransitionRevisionFingerprint } from '../src/semantic/project-transition-revision-fingerprint.js';

const fingerprint = await projectTransitionRevisionFingerprint({
  transition_id: 'transition-a',
  priority: 75,
  executor: { kind: 'agent', role: 'implementation', skill: 'test-driven-development' },
  phase_bindings: {},
});

const stableFingerprint: string = fingerprint;
void stableFingerprint;
