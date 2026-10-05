import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { canonicalDigest, canonicalJson } from '../digest.ts';
import {
  ASSURANCE_EVIDENCE_NEED_SCHEMA,
  type AssuranceEvidenceNeed,
  type AssuranceEvidenceNeedInputName,
  type AssuranceEvidenceNeedInputs,
} from '../source/assurance-evidence-needs.ts';
import {
  assertExactKeys,
  assertNonEmptyString,
  isData,
  isSha256Hex,
} from '../validation.ts';
import { executionEvidenceDescriptorForAssuranceNeed } from './assurance-evidence-descriptor.ts';
import {
  executionEvidenceReceipt,
  executionEvidenceReceiptDigest,
  normalizeExecutionEvidenceReceipt,
  sameExecutionEvidenceReceipt,
  type ExecutionEvidenceReceipt,
} from './evidence-receipt.ts';

const CACHE_SCHEMA = 'overcenter-local-evidence-realization-cache/v2' as const;
const INPUT_SCHEMA = 'overcenter-local-evidence-realization-input/v2' as const;
export const LOCAL_EVIDENCE_REALIZER_SCHEMA = 'overcenter-local-evidence-realizer/v1' as const;

const NEED_INPUT_KEYS = [
  'base_revision',
  'candidate_tree',
  'model_sha256',
  'dependency_sha256',
  'changed_artifacts',
  'obligation_ids',
  'artifact_ids',
] as const satisfies readonly AssuranceEvidenceNeedInputName[];

export interface LocalEvidenceRealizerDescriptor {
  schema: typeof LOCAL_EVIDENCE_REALIZER_SCHEMA;
  kind: 'deterministic-local';
  implementation_sha256: string;
  runtime_sha256: string;
  configuration_sha256: string;
}

interface CacheEnvelope {
  schema: typeof CACHE_SCHEMA;
  input_identity: string;
  receipt_digest: string;
  receipt: ExecutionEvidenceReceipt;
}

export interface LocalEvidenceRealizationCache {
  read(inputIdentity: string): string | null;
  write(inputIdentity: string, serialized: string): void;
}

function normalizeRealizerDescriptor(value: unknown): LocalEvidenceRealizerDescriptor {
  if (!isData(value)) throw new Error('LOCAL_EVIDENCE_REALIZER_INVALID');
  assertExactKeys(
    value,
    ['schema', 'kind', 'implementation_sha256', 'runtime_sha256', 'configuration_sha256'],
    [],
    'LOCAL_EVIDENCE_REALIZER_INVALID',
  );
  if (value.schema !== LOCAL_EVIDENCE_REALIZER_SCHEMA) {
    throw new Error('LOCAL_EVIDENCE_REALIZER_SCHEMA_INVALID');
  }
  if (value.kind !== 'deterministic-local') {
    throw new Error('LOCAL_EVIDENCE_REALIZER_KIND_INVALID');
  }
  if (!isSha256Hex(value.implementation_sha256)) {
    throw new Error('LOCAL_EVIDENCE_REALIZER_IMPLEMENTATION_INVALID');
  }
  if (!isSha256Hex(value.runtime_sha256)) {
    throw new Error('LOCAL_EVIDENCE_REALIZER_RUNTIME_INVALID');
  }
  if (!isSha256Hex(value.configuration_sha256)) {
    throw new Error('LOCAL_EVIDENCE_REALIZER_CONFIGURATION_INVALID');
  }
  return {
    schema: LOCAL_EVIDENCE_REALIZER_SCHEMA,
    kind: 'deterministic-local',
    implementation_sha256: value.implementation_sha256,
    runtime_sha256: value.runtime_sha256,
    configuration_sha256: value.configuration_sha256,
  };
}

function normalizeAssuranceEvidenceNeed(value: unknown): AssuranceEvidenceNeed {
  if (!isData(value)) throw new Error('LOCAL_EVIDENCE_NEED_INVALID');
  assertExactKeys(
    value,
    ['schema', 'need_id', 'identity', 'inputs'],
    [],
    'LOCAL_EVIDENCE_NEED_INVALID',
  );
  if (value.schema !== ASSURANCE_EVIDENCE_NEED_SCHEMA) {
    throw new Error('LOCAL_EVIDENCE_NEED_SCHEMA_INVALID');
  }
  assertNonEmptyString(value.need_id, 'LOCAL_EVIDENCE_NEED_ID_INVALID');

  const identityValue = value.identity;
  if (!isData(identityValue)) throw new Error('LOCAL_EVIDENCE_NEED_IDENTITY_INVALID');
  assertExactKeys(
    identityValue,
    ['evidence_id', 'revision'],
    [],
    'LOCAL_EVIDENCE_NEED_IDENTITY_INVALID',
  );
  assertNonEmptyString(identityValue.evidence_id, 'LOCAL_EVIDENCE_NEED_EVIDENCE_ID_INVALID');
  assertNonEmptyString(identityValue.revision, 'LOCAL_EVIDENCE_NEED_REVISION_INVALID');

  const inputValue = value.inputs;
  if (!isData(inputValue)) throw new Error('LOCAL_EVIDENCE_NEED_INPUTS_INVALID');
  assertExactKeys(
    inputValue,
    NEED_INPUT_KEYS,
    [],
    'LOCAL_EVIDENCE_NEED_INPUTS_INVALID',
  );
  const inputs = Object.fromEntries(
    NEED_INPUT_KEYS.map((key) => {
      const member = inputValue[key];
      assertNonEmptyString(member, `LOCAL_EVIDENCE_NEED_INPUT_INVALID:${key}`);
      return [key, member];
    }),
  ) as AssuranceEvidenceNeedInputs;
  const identity = {
    evidence_id: identityValue.evidence_id,
    revision: identityValue.revision,
  };
  const expectedNeedId = `assurance-evidence:${canonicalDigest({
    schema: ASSURANCE_EVIDENCE_NEED_SCHEMA,
    identity,
    inputs,
  })}`;
  if (value.need_id !== expectedNeedId) throw new Error('LOCAL_EVIDENCE_NEED_ID_MISMATCH');

  return {
    schema: ASSURANCE_EVIDENCE_NEED_SCHEMA,
    need_id: value.need_id,
    identity,
    inputs,
  };
}

