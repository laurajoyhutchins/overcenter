import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CLAIM_SCHEMA,
  EFFECT_RELEASE_SCHEMA,
  RECEIPT_SCHEMA,
  validateAuthorityFact,
  validateEffectReleaseFact,
  validateReceiptFact,
} from '../src/authority/facts.ts';
import { sha256 } from '../src/digest.ts';
import { GoExecutorClient } from '../src/execution/go-client.ts';
import {
  COMPUTATION_EVIDENCE_SCHEMA,
  COMPUTATION_EXECUTION_SCHEMA,
  EXECUTOR_COMMAND_SCHEMA,
  EXECUTOR_HELLO_SCHEMA,
  PROCESS_SPEC_SCHEMA,
  assertComputationEvidenceFor,
  encodeProcessSpec,
  validateComputationExecution,
  validateExecutorHello,
  validateProcessSpec,
  type ComputationAttemptEvidence,
} from '../src/execution/protocol.ts';
import { validateAbsenceEvidenceEnvelope } from '../src/observation/evidence.ts';
import { validateObservationEnvelope } from '../src/observation/observe.ts';
import { validateProviderObservationEnvelope } from '../src/observation/provider.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureDir = join(root, 'test/fixtures');
const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));

const processSpecConformance = readJson(join(fixtureDir, 'process-spec-conformance.json'));
const authorityConformance = readJson(join(fixtureDir, 'authority-fact-conformance.json'));
const observationConformance = readJson(join(fixtureDir, 'observation-evidence-conformance.json'));

const goProtocol = readFileSync(join(root, 'src/execution/executor/protocol.go'), 'utf8');
const goMain = readFileSync(
  join(root, 'src/execution/executor/cmd/overcenter-executor/main.go'),
  'utf8',
);

test('wire discriminators agree across TypeScript and Go', () => {
  for (const [goName, value] of [
    ['ProcessSpecSchema', PROCESS_SPEC_SCHEMA],
    ['ComputationExecutionSchema', COMPUTATION_EXECUTION_SCHEMA],
    ['ExecutorCommandSchema', EXECUTOR_COMMAND_SCHEMA],
    ['ComputationEvidenceSchema', COMPUTATION_EVIDENCE_SCHEMA],
  ] as const) {
    assert.match(goProtocol, new RegExp(goName + '\\s*=\\s*"' + value + '"'));
  }
  assert.match(goMain, new RegExp('executorHelloSchema\\s*=\\s*"' + EXECUTOR_HELLO_SCHEMA + '"'));
});

test('the checked-in process-spec corpus is executable against the production validator', () => {
  assert.equal(processSpecConformance.schema, 'overcenter-process-spec-conformance-v1');
  for (const candidate of processSpecConformance.cases as Array<{
    name: string;
    valid: boolean;
    spec: unknown;
  }>) {
    if (candidate.valid) {
      assert.doesNotThrow(() => validateProcessSpec(candidate.spec), candidate.name);
    } else {
      assert.throws(() => validateProcessSpec(candidate.spec), candidate.name);
    }
  }
});

test('computation attempt evidence is bound by production behavior, not metadata', () => {
  const capability = 'fixture-capability';
  const encoded = encodeProcessSpec({
    schema: PROCESS_SPEC_SCHEMA,
    executable: '/bin/true',
    argv: [],
    cwd: '.',
    env: {},
    timeout_ms: 1000,
    stdout_max_bytes: 0,
    stderr_max_bytes: 0,
  });
  const execution = validateComputationExecution({
    schema: COMPUTATION_EXECUTION_SCHEMA,
    run_id: 'run',
    obligation_id: 'obligation',
    claimed_revision: 'revision',
    execution_generation: 1,
    execution_authority_commit: 'authority',
    execution_capability: capability,
    execution_capability_sha256: sha256(capability),
    execution_spec_base64: encoded.base64,
    execution_spec_sha256: encoded.sha256,
  });
  const emptyDigest = 'sha256:' + sha256(Buffer.alloc(0));
  const evidence: ComputationAttemptEvidence = {
    schema: COMPUTATION_EVIDENCE_SCHEMA,
    run_id: execution.run_id,
    obligation_id: execution.obligation_id,
    claimed_revision: execution.claimed_revision,
    execution_generation: execution.execution_generation,
    execution_authority_commit: execution.execution_authority_commit,
    execution_capability_sha256: execution.execution_capability_sha256,
    execution_spec_sha256: execution.execution_spec_sha256,
    outcome: 'completed',
    stdout_sha256: emptyDigest,
    stdout_truncated: false,
    stderr_sha256: emptyDigest,
    stderr_truncated: false,
  };

  assert.doesNotThrow(() => assertComputationEvidenceFor(evidence, execution));
  const hostile: ComputationAttemptEvidence[] = [
    { ...evidence, run_id: 'other-run' },
    { ...evidence, obligation_id: 'other-obligation' },
    { ...evidence, claimed_revision: 'other-revision' },
    { ...evidence, execution_generation: 2 },
    { ...evidence, execution_authority_commit: 'other-authority' },
    { ...evidence, execution_capability_sha256: '0'.repeat(64) },
    { ...evidence, execution_spec_sha256: 'sha256:' + '0'.repeat(64) },
  ];
  for (const candidate of hostile) {
    assert.throws(() => assertComputationEvidenceFor(candidate, execution), /MISMATCH/);
  }
  assert.doesNotThrow(() =>
    assertComputationEvidenceFor({ ...evidence, error: 'diagnostic only' }, execution),
  );
});

