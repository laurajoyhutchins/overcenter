import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  minimumSufficientEvidenceSet,
} from '../src/authority/assurance-relations.ts';
import { effectAdmissionDecision } from '../src/authority/transaction-admission.ts';
import { settlementDispositionFromRelations } from '../src/authority/settlement.ts';
import { canonicalDigest, canonicalJson } from '../src/digest.ts';
import {
  executionEvidenceDescriptorForAssuranceNeed,
} from '../src/execution/assurance-evidence-descriptor.ts';
import {
  executionEvidenceReceipt,
  executionEvidenceReceiptDigest,
  type ExecutionEvidenceReceipt,
} from '../src/execution/evidence-receipt.ts';
import {
  FileLocalEvidenceRealizationCache,
  LOCAL_EVIDENCE_REALIZER_SCHEMA,
  localEvidenceInputIdentity,
  localEvidenceRealizerIdentity,
  realizeLocalExecutionEvidence,
  type LocalEvidenceRealizationCache,
  type LocalEvidenceRealizerDescriptor,
} from '../src/execution/local-evidence-realization-cache.ts';
import {
  ASSURANCE_EVIDENCE_NEED_SCHEMA,
  type AssuranceEvidenceNeed,
  type AssuranceEvidenceNeedInputs,
} from '../src/source/assurance-evidence-needs.ts';

const REVISION = 'a'.repeat(40);

const inputs: AssuranceEvidenceNeedInputs = {
  coordinate: `revision:${REVISION}`,
  model_sha256: 'd'.repeat(64),
  dependency_sha256: 'e'.repeat(64),
  proposition_ids: canonicalJson(['proof:authority-flow-integrity']),
  obligation_ids: canonicalJson(['candidate-proof']),
  artifact_ids: canonicalJson(['src/value.ts']),
  package_scripts: canonicalJson(['typecheck']),
  uses_package_runtime: 'true',
};

const identity = {
  evidence_id: 'authority-flow-integrity',
  revision: REVISION,
};

const need: AssuranceEvidenceNeed = {
  schema: ASSURANCE_EVIDENCE_NEED_SCHEMA,
  need_id: `assurance-evidence:${canonicalDigest({
    schema: ASSURANCE_EVIDENCE_NEED_SCHEMA,
    identity,
    inputs,
  })}`,
  identity,
  inputs,
};

const realizer: LocalEvidenceRealizerDescriptor = {
  schema: LOCAL_EVIDENCE_REALIZER_SCHEMA,
  kind: 'deterministic-local',
  implementation_sha256: '1'.repeat(64),
  runtime_sha256: '2'.repeat(64),
  configuration_sha256: '3'.repeat(64),
};

function expectedReceipt(source = need): ExecutionEvidenceReceipt {
  const descriptor = executionEvidenceDescriptorForAssuranceNeed(source);
  return executionEvidenceReceipt(descriptor, {
    ...descriptor,
    outputs: { artifact_sha256: '4'.repeat(64) },
    semantic_evidence: { 'proof.authority-flow-integrity': 'true' },
    observation: { result: 'satisfied' },
  });
}

function fixture(): { workspace: string; cache: FileLocalEvidenceRealizationCache } {
  const workspace = mkdtempSync(join(tmpdir(), 'overcenter-local-evidence-cache-'));
  return { workspace, cache: new FileLocalEvidenceRealizationCache(workspace) };
}

function realizerWithCounter(counter: { calls: number }) {
  return async (source: AssuranceEvidenceNeed): Promise<ExecutionEvidenceReceipt> => {
    counter.calls += 1;
    return expectedReceipt(source);
  };
}

function authoritySnapshot(receipt: ExecutionEvidenceReceipt) {
  const proposition = `proof:${receipt.identity.evidence_id}`;
  return {
    admission: effectAdmissionDecision({
      current_authority: true,
      exact_revision: receipt.identity.revision === need.identity.revision,
      unresolved_effect: false,
    }),
    settlement: settlementDispositionFromRelations({
      event_asserts_postcondition: receipt.observation.result === 'satisfied',
      object_supports_accepted_absence: false,
      object_supports_not_dispatched: false,
      accepted_absence_requires_replay_safety: true,
      object_supports_replay_safety: false,
    }),
    assurance: minimumSufficientEvidenceSet(
      [proposition],
      [
        {
          object_id: executionEvidenceReceiptDigest(receipt),
          proposition_id: proposition,
          coordinate: receipt.identity.revision,
        },
      ],
      receipt.identity.revision,
    ),
  };
}

