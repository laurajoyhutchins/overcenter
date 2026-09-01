export type MutationCertainty = 'none' | 'possible' | 'confirmed';

const CERTAINTY_RANK: Readonly<Record<MutationCertainty, number>> = Object.freeze({
  none:0,
  possible:1,
  confirmed:2,
});

function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function detailsOf(value: Readonly<Record<string, unknown>> | null): Readonly<Record<string, unknown>> | null {
  return recordOf(value?.details);
}

export function mergeMutationCertainty(...values: readonly MutationCertainty[]): MutationCertainty {
  let strongest: MutationCertainty = 'none';
  for (const value of values) {
    if (CERTAINTY_RANK[value] > CERTAINTY_RANK[strongest]) strongest = value;
  }
  return strongest;
}

export function mutationCertaintyFromEvidence(
  value: unknown,
  fallback: MutationCertainty = 'none',
): MutationCertainty {
  const input = recordOf(value);
  if (!input) return fallback;
  const details = detailsOf(input);
  const explicit = input.may_have_mutated ?? details?.may_have_mutated;
  let certainty: MutationCertainty = explicit === undefined
    ? fallback
    : Boolean(explicit) ? 'possible' : 'none';

  if (input.ok === true) certainty = 'confirmed';

  const phase = typeof input.phase === 'string'
    ? input.phase
    : typeof details?.phase === 'string' ? details.phase : '';
  if (phase.startsWith('reconcile.')) {
    certainty = mergeMutationCertainty(certainty, 'possible');
  }

  const errorCode = typeof input.error === 'string' ? input.error : '';
  if (errorCode.includes('INDETERMINATE')) {
    certainty = mergeMutationCertainty(certainty, 'possible');
  }

  return certainty;
}

export function mayHaveMutated(certainty: MutationCertainty): boolean {
  return certainty !== 'none';
}
