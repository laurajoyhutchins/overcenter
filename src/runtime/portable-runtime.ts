import {
  publishAndVerifyRuntime,
  type RuntimeArtifact,
  type RuntimeFence,
  type RuntimeObserver,
  type RuntimePublisher,
  type VerifiedRuntime,
} from '../semantic/runtime-provenance.js';

export interface PortableRuntimePorts {
  readonly publisher: RuntimePublisher;
  readonly observer: RuntimeObserver;
}

export interface PortableRuntime {
  publishAndVerify(
    artifact: RuntimeArtifact,
    expectedFence: RuntimeFence | null,
  ): Promise<VerifiedRuntime>;
}

export function createPortableRuntime({
  publisher,
  observer,
}: PortableRuntimePorts): PortableRuntime {
  return {
    publishAndVerify(artifact, expectedFence) {
      return publishAndVerifyRuntime(artifact, publisher, observer, expectedFence);
    },
  };
}