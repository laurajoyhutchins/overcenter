import { validateClaimFact, validateSourceRevisionBindingFact } from '../authority/facts.ts';
import { replayProjection } from '../authority/replay.ts';
import { GitFactStore } from './git-store.ts';

const FACT_PATHS = [
  'graph-patch.json',
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

  const history = store.history(head);
  try {
    replayProjection(history);
    return { state: 'UNCHANGED', authority_head: head };
  } catch (error: unknown) {
    if (!(error instanceof Error) || error.message !== 'CLAIM_WHILE_NOT_READY') throw error;
  }

  const tail = history.at(-1);
  if (!tail || tail.commit !== head) throw new Error('AUTHORITY_RECOVERY_TAIL_MISSING');
  const parent = tail.parent;
  if (!parent) throw new Error('AUTHORITY_RECOVERY_PARENT_MISSING');

  const parentProjection = replayProjection(history.slice(0, -1));
  const claimValue = tail.claim;
  if (claimValue == null) throw new Error('AUTHORITY_RECOVERY_TAIL_NOT_CLAIM');

  for (const path of FACT_PATHS) {
    const key = path.replace('.json', '').replaceAll('-', '_') as keyof typeof tail;
    if (tail[key] != null) throw new Error(`AUTHORITY_RECOVERY_TAIL_HAS_EFFECT:${path}`);
  }

  const claim = validateClaimFact(claimValue);
  const sourceRevisionValue = tail.source_revision;
  if (sourceRevisionValue != null) {
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
