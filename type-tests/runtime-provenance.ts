import type { GitSha } from '../src/semantic/semantic-identities.js';
import type {
  DeploymentRef,
  RuntimeArtifact,
  RuntimeArtifactDigest,
  RuntimeFence,
  RuntimeObservation,
  VerifiedRuntime,
} from '../src/semantic/runtime-provenance.js';

declare const sourceRevision: GitSha;
declare const artifactDigest: RuntimeArtifactDigest;
declare const runtimeFence: RuntimeFence;
declare const deploymentRef: DeploymentRef;

const artifact: RuntimeArtifact = {
  source_revision: sourceRevision,
  artifact_digest: artifactDigest,
};

const observation: RuntimeObservation = {
  deployment_ref: deploymentRef,
  observed_artifact_digest: artifactDigest,
  observed_at: '2026-08-30T04:50:00.000Z',
};

const verified: VerifiedRuntime = {
  artifact,
  runtime_fence: runtimeFence,
  deployment_ref: deploymentRef,
  observation,
};

void verified;

// Provider deployment identity cannot masquerade as immutable artifact identity.
// @ts-expect-error branded deployment references and artifact digests are distinct semantic identities.
const invalidArtifact: RuntimeArtifact = { source_revision: sourceRevision, artifact_digest: deploymentRef };
void invalidArtifact;