function receiptForNeed(value: unknown, need: AssuranceEvidenceNeed): ExecutionEvidenceReceipt {
  const receipt = normalizeExecutionEvidenceReceipt(value);
  const expected = executionEvidenceReceipt(
    executionEvidenceDescriptorForAssuranceNeed(
      need,
      receipt.outputs,
      receipt.semantic_evidence,
    ),
    receipt.observation.result,
  );
  if (!sameExecutionEvidenceReceipt(receipt, expected)) {
    throw new Error('LOCAL_EVIDENCE_RECEIPT_NEED_MISMATCH');
  }
  return receipt;
}

export function localEvidenceRealizerIdentity(
  descriptor: LocalEvidenceRealizerDescriptor,
): string {
  return canonicalDigest(normalizeRealizerDescriptor(descriptor));
}

export function localEvidenceInputIdentity(
  needValue: AssuranceEvidenceNeed,
  realizerValue: LocalEvidenceRealizerDescriptor,
): string {
  const need = normalizeAssuranceEvidenceNeed(needValue);
  const realizer = normalizeRealizerDescriptor(realizerValue);
  return canonicalDigest({
    schema: INPUT_SCHEMA,
    need,
    realizer,
  });
}

function parseEnvelope(
  serialized: string,
  inputIdentity: string,
  need: AssuranceEvidenceNeed,
): ExecutionEvidenceReceipt {
  const parsed: unknown = JSON.parse(serialized);
  if (!isData(parsed)) throw new Error('LOCAL_EVIDENCE_CACHE_ENTRY_INVALID');
  assertExactKeys(
    parsed,
    ['schema', 'input_identity', 'receipt_digest', 'receipt'],
    [],
    'LOCAL_EVIDENCE_CACHE_ENTRY_INVALID',
  );
  if (
    parsed.schema !== CACHE_SCHEMA ||
    parsed.input_identity !== inputIdentity ||
    !isSha256Hex(parsed.receipt_digest)
  ) {
    throw new Error('LOCAL_EVIDENCE_CACHE_ENTRY_MISMATCH');
  }
  const receipt = receiptForNeed(parsed.receipt, need);
  if (executionEvidenceReceiptDigest(receipt) !== parsed.receipt_digest) {
    throw new Error('LOCAL_EVIDENCE_CACHE_RECEIPT_DIGEST_MISMATCH');
  }
  return receipt;
}

export class FileLocalEvidenceRealizationCache implements LocalEvidenceRealizationCache {
  readonly workspaceRoot: string;
  readonly root: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.root = join(this.workspaceRoot, '.overcenter', 'cache', 'local-evidence-v2');
  }

  read(inputIdentity: string): string | null {
    try {
      return readFileSync(this.pathFor(inputIdentity), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  write(inputIdentity: string, serialized: string): void {
    const target = this.pathFor(inputIdentity);
    mkdirSync(this.root, { recursive: true });
    const temporary = join(this.root, `.tmp-${process.pid}-${randomUUID()}`);
    try {
      writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  delete(inputIdentity: string): void {
    rmSync(this.pathFor(inputIdentity), { force: true });
  }

  clear(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  pathFor(inputIdentity: string): string {
    if (!isSha256Hex(inputIdentity)) throw new Error('LOCAL_EVIDENCE_INPUT_IDENTITY_INVALID');
    return join(this.root, `${inputIdentity}.json`);
  }
}

export async function realizeLocalExecutionEvidence(
  needValue: AssuranceEvidenceNeed,
  {
    cache,
    realizer: realizerValue,
    realize,
  }: {
    cache: LocalEvidenceRealizationCache;
    realizer: LocalEvidenceRealizerDescriptor;
    realize: (need: AssuranceEvidenceNeed) => unknown | Promise<unknown>;
  },
): Promise<ExecutionEvidenceReceipt> {
  const need = normalizeAssuranceEvidenceNeed(needValue);
  const realizer = normalizeRealizerDescriptor(realizerValue);
  const inputIdentity = localEvidenceInputIdentity(need, realizer);

  try {
    const serialized = cache.read(inputIdentity);
    if (serialized !== null) {
      return structuredClone(parseEnvelope(serialized, inputIdentity, need));
    }
  } catch {
    // The cache is acceleration only. Read, parse, digest, and semantic validation failures
    // all become cold realizations and cannot alter authority-facing evidence.
  }

  const receipt = receiptForNeed(await realize(structuredClone(need)), need);
  const envelope: CacheEnvelope = {
    schema: CACHE_SCHEMA,
    input_identity: inputIdentity,
    receipt_digest: executionEvidenceReceiptDigest(receipt),
    receipt: structuredClone(receipt),
  };

  try {
    cache.write(inputIdentity, canonicalJson(envelope));
  } catch {
    // Persistence failure cannot convert valid realized evidence into an authority failure.
  }
  return structuredClone(receipt);
}