test('cache miss and valid hit yield the same canonical execution evidence', async () => {
  const { workspace, cache } = fixture();
  try {
    const counter = { calls: 0 };
    const cold = await realizeLocalExecutionEvidence(need, {
      cache,
      realizer,
      realize: realizerWithCounter(counter),
    });
    assert.equal(counter.calls, 1);

    const hit = await realizeLocalExecutionEvidence(need, {
      cache,
      realizer,
      realize: realizerWithCounter(counter),
    });
    assert.equal(counter.calls, 1, 'valid cache hit avoids a second realization');
    assert.deepEqual(hit, cold);
    assert.equal(executionEvidenceReceiptDigest(hit), executionEvidenceReceiptDigest(cold));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('cache deletion preserves actual admission, settlement, and assurance decisions', async () => {
  const { workspace, cache } = fixture();
  try {
    const counter = { calls: 0 };
    const warm = await realizeLocalExecutionEvidence(need, {
      cache,
      realizer,
      realize: realizerWithCounter(counter),
    });
    const beforeDeletion = authoritySnapshot(warm);

    cache.clear();

    const coldAgain = await realizeLocalExecutionEvidence(need, {
      cache,
      realizer,
      realize: realizerWithCounter(counter),
    });

    assert.equal(counter.calls, 2, 'deletion forces cold recomputation');
    assert.deepEqual(coldAgain, warm);
    assert.deepEqual(authoritySnapshot(coldAgain), beforeDeletion);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('authority source files cannot observe local cache state', () => {
  const authorityRoot = fileURLToPath(new URL('../src/authority/', import.meta.url));
  for (const entry of readdirSync(authorityRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const source = readFileSync(join(authorityRoot, entry.name), 'utf8');
    assert.doesNotMatch(source, /local-evidence-realization-cache|FileLocalEvidenceRealizationCache/);
  }
});

test('corrupt or semantically stale cached receipts are rejected and recomputed', async () => {
  const { workspace, cache } = fixture();
  try {
    const inputIdentity = localEvidenceInputIdentity(need, realizer);
    const staleDescriptor = {
      ...executionEvidenceDescriptorForAssuranceNeed(need),
      identity: { ...need.identity, revision: 'f'.repeat(40) },
    };
    const staleReceipt = executionEvidenceReceipt(staleDescriptor, {
      ...staleDescriptor,
      outputs: { artifact_sha256: '4'.repeat(64) },
      semantic_evidence: { 'proof.authority-flow-integrity': 'true' },
      observation: { result: 'satisfied' },
    });
    cache.write(
      inputIdentity,
      canonicalJson({
        schema: 'overcenter-local-evidence-realization-cache/v2',
        input_identity: inputIdentity,
        receipt_digest: executionEvidenceReceiptDigest(staleReceipt),
        receipt: staleReceipt,
      }),
    );

    const counter = { calls: 0 };
    const repaired = await realizeLocalExecutionEvidence(need, {
      cache,
      realizer,
      realize: realizerWithCounter(counter),
    });
    assert.equal(counter.calls, 1);
    assert.deepEqual(repaired, expectedReceipt());

    cache.write(
      inputIdentity,
      canonicalJson({
        schema: 'overcenter-local-evidence-realization-cache/v2',
        input_identity: inputIdentity,
        receipt_digest: '0'.repeat(64),
        receipt: expectedReceipt(),
      }),
    );
    const repairedAgain = await realizeLocalExecutionEvidence(need, {
      cache,
      realizer,
      realize: realizerWithCounter(counter),
    });
    assert.equal(counter.calls, 2);
    assert.deepEqual(repairedAgain, expectedReceipt());
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('receipt identity and required inputs must match the assurance need', async () => {
  const { workspace, cache } = fixture();
  try {
    const mismatchedDescriptor = {
      ...executionEvidenceDescriptorForAssuranceNeed(need),
      identity: { evidence_id: 'different-proof', revision: REVISION },
    };
    const mismatched = executionEvidenceReceipt(mismatchedDescriptor, {
      ...mismatchedDescriptor,
      outputs: { artifact_sha256: '4'.repeat(64) },
      semantic_evidence: { 'proof.authority-flow-integrity': 'true' },
      observation: { result: 'satisfied' },
    });
    await assert.rejects(
      realizeLocalExecutionEvidence(need, {
        cache,
        realizer,
        realize: async () => mismatched,
      }),
      /LOCAL_EVIDENCE_RECEIPT_NEED_MISMATCH/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('realizer identity is content-addressed across implementation, runtime, and configuration', () => {
  const base = localEvidenceRealizerIdentity(realizer);
  for (const [field, digest] of [
    ['implementation_sha256', '5'.repeat(64)],
    ['runtime_sha256', '6'.repeat(64)],
    ['configuration_sha256', '7'.repeat(64)],
  ] as const) {
    assert.notEqual(
      localEvidenceRealizerIdentity({ ...realizer, [field]: digest }),
      base,
      field,
    );
  }

  assert.throws(
    () =>
      localEvidenceRealizerIdentity({
        ...realizer,
        implementation_sha256: 'local-proof/v2',
      }),
    /LOCAL_EVIDENCE_REALIZER_IMPLEMENTATION_INVALID/,
  );
  assert.throws(
    () =>
      localEvidenceRealizerIdentity({
        ...realizer,
        kind: 'remote-observation',
      } as unknown as LocalEvidenceRealizerDescriptor),
    /LOCAL_EVIDENCE_REALIZER_KIND_INVALID/,
  );
});

test('need identity and realizer semantics both participate in the cache key', () => {
  const base = localEvidenceInputIdentity(need, realizer);
  const movedIdentity = { ...need.identity, revision: 'f'.repeat(40) };
  const movedInputs = { ...need.inputs, coordinate: `revision:${movedIdentity.revision}` };
  const movedNeed: AssuranceEvidenceNeed = {
    ...need,
    need_id: `assurance-evidence:${canonicalDigest({
      schema: ASSURANCE_EVIDENCE_NEED_SCHEMA,
      identity: movedIdentity,
      inputs: movedInputs,
    })}`,
    identity: movedIdentity,
    inputs: movedInputs,
  };
  assert.notEqual(localEvidenceInputIdentity(movedNeed, realizer), base);
  assert.notEqual(
    localEvidenceInputIdentity(need, {
      ...realizer,
      implementation_sha256: '8'.repeat(64),
    }),
    base,
  );
});

test('clearing a cache can never remove sibling .overcenter state', () => {
  const { workspace, cache } = fixture();
  try {
    const overcenter = join(workspace, '.overcenter');
    mkdirSync(overcenter, { recursive: true });
    const projectIntent = join(overcenter, 'project-intent.json');
    writeFileSync(projectIntent, '{"authority":"git"}\n');

    const inputIdentity = localEvidenceInputIdentity(need, realizer);
    cache.write(inputIdentity, canonicalJson({ cached: true }));
    assert.equal(existsSync(cache.pathFor(inputIdentity)), true);

    cache.clear();

    assert.equal(existsSync(cache.root), false);
    assert.equal(readFileSync(projectIntent, 'utf8'), '{"authority":"git"}\n');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('cache read and write failures cannot become authority failures', async () => {
  const counter = { calls: 0 };
  const brokenCache: LocalEvidenceRealizationCache = {
    read: () => {
      throw new Error('CACHE_UNAVAILABLE');
    },
    write: () => {
      throw new Error('CACHE_UNAVAILABLE');
    },
  };

  const result = await realizeLocalExecutionEvidence(need, {
    cache: brokenCache,
    realizer,
    realize: realizerWithCounter(counter),
  });
  assert.equal(counter.calls, 1);
  assert.deepEqual(result, expectedReceipt());
});
