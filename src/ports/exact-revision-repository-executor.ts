export type RepositoryExecutorNetworkPolicy = 'none' | 'restricted';

export type RepositoryExecutionCapabilities = Readonly<{
  network: RepositoryExecutorNetworkPolicy;
  repository_write: false;
}>;

export type RepositoryExecutorIdentity = Readonly<{
  provider: string;
  implementation: string;
  fingerprint: string;
}>;

export type ExactRevisionRepositoryExecutionRequest = Readonly<{
  source: Readonly<{ repository: string; revision: string }>;
  authority: Readonly<{
    transition_id: string;
    lease_ref: string;
    transition_definition_fingerprint: string;
  }>;
  executor: Readonly<{
    identity: RepositoryExecutorIdentity;
    capabilities: RepositoryExecutionCapabilities;
  }>;
  limits: Readonly<{
    max_output_bytes: number;
    max_evidence_items: number;
  }>;
}>;

export type RepositoryExecutionResult = Readonly<{
  status: 'completed' | 'blocked';
  summary: string;
  evidence: ReadonlyArray<Readonly<{ kind: string; detail: string }>>;
}>;

/**
 * Provider-neutral port for untrusted repository execution.
 *
 * Implementations receive only an exact-revision request whose repository write
 * capability is statically forbidden. GitHub Actions, Codex, or any later
 * execution host belongs behind this port rather than in Overcenter semantics.
 */
export interface ExactRevisionRepositoryExecutor {
  readonly identity: RepositoryExecutorIdentity;
  readonly capabilities: RepositoryExecutionCapabilities;
  execute(request: ExactRevisionRepositoryExecutionRequest): Promise<RepositoryExecutionResult>;
}
