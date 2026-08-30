import type { GitSha, SemanticIdentity } from './semantic-identities.js';

export type DeploymentRef = SemanticIdentity<'DeploymentRef'>;
export type RuntimeFence = SemanticIdentity<'RuntimeFence'>;

export interface RuntimeArtifact {
  readonly sourceRevision: GitSha;
  readonly artifactDigest: string;
}

export interface RuntimeObservation {
  readonly deploymentRef: DeploymentRef;
  readonly observedArtifactDigest: string;
  readonly fence: RuntimeFence;
}

export interface VerifiedRuntime {
  readonly artifact: RuntimeArtifact;
  readonly observation: RuntimeObservation;
}