import { projectTransitionDependencyFingerprint } from '../src/semantic/project-transition-dependency-fingerprint.js';

const fingerprint = await projectTransitionDependencyFingerprint({
  transition_id: 'transition-c',
  requires: ['transition-b', 'transition-a'],
});

const stableFingerprint: string = fingerprint;
void stableFingerprint;