import { sha256 } from '../digest.ts';
import {
  assertExactKeys,
  assertNonEmptyString,
  isData,
  isSha256Hex,
} from '../validation.ts';

export const EXECUTION_EVIDENCE_RECEIPT_SCHEMA =
  'overcenter-execution-evidence-receipt/v1' as const;

export type ExecutionEvidenceResult = 'satisfied' | 'unsatisfied';

export interface ExecutionEvidenceNeedBinding {
  id: string;
  sha256: string;
}

export interface ExecutionEvidenceIdentity {
  evidence_id: string;
  revision: string;
}

export interface ExecutionEvidenceDescriptor {
  need: ExecutionEvidenceNeedBinding;
  identity: ExecutionEvidenceIdentity;
  inputs: Record<string, string>;
}

export interface ExecutionEvidenceRealization extends ExecutionEvidenceDescriptor {
  outputs: Record<string, string>;
  semantic_evidence: Record<string, string>;
  observation: {
    result: ExecutionEvidenceResult;
  };
}

export interface ExecutionEvidenceReceipt extends ExecutionEvidenceRealization {
  schema: typeof EXECUTION_EVIDENCE_RECEIPT_SCHEMA;
}

const codeUnitCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function normalizedStringMap(value: unknown, error: string): Record<string, string> {
  if (!isData(value)) throw new Error(error);
  const entries = Object.entries(value)
    .map(([key, member]) => {
      assertNonEmptyString(key, `${error}:KEY_INVALID`);
      assertNonEmptyString(member, `${error}:${key}:VALUE_INVALID`);
      return [key, member] as const;
    })
    .sort(([left], [right]) => codeUnitCompare(left, right));
  return Object.fromEntries(entries);
}

function normalizedNeed(value: unknown): ExecutionEvidenceNeedBinding {
  if (!isData(value)) throw new Error('EXECUTION_EVIDENCE_NEED_INVALID');
  assertExactKeys(value, ['id', 'sha256'], [], 'EXECUTION_EVIDENCE_NEED_INVALID');
  assertNonEmptyString(value.id, 'EXECUTION_EVIDENCE_NEED_ID_INVALID');
  if (!isSha256Hex(value.sha256)) throw new Error('EXECUTION_EVIDENCE_NEED_DIGEST_INVALID');
  return { id: value.id, sha256: value.sha256 };
}

function normalizedIdentity(value: unknown): ExecutionEvidenceIdentity {
  if (!isData(value)) throw new Error('EXECUTION_EVIDENCE_IDENTITY_INVALID');
  assertExactKeys(
    value,
    ['evidence_id', 'revision'],
    [],
    'EXECUTION_EVIDENCE_IDENTITY_INVALID',
  );
  assertNonEmptyString(value.evidence_id, 'EXECUTION_EVIDENCE_ID_INVALID');
  assertNonEmptyString(value.revision, 'EXECUTION_EVIDENCE_REVISION_INVALID');
  return {
    evidence_id: value.evidence_id,
    revision: value.revision,
  };
}

export function normalizeExecutionEvidenceDescriptor(
  value: unknown,
): ExecutionEvidenceDescriptor {
  if (!isData(value)) throw new Error('EXECUTION_EVIDENCE_DESCRIPTOR_INVALID');
  assertExactKeys(
    value,
    ['need', 'identity', 'inputs'],
    [],
    'EXECUTION_EVIDENCE_DESCRIPTOR_INVALID',
  );
  return {
    need: normalizedNeed(value.need),
    identity: normalizedIdentity(value.identity),
    inputs: normalizedStringMap(value.inputs, 'EXECUTION_EVIDENCE_INPUTS_INVALID'),
  };
}

export function normalizeExecutionEvidenceRealization(
  value: unknown,
): ExecutionEvidenceRealization {
  if (!isData(value)) throw new Error('EXECUTION_EVIDENCE_REALIZATION_INVALID');
  assertExactKeys(
    value,
    ['need', 'identity', 'inputs', 'outputs', 'semantic_evidence', 'observation'],
    [],
    'EXECUTION_EVIDENCE_REALIZATION_INVALID',
  );
  if (!isData(value.observation)) throw new Error('EXECUTION_EVIDENCE_OBSERVATION_INVALID');
  assertExactKeys(
    value.observation,
    ['result'],
    [],
    'EXECUTION_EVIDENCE_OBSERVATION_INVALID',
  );
  if (value.observation.result !== 'satisfied' && value.observation.result !== 'unsatisfied') {
    throw new Error('EXECUTION_EVIDENCE_RESULT_INVALID');
  }
  const descriptor = normalizeExecutionEvidenceDescriptor({
    need: value.need,
    identity: value.identity,
    inputs: value.inputs,
  });
  return {
    ...descriptor,
    outputs: normalizedStringMap(value.outputs, 'EXECUTION_EVIDENCE_OUTPUTS_INVALID'),
    semantic_evidence: normalizedStringMap(
      value.semantic_evidence,
      'EXECUTION_SEMANTIC_EVIDENCE_INVALID',
    ),
    observation: { result: value.observation.result },
  };
}

export function normalizeExecutionEvidenceReceipt(value: unknown): ExecutionEvidenceReceipt {
  if (!isData(value)) throw new Error('EXECUTION_EVIDENCE_RECEIPT_INVALID');
  assertExactKeys(
    value,
    ['schema', 'need', 'identity', 'inputs', 'outputs', 'semantic_evidence', 'observation'],
    [],
    'EXECUTION_EVIDENCE_RECEIPT_INVALID',
  );
  if (value.schema !== EXECUTION_EVIDENCE_RECEIPT_SCHEMA) {
    throw new Error('EXECUTION_EVIDENCE_RECEIPT_SCHEMA_INVALID');
  }
  return {
    schema: EXECUTION_EVIDENCE_RECEIPT_SCHEMA,
    ...normalizeExecutionEvidenceRealization({
      need: value.need,
      identity: value.identity,
      inputs: value.inputs,
      outputs: value.outputs,
      semantic_evidence: value.semantic_evidence,
      observation: value.observation,
    }),
  };
}

function descriptorOf(
  realization: ExecutionEvidenceRealization,
): ExecutionEvidenceDescriptor {
  return {
    need: realization.need,
    identity: realization.identity,
    inputs: realization.inputs,
  };
}

function canonicalNormalizedJson(value: unknown): string {
  return JSON.stringify(value);
}

export function executionEvidenceReceipt(
  descriptorValue: unknown,
  realizationValue: unknown,
): ExecutionEvidenceReceipt {
  const descriptor = normalizeExecutionEvidenceDescriptor(descriptorValue);
  const realization = normalizeExecutionEvidenceRealization(realizationValue);
  if (
    canonicalNormalizedJson(descriptor) !==
    canonicalNormalizedJson(descriptorOf(realization))
  ) {
    throw new Error('EXECUTION_EVIDENCE_REALIZATION_BINDING_MISMATCH');
  }
  return {
    schema: EXECUTION_EVIDENCE_RECEIPT_SCHEMA,
    ...realization,
  };
}

export function executionEvidenceReceiptDigest(value: unknown): string {
  return sha256(canonicalNormalizedJson(normalizeExecutionEvidenceReceipt(value)));
}

export function sameExecutionEvidenceReceipt(left: unknown, right: unknown): boolean {
  return executionEvidenceReceiptDigest(left) === executionEvidenceReceiptDigest(right);
}
