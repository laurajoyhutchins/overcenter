import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRuntimeObservation } from '../lib/runtime-provenance.js';

test('verifies a runtime only when the observed immutable artifact matches the intended artifact', () => {
  const artifact = {
    sourceRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    artifactDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  };
  const observation = {
    deploymentRef: 'provider:deployment:385',
    observedArtifactDigest: artifact.artifactDigest,
    fence: 'provider:fence:385',
  };

  assert.deepEqual(verifyRuntimeObservation(artifact, observation), { artifact, observation });
});

test('fails closed when runtime artifact identity does not match', () => {
  const artifact = {
    sourceRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    artifactDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  };
  const observation = {
    deploymentRef: 'provider:deployment:385',
    observedArtifactDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    fence: 'provider:fence:385',
  };

  assert.throws(
    () => verifyRuntimeObservation(artifact, observation),
    error => error?.code === 'RUNTIME_ARTIFACT_MISMATCH',
  );
});