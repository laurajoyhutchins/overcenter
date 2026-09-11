import assert from 'node:assert/strict';
import test from 'node:test';
import { executeExecutionTransaction, recoverExecutionTransaction } from '../lib/execution-transaction-runtime.js';
import { mutationCertaintyFromFacts } from '../lib/execution-transaction.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function intent(revision = 'a'.repeat(40)) {
  return {
    project_ref: 'github:laurajoyhutchins/overcenter',
    subject_key: 'project:overcenter#transition:ship',
    authority: {
      project_ref: 'github:laurajoyhutchins/overcenter',
      repository: 'laurajoyhutchins/overcenter',
      revision,
      epoch: 3,
      graph_fingerprint: 'graph-hash',
      transition_fingerprint: 'transition-hash',
    },
    operation: {
      kind: 'github.apply_changeset',
      idempotency_scope: 'repository:laurajoyhutchins/overcenter',
      idempotency_key: 'intent-1',
      payload: { changeset: 'changeset-1' },
    },
  };
}

function context(overrides = {}) {
  return {
    run_id: 'run-1',
    subject_kind: 'project_transition',
    lease_expires_at: '2999-01-01T00:00:00.000Z',
    ...overrides,
  };
}

class MemoryStore {
  constructor({ failSettlementOnce = false } = {}) {
    this.executions = new Map();
    this.idempotency = new Map();
    this.failSettlementOnce = failSettlementOnce;
  }

  snapshot(execution) {
    return clone(execution);
  }

  async prepareExecution({ identity }) {
    const existingId = this.idempotency.get(identity.idempotency_key);
    if (existingId) return this.snapshot(this.executions.get(existingId));
    const existing = this.executions.get(identity.execution_id);
    if (existing) return this.snapshot(existing);
    const execution = {
      identity: clone(identity),
      lifecycle: 'prepared',
      attempt_epoch: 0,
      mutation_certainty: 'definitely_not_mutated',
      effect_ref: null,
      proof_ids: [],
      settled: false,
      settlement_receipt: null,
      lease_expires_at: '1970-01-01T00:00:00.000Z',
    };
    this.executions.set(identity.execution_id, execution);
    this.idempotency.set(identity.idempotency_key, identity.execution_id);
    return this.snapshot(execution);
  }

  async claimExecution(input) {
    const execution = this.executions.get(input.execution_id);
    if (!execution) throw Object.assign(new Error('missing'), { code: 'EXECUTION_NOT_FOUND' });
    if (execution.settled) return { kind: 'replayed', snapshot: this.snapshot(execution) };
    if (execution.identity.authority_epoch !== input.authority_epoch) {
      throw Object.assign(new Error('STALE_EXECUTION'), { code: 'STALE_EXECUTION' });
    }
    const sameLease = execution.identity.lease_ref === input.lease_ref &&
      execution.identity.lease_epoch === input.lease_epoch;
    const expired = execution.lease_expires_at <= new Date().toISOString();
    if (!sameLease && !expired) {
      return { kind: 'busy', snapshot: this.snapshot(execution) };
    }
    execution.identity.lease_ref = input.lease_ref;
    execution.identity.lease_epoch = input.lease_epoch;
    execution.lease_expires_at = input.lease_expires_at;
    execution.lifecycle = 'executing';
    return { kind: 'claimed', snapshot: this.snapshot(execution) };
  }

  async heartbeatExecution() {
    throw new Error('not used');
  }

