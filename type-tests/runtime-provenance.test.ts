import type {
  DeploymentRef,
  RuntimeArtifact,
  RuntimeArtifactDigest,
  RuntimeFence,
  RuntimeObservation,
  VerifiedRuntime,
} from '../src/semantic/runtime-provenance.js';
import type { GitSha } from '../src/semantic/semantic-identities.js';

declare const sourceRevision: GitSha;
declare const artifactDigest: RuntimeArtifactDigest;
declare const deploymentRef: DeploymentRef;
declare const fence: RuntimeFence;
declare const rawDigest: string;

const artifact: RuntimeArtifact = {
  sourceRevision,
  artifactDigest,
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

// @ts-expect-error Runtime artifacts must carry branded immutable artifact identity, not arbitrary provider strings.
const unbrandedArtifact: RuntimeArtifact = { sourceRevision, artifactDigest: rawDigest };
void unbrandedArtifact;

// @ts-expect-error Runtime observations must preserve the same branded artifact identity across the deployment boundary.
const unbrandedObservation: RuntimeObservation = { deploymentRef, observedArtifactDigest: rawDigest, fence };
void unbrandedObservation;
