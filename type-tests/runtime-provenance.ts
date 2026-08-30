import type { GitSha } from '../src/semantic/semantic-identities.js';
import type {
  DeploymentRef,
  RuntimeArtifactDigest,
  RuntimeArtifactIdentity,
  RuntimeFence,
  RuntimeObservation,
  VerifiedRuntime,
} from '../src/semantic/runtime-provenance.js';

declare const sourceRevision: GitSha;
declare const artifactDigest: RuntimeArtifactDigest;
declare const runtimeFence: RuntimeFence;
declare const deploymentRef: DeploymentRef;

const artifactIdentity: RuntimeArtifactIdentity = {
  sourceRevision,
  artifactDigest,
};

const observation: RuntimeObservation = {
  deploymentRef,
  observedArtifactDigest: artifactDigest,
  fence: runtimeFence,
};

declare const verified: VerifiedRuntime;
void artifactIdentity;
void observation;
void verified;

// Provider deployment identity cannot masquerade as immutable artifact identity.
// @ts-expect-error branded deployment references and artifact digests are distinct semantic identities.
const invalidArtifactIdentity: RuntimeArtifactIdentity = { sourceRevision, artifactDigest: deploymentRef };
void invalidArtifactIdentity;