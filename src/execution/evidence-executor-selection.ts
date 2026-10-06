import type { ExecutionEvidenceReceipt } from './evidence-receipt.ts';

export const EVIDENCE_EXECUTOR_PREFERENCE = ['local', 'gcp', 'github'] as const;

export type EvidenceExecutorSubstrate = (typeof EVIDENCE_EXECUTOR_PREFERENCE)[number];
export type EvidenceExecutorCapability = 'ready' | 'unsupported' | 'unavailable';

export type EvidenceRealization =
  | { state: 'realized'; receipt: ExecutionEvidenceReceipt }
  | { state: 'unavailable'; diagnostic: string }
  | { state: 'invalid'; diagnostic: string };

export interface EvidenceExecutor<Need> {
  readonly substrate: EvidenceExecutorSubstrate;
  capability(need: Need): EvidenceExecutorCapability | Promise<EvidenceExecutorCapability>;
  realize(need: Need): Promise<EvidenceRealization>;
}

export type EvidenceExecutorSet<Need> = Readonly<
  Record<EvidenceExecutorSubstrate, EvidenceExecutor<Need>>
>;

export class EvidenceExecutorUnavailable extends Error {
  constructor(message = 'EVIDENCE_EXECUTOR_UNAVAILABLE') {
    super(message);
    this.name = 'EvidenceExecutorUnavailable';
  }
}

function assertPreference(preference: readonly EvidenceExecutorSubstrate[]): void {
  if (new Set(preference).size !== preference.length) {
    throw new Error('EVIDENCE_EXECUTOR_PREFERENCE_DUPLICATE');
  }
}

export async function realizeEvidenceNeedWithPreference<Need>(
  need: Need,
  executors: EvidenceExecutorSet<Need>,
  preference: readonly EvidenceExecutorSubstrate[],
): Promise<ExecutionEvidenceReceipt> {
  assertPreference(preference);

  for (const substrate of preference) {
    const executor = executors[substrate];
    if (executor.substrate !== substrate) {
      throw new Error(`EVIDENCE_EXECUTOR_SUBSTRATE_MISMATCH:${substrate}:${executor.substrate}`);
    }

    if ((await executor.capability(need)) !== 'ready') continue;

    const realization = await executor.realize(need);
    if (realization.state === 'realized') return realization.receipt;
    if (realization.state === 'unavailable') continue;

    throw new Error(`EVIDENCE_EXECUTION_INVALID:${substrate}:${realization.diagnostic}`);
  }

  throw new Error('EVIDENCE_EXECUTION_UNAVAILABLE');
}

export async function realizeEvidenceNeed<Need>(
  need: Need,
  executors: EvidenceExecutorSet<Need>,
): Promise<ExecutionEvidenceReceipt> {
  return await realizeEvidenceNeedWithPreference(need, executors, EVIDENCE_EXECUTOR_PREFERENCE);
}
