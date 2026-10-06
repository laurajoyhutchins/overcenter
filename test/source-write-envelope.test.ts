import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertSourceWriteEnvelope,
  bindSourceClaim,
  normalizeSourceWriteEnvelope,
  SOURCE_PROPOSAL_SCHEMA,
  SOURCE_TASK_SCHEMA,
  validateSourceTaskPacket,
  validateSourceProposal,
} from '../src/source/source-obligation.ts';

const envelope = {
  allowed_roots: ['src'],
  exact_paths: ['test/known.test.ts'],
  denied_roots: ['src/generated'],
  denied_paths: ['src/secrets.ts'],
  max_changed_files: 3,
  max_changed_bytes: 32,
};

function task(writeEnvelope: unknown = envelope) {
  return {
    schema: SOURCE_TASK_SCHEMA,
    kind: 'source-change',
    objective: 'Make a bounded source change.',
    writable_paths: [],
    write_envelope: writeEnvelope,
  };
}

test('write-envelope deny rules take precedence over broad allowed roots', () => {
  assert.throws(
    () =>
      assertSourceWriteEnvelope(task(), [{ path: 'src/generated/file.ts', changed_bytes: 1 }], []),
    /SOURCE_PROPOSAL_SCOPE_VIOLATION:src\/generated\/file\.ts/,
  );
  assert.throws(() => assertSourceWriteEnvelope(task(), [{ path: 'src/secrets.ts', changed_bytes: 1 }], []), /SOURCE_PROPOSAL_SCOPE_VIOLATION:src\/secrets\.ts/);
});

test('repository verification protected paths override broad roots and exact paths', () => {
  for (const path of ['.github/workflows/evil.yml', '.overcenter/policy.json', 'baseline.txt']) {
    assert.throws(
      () =>
        assertSourceWriteEnvelope(
          task({ ...envelope, allowed_roots: ['.'], exact_paths: [] }),
          [{ path, changed_bytes: 1 }],
          ['.github', '.overcenter', 'baseline.txt'],
        ),
      /SOURCE_CONTROL_PLANE_MUTATION_FORBIDDEN/,
    );
  }
});

test('file and byte budgets fail closed on the observed changed delta', () => {
  assert.throws(
    () =>
      assertSourceWriteEnvelope(
        task(),
        [
          { path: 'src/a.ts', changed_bytes: 1 },
          { path: 'src/b.ts', changed_bytes: 1 },
          { path: 'src/c.ts', changed_bytes: 1 },
          { path: 'src/d.ts', changed_bytes: 1 },
        ],
        [],
      ),
    /SOURCE_WRITE_ENVELOPE_FILE_BUDGET_EXCEEDED/,
  );
  assert.throws(() => assertSourceWriteEnvelope(task(), [{ path: 'src/a.ts', changed_bytes: 33 }], []), /SOURCE_WRITE_ENVELOPE_BYTE_BUDGET_EXCEEDED/);
});

test('write-envelope ordering is canonical and changes to its limits change identity', () => {
  const forward = validateSourceTaskPacket(task());
  const reversed = validateSourceTaskPacket(
    task({
      allowed_roots: [...envelope.allowed_roots].reverse(),
      exact_paths: [...envelope.exact_paths].reverse(),
      denied_roots: [...envelope.denied_roots].reverse(),
      denied_paths: [...envelope.denied_paths].reverse(),
      max_changed_files: envelope.max_changed_files,
      max_changed_bytes: envelope.max_changed_bytes,
    }),
  );
  assert.deepEqual(normalizeSourceWriteEnvelope(forward), normalizeSourceWriteEnvelope(reversed));
  assert.notDeepEqual(
    normalizeSourceWriteEnvelope(forward),
    normalizeSourceWriteEnvelope(task({ ...envelope, max_changed_bytes: 31 })),
  );
});

test('legacy writable_paths remain an exact-file write-envelope form', () => {
  const legacy = {
    schema: SOURCE_TASK_SCHEMA,
    kind: 'source-change',
    objective: 'Keep the old exact-file contract.',
    writable_paths: ['src/b.ts', 'src/a.ts'],
  };
  const normalized = validateSourceTaskPacket(legacy);
  assert.deepEqual(normalizeSourceWriteEnvelope(normalized), {
    allowed_roots: [],
    exact_paths: ['src/a.ts', 'src/b.ts'],
    denied_roots: [],
    denied_paths: [],
    max_changed_files: null,
    max_changed_bytes: null,
  });
  assert.deepEqual(
    assertSourceWriteEnvelope(legacy, [{ path: 'src/a.ts', changed_bytes: 1 }], []),
    ['src/a.ts'],
  );
  assert.throws(
    () => assertSourceWriteEnvelope(legacy, [{ path: 'src/c.ts', changed_bytes: 1 }], []),
    /SOURCE_PROPOSAL_SCOPE_VIOLATION:src\/c\.ts/,
  );
});

test('a source proposal may choose an initially unknown file beneath an allowed root', () => {
  const sourceTask = task();
  const claim = bindSourceClaim('key', 'run', 'revision', 'c'.repeat(40));
  const proposal = {
    schema: SOURCE_PROPOSAL_SCHEMA,
    run_id: claim.run_id,
    claimed_revision: claim.claimed_revision,
    claimed_source_sha: claim.source_sha,
    files: [
      {
        path: 'src/newly-discovered.test.ts',
        content_base64: Buffer.from('test content\n').toString('base64'),
      },
    ],
  };
  assert.deepEqual(validateSourceProposal(proposal, sourceTask, claim).files, proposal.files);
  assert.throws(
    () =>
      validateSourceProposal(
        {
          ...proposal,
          files: [
            {
              path: 'src/secrets.ts',
              content_base64: Buffer.from('not allowed').toString('base64'),
            },
          ],
        },
        sourceTask,
        claim,
      ),
    /SOURCE_PROPOSAL_SCOPE_VIOLATION:src\/secrets\.ts/,
  );
});
