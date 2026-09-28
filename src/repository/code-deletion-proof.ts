import { assertExactKeys, assertNonEmptyString, isData } from '../validation.ts';
import type { CodeWitnessFinding, CodeWitnessReport } from './code-witness.ts';

export const CODE_DELETION_PROOF_SCHEMA = 'overcenter-code-deletion-proof/v1' as const;
export const CODE_DELETION_EVIDENCE_STEPS = [
  'lint',
  'typecheck',
  'architecture-reconciliation',
  'trusted-computing-base',
  'adapter-diagnosability',
  'experiment-statistics',
  'code-witness-analysis',
  'unit-tests',
] as const;

export type CodeDeletionEvidenceStepName = (typeof CODE_DELETION_EVIDENCE_STEPS)[number];

export interface CodeSymbolSelector {
  path: string;
  symbol: string;
}

export interface CounterfactualEvidenceStep {
  name: CodeDeletionEvidenceStepName;
  passed: boolean;
}

export interface CounterfactualDeletionProof {
  schema: typeof CODE_DELETION_PROOF_SCHEMA;
  source_revision: string;
  candidate_revision: string;
  selector: string;
  source_sha256: string;
  candidate_source_sha256: string;
  status: 'deterministic-evidence-preserved' | 'rejected';
  reason_code:
    | 'ALL_DETERMINISTIC_EVIDENCE_PASSED'
    | 'DETERMINISTIC_EVIDENCE_FAILED'
    | 'DETERMINISTIC_EVIDENCE_INCOMPLETE';
  evidence: CounterfactualEvidenceStep[];
}

export function parseCodeSymbolSelector(selector: string): CodeSymbolSelector {
  const separator = selector.lastIndexOf('#');
  if (separator <= 0 || separator === selector.length - 1 || selector.indexOf('#') !== separator) {
    throw new Error('CODE_DELETION_SELECTOR_INVALID');
  }
  const path = selector.slice(0, separator);
  const symbol = selector.slice(separator + 1);
  const segments = path.split('/');
  if (
    !path.startsWith('src/') ||
    !path.endsWith('.ts') ||
    path.includes('\\') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
    !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol)
  ) {
    throw new Error('CODE_DELETION_SELECTOR_INVALID');
  }
  return { path, symbol };
}

export function selectCounterfactualDeletion(
  report: CodeWitnessReport,
  sourceRevision: string,
  selector: string,
): CodeWitnessFinding {
  if (report.source_revision !== sourceRevision) {
    throw new Error('CODE_DELETION_REPORT_REVISION_MISMATCH');
  }
  const parsed = parseCodeSymbolSelector(selector);
  const matches = report.findings.filter(
    (finding) =>
      finding.code === 'UNWITNESSED_PRIVATE_SYMBOL' &&
      finding.path === parsed.path &&
      finding.symbol === parsed.symbol,
  );
  if (matches.length !== 1) {
    throw new Error('CODE_DELETION_UNWITNESSED_FINDING_REQUIRED');
  }
  return matches[0]!;
}

