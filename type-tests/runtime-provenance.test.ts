import type { RuntimeArtifact, RuntimeFence, DeploymentRef, RuntimeObservation, VerifiedRuntime } from '../src/semantic/runtime-provenance.js';
import type { GitSha } from '../src/semantic/semantic-identities.js';

declare const sourceRevision: GitSha;
const artifact: RuntimeArtifact = { source_revision: sourceRevision, artifact_digest: 'sha256:artifact', manifest_digest: 'sha256:manifest' };
const fence: RuntimeFence = { opaque: 'runtime-cas-coordinate' };
const deployment: DeploymentRef = { opaque: 'deployment-reference' };
const observation: RuntimeObservation = { deployment, observed_artifact_digest: artifact.artifact_digest, observed_at: '2026-08-29T00:00:00Z' };
const verified: VerifiedRuntime = { artifact, deployment, observation, verified_at: '2026-08-29T00:00:01Z' };
void fence;
void verified;