import type { GitSha, SemanticIdentity } from './semantic-identities.js';

export type RuntimeArtifactDigest = SemanticIdentity<'RuntimeArtifactDigest'>;
export type DeploymentRef = SemanticIdentity<'DeploymentRef'>;
export type RuntimeFence = SemanticIdentity<'RuntimeFence'>;

export interface RuntimeArtifactIdentity {
  readonly sourceRevision: GitSha;
  readonly artifactDigest: RuntimeArtifactDigest;
}

export interface RuntimeArtifact {
  readonly sourceRevision: GitSha;
  readonly artifactDigest: RuntimeArtifactDigest;
}

export interface RuntimeObservation {
  readonly deploymentRef: DeploymentRef;
  readonly observedArtifactDigest: RuntimeArtifactDigest;
  readonly fence: RuntimeFence;
}

export interface VerifiedRuntime {
  readonly artifact: RuntimeArtifact;
  readonly observation: RuntimeObservation;
}
