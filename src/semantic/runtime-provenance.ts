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

export interface RuntimeDeployment {
  readonly deploymentRef: DeploymentRef;
  readonly fence: RuntimeFence;
}

export interface RuntimePublisher {
  publish(
    artifact: RuntimeArtifact,
    expectedFence: RuntimeFence | null,
  ): Promise<RuntimeDeployment>;
}

export interface RuntimeObserver {
  observe(deploymentRef: DeploymentRef): Promise<RuntimeObservation>;
}

export interface VerifiedRuntime {
  readonly artifact: RuntimeArtifact;
  readonly observation: RuntimeObservation;
}

export function verifyRuntimeObservation(
  artifact: RuntimeArtifact,
  observation: RuntimeObservation,
): VerifiedRuntime {
  if (artifact.artifactDigest !== observation.observedArtifactDigest) {
    throw Object.assign(
      new Error('Runtime observation does not match the intended immutable runtime artifact.'),
      { code: 'RUNTIME_ARTIFACT_MISMATCH' as const },
    );
  }

  return { artifact, observation };
}

export async function publishAndVerifyRuntime(
  artifact: RuntimeArtifact,
  publisher: RuntimePublisher,
  observer: RuntimeObserver,
  expectedFence: RuntimeFence | null,
): Promise<VerifiedRuntime> {
  const deployment = await publisher.publish(artifact, expectedFence);
  const observation = await observer.observe(deployment.deploymentRef);

  if (observation.deploymentRef !== deployment.deploymentRef) {
    throw Object.assign(
      new Error('Runtime observation resolved a different deployment than the published deployment.'),
      { code: 'RUNTIME_DEPLOYMENT_MISMATCH' as const },
    );
  }

  return verifyRuntimeObservation(artifact, observation);
}
