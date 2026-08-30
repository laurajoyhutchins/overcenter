import type {
  DeploymentRef,
  RuntimeArtifact,
  RuntimeFence,
  RuntimeObservation,
  VerifiedRuntime,
} from '../src/semantic/runtime-provenance.js';
import type { GitSha } from '../src/semantic/semantic-identities.js';

declare const sourceRevision: GitSha;
declare const deploymentRef: DeploymentRef;
declare const fence: RuntimeFence;

const artifact: RuntimeArtifact = {
  sourceRevision,
  artifactDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

const observation: RuntimeObservation = {
  deploymentRef,
  observedArtifactDigest: artifact.artifactDigest,
  fence,
};

const verified: VerifiedRuntime = {
  artifact,
  observation,
};

void verified;

// @ts-expect-error Provider deployment arithmetic must not enter semantic runtime provenance.
const hatchableVersion: RuntimeArtifact = { sourceRevision, artifactDigest: artifact.artifactDigest, hatchableVersion: 382 };
void hatchableVersion;

// @ts-expect-error Runtime verification requires the intended artifact and an actual observation.
const unobserved: VerifiedRuntime = { artifact };
void unobserved;