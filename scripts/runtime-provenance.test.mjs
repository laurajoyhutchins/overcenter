import assert from 'node:assert/strict';
import test from 'node:test';
import {
  publishAndVerifyRuntime,
  verifyRuntimeObservation,
} from '../dist/lib/runtime-provenance.js';

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
    fence: 'provider:fence:386',
  };

  assert.throws(
    () => verifyRuntimeObservation(artifact, observation),
    error => error?.code === 'RUNTIME_ARTIFACT_MISMATCH',
  );
});

test('publishes, observes the returned deployment, and verifies immutable runtime evidence', async () => {
  const artifact = {
    sourceRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    artifactDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  };
  const expectedFence = 'provider:fence:384';
  const deployment = {
    deploymentRef: 'provider:deployment:385',
    fence: 'provider:fence:385',
  };
  const calls = [];
  const publisher = {
    async publish(receivedArtifact, receivedFence) {
      calls.push(['publish', receivedArtifact, receivedFence]);
      return deployment;
    },
  };
  const observer = {
    async observe(deploymentRef) {
      calls.push(['observe', deploymentRef]);
      return {
        deploymentRef,
        observedArtifactDigest: artifact.artifactDigest,
        fence: deployment.fence,
      };
    },
  };

  const verified = await publishAndVerifyRuntime(artifact, publisher, observer, expectedFence);

  assert.deepEqual(calls, [
    ['publish', artifact, expectedFence],
    ['observe', deployment.deploymentRef],
  ]);
  assert.equal(verified.artifact, artifact);
  assert.equal(verified.observation.deploymentRef, deployment.deploymentRef);
});

test('fails closed if the observer returns evidence for a different deployment', async () => {
  const artifact = {
    sourceRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    artifactDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  };
  const publisher = {
    async publish() {
      return {
        deploymentRef: 'provider:deployment:385',
        fence: 'provider:fence:385',
      };
    },
  };
  const observer = {
    async observe() {
      return {
        deploymentRef: 'provider:deployment:386',
        observedArtifactDigest: artifact.artifactDigest,
        fence: 'provider:fence:386',
      };
    },
  };

  await assert.rejects(
    publishAndVerifyRuntime(artifact, publisher, observer, null),
    error => error?.code === 'RUNTIME_DEPLOYMENT_MISMATCH',
  );
});
