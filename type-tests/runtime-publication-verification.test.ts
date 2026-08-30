import {
  publishAndVerifyRuntime,
  type RuntimeArtifact,
  type RuntimeFence,
  type RuntimeObserver,
  type RuntimePublisher,
  type VerifiedRuntime,
} from '../src/semantic/runtime-provenance.js';

declare const artifact: RuntimeArtifact;
declare const publisher: RuntimePublisher;
declare const observer: RuntimeObserver;
declare const expectedFence: RuntimeFence | null;

const verified: Promise<VerifiedRuntime> = publishAndVerifyRuntime(
  artifact,
  publisher,
  observer,
  expectedFence,
);

void verified;
