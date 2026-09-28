import type { CodeWitnessFinding, CodeWitnessReport } from './code-witness.ts';

export const CODE_DELETION_PROOF_SCHEMA = 'overcenter-code-deletion-proof/v1' as const;

export interface CodeSymbolSelector {
  path: string;
  symbol: string;
}

export interface CounterfactualEvidenceStep {
  name: string;
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
  reason_code: 'ALL_DETERMINISTIC_EVIDENCE_PASSED' | 'DETERMINISTIC_EVIDENCE_FAILED';
  evidence: CounterfactualEvidenceStep[];
}

export function parseCodeSymbolSelector(selector: string): CodeSymbolSelector {
  const separator = selector.lastIndexOf('#');
  if (
    separator <= 0 ||
    separator === selector.length - 1 ||
    selector.indexOf('#') !== separator
  ) {
    throw new Error('CODE_DELETION_SELECTOR_INVALID');
  }
  const path = selector.slice(0, separator);
  const symbol = selector.slice(separator + 1);
  if (!path.startsWith('src/') || !path.endsWith('.ts') || symbol.length === 0) {
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
    input.source_revision.length === 0 ||
    input.candidate_revision.length === 0 ||
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

  const preserved = input.evidence.every((step) => step.passed);
  return {
    schema: CODE_DELETION_PROOF_SCHEMA,
    source_revision: input.source_revision,
    candidate_revision: input.candidate_revision,
    selector: input.selector,
    source_sha256: input.source_sha256,
    candidate_source_sha256: input.candidate_source_sha256,
    status: preserved ? 'deterministic-evidence-preserved' : 'rejected',
    reason_code: preserved
      ? 'ALL_DETERMINISTIC_EVIDENCE_PASSED'
      : 'DETERMINISTIC_EVIDENCE_FAILED',
    evidence: input.evidence.map((step) => ({ ...step })),
  };
}
