import {
  minimumSufficientEvidenceSet,
  type PropositionSupport,
} from '../authority/assurance-relations.ts';
import { canonicalDigest, canonicalJson } from '../digest.ts';
import {
  normalizeExecutionEvidenceReceipt,
  type ExecutionEvidenceReceipt,
} from '../execution/evidence-receipt.ts';
import type {
  TransactionAssuranceFrontier,
  TransactionAssurancePlan,
  TransactionEvidenceCandidate,
} from './transaction-planner.ts';

export const ASSURANCE_EVIDENCE_NEED_SCHEMA = 'overcenter-assurance-evidence-need/v1' as const;

export const BASELINE_COMMAND_NEED_SCHEMA = 'overcenter-assurance-evidence-need/v2' as const;

export interface AssuranceEvidenceNeedIdentity {
  evidence_id: string;
  revision: string;
}

export type AssuranceEvidenceNeedInputs = Record<string, string>;

export interface AssuranceEvidenceNeed {
  schema: typeof ASSURANCE_EVIDENCE_NEED_SCHEMA | typeof BASELINE_COMMAND_NEED_SCHEMA;
  need_id: string;
  identity: AssuranceEvidenceNeedIdentity;
  inputs: AssuranceEvidenceNeedInputs;
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function candidateNeed(
  frontier: TransactionAssuranceFrontier,
  candidate: TransactionEvidenceCandidate,
): AssuranceEvidenceNeed {
  const identity: AssuranceEvidenceNeedIdentity = {
    evidence_id: candidate.evidence_id,
    revision: frontier.revision,
  };
  const inputs: AssuranceEvidenceNeedInputs = {
    coordinate: frontier.coordinate,
    model_sha256: frontier.model_sha256,
    dependency_sha256: frontier.dependency_sha256,
    proposition_ids: canonicalJson(canonicalStrings(candidate.proposition_ids)),
    obligation_ids: canonicalJson(canonicalStrings(candidate.obligation_ids)),
    artifact_ids: canonicalJson(canonicalStrings(candidate.artifact_ids)),
    ...(candidate.verification_commands
      ? { verification_commands: canonicalJson(candidate.verification_commands) }
      : {
          package_scripts: canonicalJson(canonicalStrings(candidate.package_scripts)),
          uses_package_runtime: candidate.uses_package_runtime ? 'true' : 'false',
        }),
  };
  if (frontier.baseline_sha256 !== null) inputs.baseline_sha256 = frontier.baseline_sha256;

  const schema = candidate.verification_commands
    ? BASELINE_COMMAND_NEED_SCHEMA
    : ASSURANCE_EVIDENCE_NEED_SCHEMA;
  return {
    schema,
    need_id: `assurance-evidence:${canonicalDigest({
      schema,
      identity,
      inputs,
    })}`,
    identity,
    inputs,
  };
}

function supportKey(value: Pick<AssuranceEvidenceNeed, 'identity' | 'inputs'>): string {
  return canonicalDigest({ identity: value.identity, inputs: value.inputs });
}

function satisfiedReceiptKeys(receipts: readonly ExecutionEvidenceReceipt[]): Set<string> {
  const keys = new Set<string>();
  for (const value of receipts) {
    try {
      const receipt = normalizeExecutionEvidenceReceipt(value);
      if (receipt.observation.result === 'satisfied') keys.add(supportKey(receipt));
    } catch {
      // Malformed evidence contributes no support. Authority/admission owns diagnostics.
    }
  }
  return keys;
}

export function deriveAssuranceEvidenceNeeds(
  plan: TransactionAssurancePlan,
  admittedReceipts: readonly ExecutionEvidenceReceipt[] = [],
): AssuranceEvidenceNeed[] {
  const satisfied = satisfiedReceiptKeys(admittedReceipts);
  const outstanding: AssuranceEvidenceNeed[] = [];

  const frontiers = [...plan.evidence_frontiers].sort(
    (left, right) =>
      left.coordinate.localeCompare(right.coordinate) ||
      canonicalDigest(left).localeCompare(canonicalDigest(right)),
  );
  for (const frontier of frontiers) {
    const needsByEvidence = new Map(
      frontier.candidates.map((candidate) => [
        candidate.evidence_id,
        candidateNeed(frontier, candidate),
      ]),
    );
    const availableSupports: PropositionSupport[] = frontier.candidates.flatMap((candidate) =>
      candidate.proposition_ids.map((proposition_id) => ({
        object_id: candidate.evidence_id,
        proposition_id,
        coordinate: frontier.coordinate,
      })),
    );
    const existingSupports: PropositionSupport[] = frontier.candidates.flatMap((candidate) => {
      const need = needsByEvidence.get(candidate.evidence_id)!;
      if (!satisfied.has(supportKey(need))) return [];
      return candidate.proposition_ids.map((proposition_id) => ({
        object_id: `receipt:${need.need_id}`,
        proposition_id,
        coordinate: frontier.coordinate,
      }));
    });

    const minimum = minimumSufficientEvidenceSet(
      frontier.required_propositions,
      availableSupports,
      frontier.coordinate,
      existingSupports,
    );
    for (const evidenceId of minimum.selected_object_ids) {
      const need = needsByEvidence.get(evidenceId);
      if (!need) throw new Error(`ASSURANCE_EVIDENCE_NEED_UNMAPPED:${evidenceId}`);
      outstanding.push(need);
    }
  }

  return outstanding.sort(
    (left, right) =>
      left.identity.revision.localeCompare(right.identity.revision) ||
      left.identity.evidence_id.localeCompare(right.identity.evidence_id) ||
      left.need_id.localeCompare(right.need_id),
  );
}