export function buildCounterfactualDeletionProof(input: {
  source_revision: string;
  candidate_revision: string;
  selector: string;
  source_sha256: string;
  candidate_source_sha256: string;
  evidence: CounterfactualEvidenceStep[];
}): CounterfactualDeletionProof {
  if (
    !/^[0-9a-f]{40}$/.test(input.source_revision) ||
    !/^[0-9a-f]{40}$/.test(input.candidate_revision) ||
    input.source_revision === input.candidate_revision
  ) {
    throw new Error('CODE_DELETION_REVISION_INVALID');
  }
  parseCodeSymbolSelector(input.selector);
  if (
    !/^[0-9a-f]{64}$/.test(input.source_sha256) ||
    !/^[0-9a-f]{64}$/.test(input.candidate_source_sha256) ||
    input.source_sha256 === input.candidate_source_sha256
  ) {
    throw new Error('CODE_DELETION_SOURCE_IDENTITY_INVALID');
  }
  if (input.evidence.length === 0) throw new Error('CODE_DELETION_EVIDENCE_REQUIRED');
  if (input.evidence.length > CODE_DELETION_EVIDENCE_STEPS.length) {
    throw new Error('CODE_DELETION_EVIDENCE_SEQUENCE_INVALID');
  }
  for (const [index, step] of input.evidence.entries()) {
    if (step.name !== CODE_DELETION_EVIDENCE_STEPS[index]) {
      throw new Error('CODE_DELETION_EVIDENCE_SEQUENCE_INVALID');
    }
    if (!step.passed && index !== input.evidence.length - 1) {
      throw new Error('CODE_DELETION_EVIDENCE_AFTER_FAILURE');
    }
  }

  const allPassed = input.evidence.every((step) => step.passed);
  const complete = input.evidence.length === CODE_DELETION_EVIDENCE_STEPS.length;
  const preserved = allPassed && complete;
  const reasonCode = preserved
    ? 'ALL_DETERMINISTIC_EVIDENCE_PASSED'
    : allPassed
      ? 'DETERMINISTIC_EVIDENCE_INCOMPLETE'
      : 'DETERMINISTIC_EVIDENCE_FAILED';
  return {
    schema: CODE_DELETION_PROOF_SCHEMA,
    source_revision: input.source_revision,
    candidate_revision: input.candidate_revision,
    selector: input.selector,
    source_sha256: input.source_sha256,
    candidate_source_sha256: input.candidate_source_sha256,
    status: preserved ? 'deterministic-evidence-preserved' : 'rejected',
    reason_code: reasonCode,
    evidence: input.evidence.map((step) => ({ ...step })),
  };
}

export function validateCounterfactualDeletionProof(value: unknown): CounterfactualDeletionProof {
  if (!isData(value)) throw new Error('CODE_DELETION_PROOF_INVALID');
  assertExactKeys(
    value,
    [
      'schema',
      'source_revision',
      'candidate_revision',
      'selector',
      'source_sha256',
      'candidate_source_sha256',
      'status',
      'reason_code',
      'evidence',
    ],
    [],
    'CODE_DELETION_PROOF_INVALID',
  );
  if (value.schema !== CODE_DELETION_PROOF_SCHEMA) {
    throw new Error('CODE_DELETION_PROOF_SCHEMA_MISMATCH');
  }
  assertNonEmptyString(value.selector, 'CODE_DELETION_PROOF_SELECTOR_INVALID');
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
    throw new Error('CODE_DELETION_PROOF_EVIDENCE_INVALID');
  }
  const evidence = value.evidence.map((step, index): CounterfactualEvidenceStep => {
    if (!isData(step)) throw new Error(`CODE_DELETION_PROOF_EVIDENCE_INVALID:${index}`);
    assertExactKeys(step, ['name', 'passed'], [], `CODE_DELETION_PROOF_EVIDENCE_INVALID:${index}`);
    assertNonEmptyString(step.name, `CODE_DELETION_PROOF_EVIDENCE_NAME_INVALID:${index}`);
    if (typeof step.passed !== 'boolean') {
      throw new Error(`CODE_DELETION_PROOF_EVIDENCE_RESULT_INVALID:${index}`);
    }
    return { name: step.name as CodeDeletionEvidenceStepName, passed: step.passed };
  });
  if (new Set(evidence.map((step) => step.name)).size !== evidence.length) {
    throw new Error('CODE_DELETION_PROOF_EVIDENCE_DUPLICATE');
  }
  if (
    typeof value.source_revision !== 'string' ||
    typeof value.candidate_revision !== 'string' ||
    typeof value.source_sha256 !== 'string' ||
    typeof value.candidate_source_sha256 !== 'string'
  ) {
    throw new Error('CODE_DELETION_PROOF_IDENTITY_INVALID');
  }

  const normalized = buildCounterfactualDeletionProof({
    source_revision: value.source_revision,
    candidate_revision: value.candidate_revision,
    selector: value.selector,
    source_sha256: value.source_sha256,
    candidate_source_sha256: value.candidate_source_sha256,
    evidence,
  });
  if (value.status !== normalized.status || value.reason_code !== normalized.reason_code) {
    throw new Error('CODE_DELETION_PROOF_RESULT_MISMATCH');
  }
  return normalized;
}