  async recordAttempt({ identity, attempt_epoch, request_sha256 }) {
    const execution = this.executions.get(identity.execution_id);
    if (!execution || execution.identity.lease_ref !== identity.lease_ref ||
        execution.identity.lease_epoch !== identity.lease_epoch) {
      throw Object.assign(new Error('STALE_EXECUTION'), { code: 'STALE_EXECUTION' });
    }
    if (execution.mutation_certainty !== 'definitely_not_mutated') {
      throw Object.assign(new Error('EFFECT_CONFIRMATION_REQUIRED'), { code: 'EFFECT_CONFIRMATION_REQUIRED' });
    }
    execution.attempt_epoch = attempt_epoch;
    execution.request_sha256 = request_sha256;
    return {
      operation_id: identity.operation_id,
      execution_id: identity.execution_id,
      attempt_epoch,
      request_sha256,
      mutation_certainty: execution.mutation_certainty,
      effect_ref: execution.effect_ref,
      response_sha256: null,
    };
  }

  async recordInvocation({ identity, attempt_epoch, facts }) {
    const execution = this.executions.get(identity.execution_id);
    if (!execution || execution.identity.lease_ref !== identity.lease_ref ||
        execution.identity.lease_epoch !== identity.lease_epoch ||
        execution.attempt_epoch !== attempt_epoch) {
      throw Object.assign(new Error('STALE_ATTEMPT'), { code: 'STALE_ATTEMPT' });
    }
    const certainty = mutationCertaintyFromFacts(facts);
    execution.mutation_certainty = certainty;
    execution.effect_ref = facts.effect_ref;
    execution.lifecycle = certainty === 'confirmed_mutated'
      ? 'effect_confirmed'
      : certainty === 'definitely_not_mutated' ? 'effect_absent' : 'effect_uncertain';
    execution.facts = clone(facts);
    return {
      operation_id: identity.operation_id,
      execution_id: identity.execution_id,
      attempt_epoch,
      request_sha256: execution.request_sha256,
      mutation_certainty: certainty,
      effect_ref: facts.effect_ref,
      response_sha256: facts.response_sha256 ?? null,
    };
  }

  async appendProof(input) {
    const execution = this.executions.get(input.execution_id);
    if (!execution || execution.identity.authority_revision !== input.authority_revision ||
        execution.identity.authority_epoch !== input.authority_epoch) {
      throw Object.assign(new Error('PROOF_IDENTITY_MISMATCH'), { code: 'PROOF_IDENTITY_MISMATCH' });
    }
    if (!execution.proof_ids.includes(input.proof_id)) execution.proof_ids.push(input.proof_id);
    execution.proof = clone(input);
    return clone(input);
  }

  async settleExecution(input) {
    const execution = this.executions.get(input.identity.execution_id);
    if (!execution || execution.identity.lease_ref !== input.identity.lease_ref ||
        execution.identity.lease_epoch !== input.identity.lease_epoch) {
      throw Object.assign(new Error('STALE_EXECUTION'), { code: 'STALE_EXECUTION' });
    }
    if (execution.settlement_receipt) return clone(execution.settlement_receipt);
    if (this.failSettlementOnce) {
      this.failSettlementOnce = false;
      throw Object.assign(new Error('database commit failed'), { code: 'DB_COMMIT_FAILED' });
    }
    if (execution.mutation_certainty === 'may_have_mutated') {
      throw Object.assign(new Error('EFFECT_UNCERTAIN'), { code: 'EFFECT_UNCERTAIN' });
    }
    const receipt = {
      schema: 'settlement-receipt-v1',
      execution_id: input.identity.execution_id,
      operation_id: input.identity.operation_id,
      authority_revision: input.identity.authority_revision,
      authority_epoch: input.identity.authority_epoch,
      lifecycle: 'settled',
      disposition: input.disposition,
      effect_ref: input.effect_ref,
      evidence_sha256: input.evidence_sha256,
    };
    execution.lifecycle = 'settled';
    execution.settled = true;
    execution.settlement_receipt = receipt;
    return clone(receipt);
  }

  async readExecution(executionId) {
    const execution = this.executions.get(executionId);
    return execution ? this.snapshot(execution) : null;
  }
}

