import { createNodePostgresRuntime } from '../src/runtime/node-postgres-runtime.js';
import type { RuntimeProvenance } from '../src/semantic/runtime-provenance.js';

const runtime = createNodePostgresRuntime({
  query: async (_text: string, _values: readonly unknown[] = []) => ({ rows: [] }),
});

const provenance: RuntimeProvenance = {
  source_revision: '0123456789abcdef0123456789abcdef01234567',
  artifact_ref: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

void runtime.publishAndVerify({
  provenance,
  artifact: new Uint8Array(),
});