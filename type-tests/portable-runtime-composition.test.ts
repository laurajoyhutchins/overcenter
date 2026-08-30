import {
  type RuntimeArtifact,
  type RuntimeFence,
  type RuntimeObserver,
  type RuntimePublisher,
  type VerifiedRuntime,
} from '../src/semantic/runtime-provenance.js';
import { createPortableRuntime } from '../src/runtime/portable-runtime.js';

declare const artifact: RuntimeArtifact;
declare const publisher: RuntimePublisher;
declare const observer: RuntimeObserver;
declare const expectedFence: RuntimeFence | null;

const runtime = createPortableRuntime({ publisher, observer });
const verified: Promise<VerifiedRuntime> = runtime.publishAndVerify(artifact, expectedFence);

void verified;