function providerFor({ observedRevision = 'a'.repeat(40), mode = 'success' } = {}) {
  const calls = { invoke: 0, confirm: 0 };
  return {
    calls,
    async preflight() {
      return {
        provider: 'test-provider',
        observed_revision: observedRevision,
        provider_identity: { mode },
      };
    },
    async invoke() {
      calls.invoke += 1;
      if (mode === 'unknown') {
        return {
          transport: 'unknown',
          committed: null,
          effect_ref: null,
          response_sha256: null,
          evidence: { status: 'timeout' },
        };
      }
      return {
        transport: 'accepted',
        committed: true,
        effect_ref: 'provider-effect-1',
        response_sha256: 'response-hash',
        evidence: { status: 'accepted' },
      };
    },
    async confirm() {
      calls.confirm += 1;
      if (mode === 'unknown') {
        return {
          status: 'unknown',
          effect_ref: null,
          predicate: 'exact-effect',
          evidence: { status: 'still-unknown' },
        };
      }
      if (mode === 'absent') {
        return {
          status: 'absent',
          effect_ref: null,
          predicate: 'exact-effect',
          evidence: { status: 'absent' },
        };
      }
      return {
        status: 'confirmed',
        effect_ref: 'provider-effect-1',
        predicate: 'exact-effect',
        evidence: { status: 'present' },
      };
    },
  };
}

test('duplicate delivery settles one execution and invokes the provider once', async () => {
  const store = new MemoryStore();
  const provider = providerFor();
  const first = await executeExecutionTransaction({
    intent: intent(),
    context: context(),
    provider,
    store,
  });
  const replay = await executeExecutionTransaction({
    intent: intent(),
    context: context(),
    provider,
    store,
  });
  assert.equal(first.receipt.execution_id, replay.receipt.execution_id);
  assert.equal(provider.calls.invoke, 1);
});

test('database failure after provider mutation is recovered by exact readback', async () => {
  const store = new MemoryStore({ failSettlementOnce: true });
  const provider = providerFor();
  await assert.rejects(
    executeExecutionTransaction({ intent: intent(), context: context(), provider, store }),
    error => error?.code === 'DB_COMMIT_FAILED',
  );
  const recovered = await recoverExecutionTransaction({
    execution_id: [...store.executions.keys()][0],
    intent: intent(),
    context: context(),
    provider,
    store,
  });
  assert.equal(recovered.receipt.disposition, 'completed');
  assert.equal(provider.calls.invoke, 1);
  assert.equal(provider.calls.confirm, 1);
});

test('unknown provider outcome is escalated without a blind retry', async () => {
  const store = new MemoryStore();
  const provider = providerFor({ mode: 'unknown' });
  await assert.rejects(
    executeExecutionTransaction({ intent: intent(), context: context(), provider, store }),
    error => error?.code === 'EXECUTION_ESCALATED',
  );
  assert.equal(provider.calls.invoke, 1);
  assert.equal(provider.calls.confirm, 1);
});

test('source revision drift is rejected before provider mutation', async () => {
  const store = new MemoryStore();
  const provider = providerFor({ observedRevision: 'b'.repeat(40) });
  const result = await executeExecutionTransaction({
    intent: intent(),
    context: context(),
    provider,
    store,
  });
  assert.equal(result.receipt.disposition, 'rejected');
  assert.equal(provider.calls.invoke, 0);
});


test('worker death before the effect is retryable after a fresh claim', async () => {
  const store = new MemoryStore();
  const deadWorker = providerFor();
  deadWorker.preflight = async () => {
    throw new Error('worker died before effect');
  };
  await assert.rejects(
    executeExecutionTransaction({ intent: intent(), context: context(), provider: deadWorker, store }),
  );
  const execution_id = [...store.executions.keys()][0];
  const replacement = await recoverExecutionTransaction({
    execution_id,
    intent: intent(),
    context: context({ lease_epoch: 2, lease_ref: 'replacement-lease' }),
    provider: providerFor(),
    store,
  });
  assert.equal(replacement.receipt.disposition, 'completed');
});

