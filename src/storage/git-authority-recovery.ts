import { validateClaimFact, validateSourceRevisionBindingFact } from '../authority/facts.ts';
import { replayProjection } from '../authority/replay.ts';
import { GitFactStore } from './git-store.ts';

const FACT_PATHS = [
  'graph-patch.json',
  'claim.json',
  'source-revision.json',
  'execution-authority.json',
  'effect-reservation.json',
  'effect-release.json',
  'receipt.json',
] as const;

export interface AuthorityTailRecoveryResult {
  state: 'UNCHANGED' | 'RECOVERED';
  authority_head: string;
  rejected_head?: string;
  obligation_id?: string;
}

export function recoverInvalidDoneClaimTail(
  repo: string,
  {
    ref,
    remote = null,
  }: {
    ref: string;
    remote?: string | null;
  },
): AuthorityTailRecoveryResult {
  const store = new GitFactStore(repo, { ref, remote });
  const head = store.head();
  if (!head) throw new Error('AUTHORITY_RECOVERY_MISSING');

  try {
    replayProjection(store.history(head));
    return { state: 'UNCHANGED', authority_head: head };
  } catch (error: unknown) {
    if (!(error instanceof Error) || error.message !== 'CLAIM_WHILE_NOT_READY') throw error;
  }

  const parent = store.parent(head);
  if (!parent) throw new Error('AUTHORITY_RECOVERY_PARENT_MISSING');

  const parentProjection = replayProjection(store.history(parent));
  const claimValue = store.readJson(head, 'claim.json');
  if (claimValue === null) throw new Error('AUTHORITY_RECOVERY_TAIL_NOT_CLAIM');

  for (const path of FACT_PATHS) {
    if (
      path !== 'claim.json' &&
      path !== 'source-revision.json' &&
      store.readJson(head, path) !== null
    ) {
      throw new Error(`AUTHORITY_RECOVERY_TAIL_HAS_EFFECT:${path}`);
    }
  }

  const claim = validateClaimFact(claimValue);
  const sourceRevisionValue = store.readJson(head, 'source-revision.json');
  if (sourceRevisionValue !== null) {
    const sourceRevision = validateSourceRevisionBindingFact(sourceRevisionValue);
    if (
      sourceRevision.run_id !== claim.run_id ||
      sourceRevision.obligation_id !== claim.obligation_id
    ) {
      throw new Error('AUTHORITY_RECOVERY_SOURCE_REVISION_MISMATCH');
    }
  }
  if (claim.claimed_revision !== parent) {
    throw new Error('AUTHORITY_RECOVERY_CLAIM_PARENT_MISMATCH');
  }

  const work = parentProjection.project.work.find(
    (candidate) => candidate.id === claim.obligation_id,
  );
  if (!work) throw new Error('AUTHORITY_RECOVERY_OBLIGATION_MISSING');
  if (work.status !== 'DONE') {
    throw new Error(`AUTHORITY_RECOVERY_OBLIGATION_NOT_DONE:${work.status}`);
  }

  if (!store.cas(parent, head)) throw new Error('AUTHORITY_RECOVERY_CAS_CONFLICT');

  return {
    state: 'RECOVERED',
    authority_head: parent,
    rejected_head: head,
    obligation_id: claim.obligation_id,
  };
}
