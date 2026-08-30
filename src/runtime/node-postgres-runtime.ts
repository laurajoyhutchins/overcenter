import { createPortableRuntime, type PortableRuntime } from './portable-runtime.js';
import type {
  DeploymentRef,
  RuntimeArtifact,
  RuntimeFence,
  RuntimeObserver,
  RuntimePublisher,
} from '../semantic/runtime-provenance.js';

export interface NodePostgresQueryResult<Row extends Record<string, unknown>> {
  readonly rows: readonly Row[];
}

export interface NodePostgresClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<NodePostgresQueryResult<Row>>;
}

interface DeploymentRow extends Record<string, unknown> {
  readonly deployment_ref: string;
  readonly artifact_digest: string;
  readonly fence: string;
}

function requireDeploymentRow(
  rows: readonly DeploymentRow[],
  deploymentRef: DeploymentRef,
): DeploymentRow {
  const row = rows[0];
  if (!row) {
    throw Object.assign(
      new Error(`Runtime deployment ${deploymentRef} was not observable in Postgres.`),
      { code: 'RUNTIME_DEPLOYMENT_NOT_FOUND' as const },
    );
  }
  return row;
}

export function createNodePostgresRuntime(client: NodePostgresClient): PortableRuntime {
  const publisher: RuntimePublisher = {
    async publish(artifact, expectedFence) {
      const deploymentRef = `runtime:${artifact.artifactDigest}` as DeploymentRef;
      const fence = `${artifact.sourceRevision}:${artifact.artifactDigest}` as RuntimeFence;

      if (expectedFence !== null) {
        const existing = await client.query<DeploymentRow>(
          'SELECT deployment_ref, artifact_digest, fence FROM overcenter_runtime_deployments WHERE deployment_ref = $1',
          [deploymentRef],
        );
        const row = requireDeploymentRow(existing.rows, deploymentRef);
        if (row.fence !== expectedFence) {
          throw Object.assign(new Error('Runtime fence does not match the observed Postgres deployment.'), {
            code: 'RUNTIME_FENCE_MISMATCH' as const,
          });
        }
      }

      await client.query(
        `INSERT INTO overcenter_runtime_deployments
          (deployment_ref, source_revision, artifact_digest, fence)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (deployment_ref) DO UPDATE SET
           source_revision = EXCLUDED.source_revision,
           artifact_digest = EXCLUDED.artifact_digest,
           fence = EXCLUDED.fence`,
        [deploymentRef, artifact.sourceRevision, artifact.artifactDigest, fence],
      );

      return { deploymentRef, fence };
    },
  };

  const observer: RuntimeObserver = {
    async observe(deploymentRef) {
      const result = await client.query<DeploymentRow>(
        'SELECT deployment_ref, artifact_digest, fence FROM overcenter_runtime_deployments WHERE deployment_ref = $1',
        [deploymentRef],
      );
      const row = requireDeploymentRow(result.rows, deploymentRef);
      return {
        deploymentRef: row.deployment_ref as DeploymentRef,
        observedArtifactDigest: row.artifact_digest as RuntimeArtifact['artifactDigest'],
        fence: row.fence as RuntimeFence,
      };
    },
  };

  return createPortableRuntime({ publisher, observer });
}