test('two workers racing for one live lease produce one busy result', async () => {
  const store = new MemoryStore();
  const worker = providerFor();
  worker.preflight = async () => {
    throw new Error('pause after claim');
  };
  await assert.rejects(
    executeExecutionTransaction({ intent: intent(), context: context(), provider: worker, store }),
  );
  const execution_id = [...store.executions.keys()][0];
  const raced = await store.claimExecution({
    execution_id,
    lease_ref: 'replacement-lease',
    lease_epoch: 2,
    authority_epoch: 3,
    lease_expires_at: '2999-01-01T00:00:00.000Z',
  });
  assert.equal(raced.kind, 'busy');
});

test('a stale worker cannot settle after its lease is replaced', async () => {
  const store = new MemoryStore();
  const worker = providerFor();
  worker.preflight = async () => {
    throw new Error('pause after claim');
  };
  await assert.rejects(
    executeExecutionTransaction({ intent: intent(), context: context(), provider: worker, store }),
  );
  const execution_id = [...store.executions.keys()][0];
  const oldIdentity = clone(store.executions.get(execution_id).identity);
  store.executions.get(execution_id).lease_expires_at = '1970-01-01T00:00:00.000Z';
  await store.claimExecution({
    execution_id,
    lease_ref: 'replacement-lease',
    lease_epoch: 2,
    authority_epoch: 3,
    lease_expires_at: '2999-01-01T00:00:00.000Z',
  });
  await assert.rejects(
    store.settleExecution({
      identity: oldIdentity,
      attempt_epoch: 1,
      disposition: 'completed',
      effect_ref: 'provider-effect-1',
      evidence_sha256: 'evidence-hash',
    }),
    error => error?.code === 'STALE_EXECUTION',
  );
});

test('evidence bound to another revision is rejected', async () => {
  const store = new MemoryStore();
  const worker = providerFor();
  worker.preflight = async () => {
    throw new Error('pause after claim');
  };
  await assert.rejects(
    executeExecutionTransaction({ intent: intent(), context: context(), provider: worker, store }),
  );
  const execution_id = [...store.executions.keys()][0];
  const execution = store.executions.get(execution_id);
  await assert.rejects(
    store.appendProof({
      proof_id: 'wrong-revision-proof',
      execution_id,
      operation_id: execution.identity.operation_id,
      attempt_epoch: 1,
      authority_repository: execution.identity.authority_repository,
      authority_revision: 'b'.repeat(40),
      authority_epoch: execution.identity.authority_epoch,
      predicate: 'exact-effect',
      evidence_sha256: 'evidence-hash',
      evidence: {},
    }),
    error => error?.code === 'PROOF_IDENTITY_MISMATCH',
  );
});

test('provider readback confirms an already-applied effect without reinvocation', async () => {
  const store = new MemoryStore();
  const provider = providerFor({ mode: 'unknown-confirmed' });
  const result = await executeExecutionTransaction({
    intent: intent(),
    context: context(),
    provider,
    store,
  });
  assert.equal(result.receipt.disposition, 'completed');
  assert.equal(provider.calls.invoke, 1);
  assert.equal(provider.calls.confirm, 1);
});

test('authority epoch changes fail closed for the old worker', async () => {
  const store = new MemoryStore();
  const worker = providerFor();
  worker.preflight = async () => {
    throw new Error('pause after claim');
  };
  await assert.rejects(
    executeExecutionTransaction({ intent: intent(), context: context(), provider: worker, store }),
  );
  const execution_id = [...store.executions.keys()][0];
  await assert.rejects(
    store.claimExecution({
      execution_id,
      lease_ref: 'replacement-lease',
      lease_epoch: 2,
      authority_epoch: 4,
      lease_expires_at: '2999-01-01T00:00:00.000Z',
    }),
    error => error?.code === 'STALE_EXECUTION',
  );
});
