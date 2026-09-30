import type { Data } from '../model.ts';

export interface BoundSourceTransactionPlan extends Data {
  schema: 'overcenter-source-transaction';
  schema_version: 1;
  repository_id: number;
  repository_full_name: string;
  runtime_sha: string;
  claim: Data & {
    obligation_key: string;
    run_id: string;
    claimed_revision: string;
    source_sha: string;
  };
  execution_generation: number;
  execution_authority_commit: string;
  candidate_sha: string;
  candidate_tree: string;
}

export interface SourceTransactionBindingFact {
  schema: 'overcenter-source-transaction-binding';
  schema_version: 1;
  run_id: string;
  obligation_id: string;
  execution_generation: number;
  execution_authority_commit: string;
  plan: BoundSourceTransactionPlan;
  plan_digest: string;
}
