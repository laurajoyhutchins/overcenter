import type {
  DeploymentRef,
  RuntimeArtifact,
  RuntimeDeployment,
  RuntimeFence,
  RuntimeObservation,
  RuntimeObserver,
  RuntimePublisher,
} from '../src/semantic/runtime-provenance.js';

declare const artifact: RuntimeArtifact;
declare const expectedFence: RuntimeFence | null;
declare const deploymentRef: DeploymentRef;
declare const publisher: RuntimePublisher;
declare const observer: RuntimeObserver;

const deployment: Promise<RuntimeDeployment> = publisher.publish(artifact, expectedFence);
const observation: Promise<RuntimeObservation> = observer.observe(deploymentRef);

void deployment;
void observation;