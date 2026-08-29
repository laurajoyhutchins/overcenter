import type { GitSha, SemanticIdentity } from './semantic-identities.js';

export type ArtifactDigest = SemanticIdentity<'ArtifactDigest'>;
export type RuntimeFenceCoordinate = SemanticIdentity<'RuntimeFenceCoordinate'>;
export type DeploymentReference = SemanticIdentity<'DeploymentReference'>;

export type RuntimeArtifact = {
  readonly source_revision: GitSha;
  readonly artifact_digest: string;
  readonly manifest_digest: string;
};

export type RuntimeFence = {
  readonly opaque: string;
};

export type DeploymentRef = {
  readonly opaque: string;
};

export type RuntimeObservation = {
  readonly deployment: DeploymentRef;
  readonly observed_artifact_digest: string;
  readonly observed_at: string;
};

export type VerifiedRuntime = {
  readonly artifact: RuntimeArtifact;
  readonly deployment: DeploymentRef;
  readonly observation: RuntimeObservation;
  readonly verified_at: string;
};