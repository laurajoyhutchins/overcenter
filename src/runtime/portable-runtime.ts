import {
  publishAndVerifyRuntime,
  type RuntimeArtifact,
  type RuntimeFence,
  type VerifiedRuntime,
} from '../semantic/runtime-provenance.js';
import type { PortableRuntimePorts } from '../ports/portable-runtime.js';

export type { PortableRuntimePorts } from '../ports/portable-runtime.js';

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