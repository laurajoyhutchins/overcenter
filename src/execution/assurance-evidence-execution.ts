import type { AssuranceEvidenceNeed } from '../source/assurance-evidence-needs.ts';
import {
  realizeExecutionEvidenceOnGcp,
  type GcpExecutionEvidenceExecutor,
} from '../providers/gcp/execution-evidence-receipt.ts';
import {
  adaptGitHubExecutionEvidence,
  type GitHubExecutionEvidenceExpectation,
  type GitHubExecutionEvidenceObservation,
} from '../providers/github/execution-evidence-receipt.ts';
import { executionEvidenceDescriptorForAssuranceNeed } from './assurance-evidence-descriptor.ts';
import {
  executionEvidenceReceipt,
  normalizeExecutionEvidenceReceipt,
  sameExecutionEvidenceReceipt,
  type ExecutionEvidenceReceipt,
} from './evidence-receipt.ts';
import {
  EvidenceExecutorUnavailable,
  realizeEvidenceNeed,
  type EvidenceExecutor,
  type EvidenceExecutorCapability,
  type EvidenceExecutorSet,
  type EvidenceRealization,
} from './evidence-executor-selection.ts';
import {
  realizeLocalExecutionEvidence,
  type LocalEvidenceRealizationCache,
  type LocalEvidenceRealizerDescriptor,
} from './local-evidence-realization-cache.ts';

type CapabilityProbe = (
  need: AssuranceEvidenceNeed,
) => EvidenceExecutorCapability | Promise<EvidenceExecutorCapability>;

export interface LocalAssuranceEvidenceExecution {
  capability?: CapabilityProbe;
  cache: LocalEvidenceRealizationCache;
  realizer: LocalEvidenceRealizerDescriptor;
  realize(need: AssuranceEvidenceNeed): unknown | Promise<unknown>;
}

export interface GcpAssuranceEvidenceExecution {
  capability?: CapabilityProbe;
  executor: GcpExecutionEvidenceExecutor;
}

export interface GitHubAssuranceEvidenceExecutionResult {
  observation: GitHubExecutionEvidenceObservation;
  expected: GitHubExecutionEvidenceExpectation;
}

export interface GitHubAssuranceEvidenceExecution {
  capability?: CapabilityProbe;
  execute(need: AssuranceEvidenceNeed): Promise<GitHubAssuranceEvidenceExecutionResult>;
}

export interface AssuranceEvidenceExecutionSubstrates {
  local?: LocalAssuranceEvidenceExecution;
  gcp?: GcpAssuranceEvidenceExecution;
  github?: GitHubAssuranceEvidenceExecution;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 2048 ? message : message.slice(0, 2048);
}

function capability(
  configured: { capability?: CapabilityProbe } | undefined,
  need: AssuranceEvidenceNeed,
): EvidenceExecutorCapability | Promise<EvidenceExecutorCapability> {
  if (!configured) return 'unavailable';
  return configured.capability?.(need) ?? 'ready';
}

function receiptForNeed(
  need: AssuranceEvidenceNeed,
  value: unknown,
): ExecutionEvidenceReceipt {
  const receipt = normalizeExecutionEvidenceReceipt(value);
  const descriptor = executionEvidenceDescriptorForAssuranceNeed(need);
  const expected = executionEvidenceReceipt(descriptor, {
    ...descriptor,
    outputs: receipt.outputs,
    semantic_evidence: receipt.semantic_evidence,
    observation: receipt.observation,
  });
  if (!sameExecutionEvidenceReceipt(receipt, expected)) {
    throw new Error('EVIDENCE_RECEIPT_NEED_MISMATCH');
  }
  return receipt;
}

function invalid(error: unknown): EvidenceRealization {
  return { state: 'invalid', diagnostic: errorMessage(error) };
}

function localExecutor(
  configured: LocalAssuranceEvidenceExecution | undefined,
): EvidenceExecutor<AssuranceEvidenceNeed> {
  return {
    substrate: 'local',
    capability: (need) => capability(configured, need),
    async realize(need) {
      if (!configured) {
        return { state: 'unavailable', diagnostic: 'LOCAL_EXECUTOR_NOT_CONFIGURED' };
      }
      try {
        const receipt = await realizeLocalExecutionEvidence(need, {
          cache: configured.cache,
          realizer: configured.realizer,
          realize: configured.realize,
        });
        return { state: 'realized', receipt: receiptForNeed(need, receipt) };
      } catch (error: unknown) {
        if (error instanceof EvidenceExecutorUnavailable) {
          return { state: 'unavailable', diagnostic: errorMessage(error) };
        }
        return invalid(error);
      }
    },
  };
}

function gcpExecutor(
  configured: GcpAssuranceEvidenceExecution | undefined,
): EvidenceExecutor<AssuranceEvidenceNeed> {
  return {
    substrate: 'gcp',
    capability: (need) => capability(configured, need),
    async realize(need) {
      if (!configured) {
        return { state: 'unavailable', diagnostic: 'GCP_EXECUTOR_NOT_CONFIGURED' };
      }
      try {
        const realization = await realizeExecutionEvidenceOnGcp(need, configured.executor);
        if (realization.state === 'observed') {
          return {
            state: 'realized',
            receipt: receiptForNeed(need, realization.receipt),
          };
        }
        if (realization.reason === 'transport-failure') {
          return { state: 'unavailable', diagnostic: realization.diagnostic };
        }
        return {
          state: 'invalid',
          diagnostic: `${realization.reason}:${realization.diagnostic}`,
        };
      } catch (error: unknown) {
        return invalid(error);
      }
    },
  };
}

function githubExecutor(
  configured: GitHubAssuranceEvidenceExecution | undefined,
): EvidenceExecutor<AssuranceEvidenceNeed> {
  return {
    substrate: 'github',
    capability: (need) => capability(configured, need),
    async realize(need) {
      if (!configured) {
        return { state: 'unavailable', diagnostic: 'GITHUB_EXECUTOR_NOT_CONFIGURED' };
      }
      try {
        const execution = await configured.execute(structuredClone(need));
        const adapted = adaptGitHubExecutionEvidence(
          executionEvidenceDescriptorForAssuranceNeed(need),
          execution.observation,
          execution.expected,
        );
        return {
          state: 'realized',
          receipt: receiptForNeed(need, adapted.receipt),
        };
      } catch (error: unknown) {
        if (error instanceof EvidenceExecutorUnavailable) {
          return { state: 'unavailable', diagnostic: errorMessage(error) };
        }
        return invalid(error);
      }
    },
  };
}

export function assuranceEvidenceExecutorSet(
  substrates: AssuranceEvidenceExecutionSubstrates,
): EvidenceExecutorSet<AssuranceEvidenceNeed> {
  return {
    local: localExecutor(substrates.local),
    gcp: gcpExecutor(substrates.gcp),
    github: githubExecutor(substrates.github),
  };
}

export async function realizeAssuranceEvidenceNeed(
  need: AssuranceEvidenceNeed,
  substrates: AssuranceEvidenceExecutionSubstrates,
): Promise<ExecutionEvidenceReceipt> {
  return await realizeEvidenceNeed(need, assuranceEvidenceExecutorSet(substrates));
}
