import type {
  ExactRevisionRepositoryExecutionRequest,
  ExactRevisionRepositoryExecutor,
  RepositoryExecutionResult,
} from '../src/ports/exact-revision-repository-executor.js';

const result: RepositoryExecutionResult = {
  status: 'completed',
  summary: 'verified',
  evidence: [{ kind: 'test', detail: 'passed' }],
};

const providerA: ExactRevisionRepositoryExecutor = {
  identity: { provider: 'github-actions', implementation: 'codex', fingerprint: 'a'.repeat(64) },
  capabilities: { network: 'restricted', repository_write: false },
  async execute(_request: ExactRevisionRepositoryExecutionRequest) { return result; },
};

const providerB: ExactRevisionRepositoryExecutor = {
  identity: { provider: 'local-runner', implementation: 'fixture', fingerprint: 'b'.repeat(64) },
  capabilities: { network: 'none', repository_write: false },
  async execute(_request: ExactRevisionRepositoryExecutionRequest) { return result; },
};

void [providerA, providerB];
