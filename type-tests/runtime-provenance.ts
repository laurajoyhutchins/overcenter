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
  sourceRevision,
  artifactDigest,
};

const observation: RuntimeObservation = {
  deploymentRef,
  observedArtifactDigest: artifactDigest,
  fence: runtimeFence,
};

const verified: VerifiedRuntime = { artifact, observation };
void verified;

// Provider deployment identity cannot masquerade as immutable artifact identity.
// @ts-expect-error branded deployment references and artifact digests are distinct semantic identities.
const invalidArtifact: RuntimeArtifact = { sourceRevision, artifactDigest: deploymentRef };
void invalidArtifact;