test('executor hello uses the shared UTF-8 byte limit across the language boundary', () => {
  const base = {
    schema: EXECUTOR_HELLO_SCHEMA,
    execution_context_sha256: 'sha256:' + '0'.repeat(64),
  };
  assert.doesNotThrow(() =>
    validateExecutorHello({
      ...base,
      containment_id: 'é'.repeat(256),
    }),
  );
  assert.throws(
    () =>
      validateExecutorHello({
        ...base,
        containment_id: 'é'.repeat(257),
      }),
    /CONTAINMENT_ID_INVALID/,
  );
  assert.throws(
    () =>
      validateExecutorHello({
        ...base,
        containment_id: 'valid',
        extra: true,
      }),
    /EXECUTOR_HELLO_UNKNOWN_FIELD:extra/,
  );
  assert.throws(
    () =>
      new GoExecutorClient({
        socketPath: '/tmp/overcenter-contract-invalid.sock',
        maxConcurrency: 1,
        executionContextSha256: base.execution_context_sha256,
        containmentId: 'é'.repeat(257),
      }),
    /GO_EXECUTOR_CONTAINMENT_ID_INVALID/,
  );
});

test('removed schema variants fail closed', () => {
  assert.throws(
    () => validateAuthorityFact({ schema: 'overcenter-git-receipt-v4' }),
    /UNKNOWN_AUTHORITY_FACT_SCHEMA/,
  );
  assert.throws(
    () => validateEffectReleaseFact({ schema: EFFECT_RELEASE_SCHEMA, schema_version: 1 }),
    /INVALID_EFFECT_RELEASE_SCHEMA_VERSION/,
  );
  assert.throws(
    () =>
      validateObservationEnvelope({
        verifier: 'github-commit-status/v1',
        mutation_certainty: 'present',
      }),
    /OBSERVATION_VERIFIER_INVALID/,
  );
});

test('authority fact conformance corpus runs against production validators', () => {
  assert.equal(authorityConformance.schema, 'overcenter-authority-fact-conformance-v1');
  for (const candidate of authorityConformance.cases as Array<{
    name: string;
    valid: boolean;
    fact: unknown;
  }>) {
    if (candidate.valid) {
      assert.doesNotThrow(() => validateAuthorityFact(candidate.fact), candidate.name);
    } else {
      assert.throws(() => validateAuthorityFact(candidate.fact), candidate.name);
    }
  }
});

test('derived settlement truth cannot be written into durable receipts', () => {
  const receipt = {
    schema: RECEIPT_SCHEMA,
    run_id: 'run',
    obligation_id: 'obligation',
    claimed_revision: 'revision',
    claim_commit: 'claim',
    execution_generation: 1,
    execution_authority_commit: 'authority',
    kind: 'observation',
    observed: null,
    settled_at: '2026-09-30T00:00:00Z',
  } as const;
  assert.doesNotThrow(() => validateReceiptFact(receipt));
  assert.doesNotThrow(() => validateReceiptFact({ ...receipt, diagnostic: { note: 'ignored' } }));
  for (const field of ['disposition', 'verified', 'settlement_commit'] as const) {
    assert.throws(() => validateReceiptFact({ ...receipt, [field]: 'forged' }));
  }
});

test('authority identifiers reject NUL at the production boundary', () => {
  assert.throws(() =>
    validateAuthorityFact({
      schema: CLAIM_SCHEMA,
      run_id: 'run\0forged',
      obligation_id: 'obligation',
      claimed_revision: 'revision',
      obligation_key: 'key',
      execution_capability_sha256: '0'.repeat(64),
    }),
  );
});

test('observation/evidence conformance corpus runs against production validators', () => {
  assert.equal(observationConformance.schema, 'overcenter-observation-evidence-conformance-v1');
  for (const candidate of observationConformance.cases as Array<{
    name: string;
    kind: string;
    valid: boolean;
    value: unknown;
  }>) {
    const validate = () => {
      if (candidate.kind === 'provider-observation') {
        validateProviderObservationEnvelope(candidate.value);
        return;
      }
      if (candidate.kind === 'kubernetes-provider-observation') {
        validateProviderObservationEnvelope(candidate.value, {
          requiredTopLevelExtensions: {
            authority_id: 'non-empty-string',
          },
        });
        return;
      }
      if (candidate.kind === 'settlement-observation') {
        validateObservationEnvelope(candidate.value);
        return;
      }
      if (candidate.kind === 'absence-envelope') {
        validateAbsenceEvidenceEnvelope(candidate.value);
        return;
      }
      throw new Error('UNKNOWN_OBSERVATION_CONFORMANCE_KIND');
    };
    if (candidate.valid) assert.doesNotThrow(validate, candidate.name);
    else assert.throws(validate, candidate.name);
  }
});

test('Kubernetes provider observations require their authority coordinate', () => {
  const observation = {
    contract: {
      provider: 'kubernetes',
      api_version: 'v1',
      operation_id: 'list-configmaps',
      schema_sha256: '0'.repeat(64),
    },
    observer: { kind: 'fixture', id: 'observer' },
    observed_at: '2026-09-30T00:00:00Z',
    request: {},
    response: {},
    outcome: { status: 200, visibility: 'observed' },
  };
  const options = {
    requiredTopLevelExtensions: {
      authority_id: 'non-empty-string' as const,
    },
  };
  assert.throws(() => validateProviderObservationEnvelope(observation, options));
  assert.doesNotThrow(() =>
    validateProviderObservationEnvelope({ ...observation, authority_id: 'cluster-a' }, options),
  );
});
