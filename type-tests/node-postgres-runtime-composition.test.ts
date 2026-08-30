import { createNodePostgresRuntime } from '../src/runtime/node-postgres-runtime.js';
import type { RuntimeArtifact } from '../src/semantic/runtime-provenance.js';

const runtime = createNodePostgresRuntime({
  query: async <Row extends Record<string, unknown>>(
    _text: string,
    _values: readonly unknown[] = [],
  ) => ({ rows: [] as Row[] }),
});

const artifact = {
  sourceRevision: '0123456789abcdef0123456789abcdef01234567',
  artifactDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as RuntimeArtifact;

void runtime.publishAndVerify(artifact, null);