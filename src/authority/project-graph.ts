import type { ObligationInput } from './facts.ts';
import type { RepositorySnapshot } from '../evidence/repository-snapshot.ts';
import {
  compileHostileMutationEvidenceObligation,
  HOSTILE_MUTATION_EVIDENCE_PATH,
  HOSTILE_MUTATION_PROBES_PATH,
} from '../evidence/hostile-mutation-obligation.ts';
import { compileProjectIntent, PROJECT_INTENT_PATH } from './project-intent.ts';

export interface ProjectGraphContext {
  repository_id: number;
  repository_full_name: string;
}

function parseJson(bytes: Buffer, error: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(error);
  }
}

export function compileProjectGraph(
  snapshot: RepositorySnapshot,
  context: ProjectGraphContext,
): ObligationInput[] {
  const desired: ObligationInput[] = [];

  const intent = snapshot.optionalBytes(PROJECT_INTENT_PATH);
  if (intent !== null) {
    desired.push(...compileProjectIntent(parseJson(intent, 'PROJECT_INTENT_JSON_INVALID')));
  }

  const probes = snapshot.optionalBytes(HOSTILE_MUTATION_PROBES_PATH);
  const evidence = snapshot.optionalBytes(HOSTILE_MUTATION_EVIDENCE_PATH);
  if ((probes === null) !== (evidence === null)) {
    throw new Error('PROJECT_GRAPH_PRODUCER_INPUT_INCOMPLETE:hostile-mutation-evidence');
  }
  if (probes !== null) {
    desired.push(
      compileHostileMutationEvidenceObligation({
        snapshot,
        repositoryId: context.repository_id,
        repositoryFullName: context.repository_full_name,
      }),
    );
  }

  return desired;
}
