import { projectTransitionDependencyFingerprint } from '../src/semantic/project-graph-reconciliation.js';

const fingerprint = projectTransitionDependencyFingerprint({
  transition_id: 'transition-c',
  requires: ['transition-a', 'transition-b'],
});

const stableFingerprint: string = fingerprint;
void stableFingerprint;