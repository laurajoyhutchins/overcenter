import assert from 'node:assert/strict';
import test from 'node:test';
import { productionPromotionFor } from '../lib/production-promotion-overcenter-host.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function certainty(facts) {
  if ('status' in facts) {
    return facts.status === 'confirmed'
      ? 'confirmed_mutated'
      : facts.status === 'absent' ? 'definitely_not_mutated' : 'may_have_mutated';
  }
  return facts.transport === 'rejected' && facts.committed === false
    ? 'definitely_not_mutated'
    : facts.transport === 'accepted' && facts.committed === true
      ? 'confirmed_mutated'
      : 'may_have_mutated';
}

class MemoryExecutionTransactionStore {
  constructor() {
    this.executions = new Map();
    this.idempotency = new Map();
  }

  snapshot(value) {
    return clone(value);
  }

  async prepareExecution({ identity }) {
    const existingId = this.idempotency.get(identity.idempotency_key);
    if (existingId) return this.snapshot(this.executions.get(existingId));
    const execution = {
      identity:clone(identity),
      lifecycle:'prepared',
      attempt_epoch:0,
      mutation_certainty:'definitely_not_mutated',
      effect_ref:null,
      proof_ids:[],
      settled:false,
      settlement_receipt:null,
      lease_expires_at:'1970-01-01T00:00:00.000Z',
    };
    this.executions.set(identity.execution_id, execution);
    this.idempotency.set(identity.idempotency_key, identity.execution_id);
    return this.snapshot(execution);
  }

  async claimExecution(input) {
    const execution = this.executions.get(input.execution_id);
    if (!execution) throw Object.assign(new Error('execution missing'), { code:'EXECUTION_NOT_FOUND' });
    if (execution.settled) return { kind:'replayed', snapshot:this.snapshot(execution) };
    const sameLease = execution.identity.lease_ref === input.lease_ref
      && execution.identity.lease_epoch === input.lease_epoch;
    const expired = Date.parse(execution.lease_expires_at) <= Date.now();
    if (!sameLease && !expired) return { kind:'busy', snapshot:this.snapshot(execution) };
    execution.identity.lease_ref = input.lease_ref;
    execution.identity.lease_epoch = input.lease_epoch;
    execution.lease_expires_at = input.lease_expires_at;
    execution.lifecycle = 'executing';
    return { kind:sameLease ? 'replayed' : 'claimed', snapshot:this.snapshot(execution) };
  }

  async recordAttempt({ identity, attempt_epoch, request_sha256 }) {
    const execution = this.executions.get(identity.execution_id);
    if (!execution || execution.identity.lease_ref !== identity.lease_ref) {
      throw Object.assign(new Error('stale execution'), { code:'STALE_EXECUTION' });
    }
    execution.attempt_epoch = attempt_epoch;
    execution.request_sha256 = request_sha256;
    return {
      operation_id:identity.operation_id,
      execution_id:identity.execution_id,
      attempt_epoch,
      request_sha256,
      mutation_certainty:execution.mutation_certainty,
      effect_ref:execution.effect_ref,
      response_sha256:null,
    };
  }

  async recordInvocation({ identity, attempt_epoch, facts }) {
    const execution = this.executions.get(identity.execution_id);
    if (!execution || execution.identity.lease_ref !== identity.lease_ref || execution.attempt_epoch !== attempt_epoch) {
      throw Object.assign(new Error('stale attempt'), { code:'STALE_ATTEMPT' });
    }
    const value = certainty(facts);
    execution.mutation_certainty = value;
    execution.effect_ref = facts.effect_ref;
    execution.lifecycle = value === 'confirmed_mutated'
      ? 'effect_confirmed'
      : value === 'definitely_not_mutated' ? 'effect_absent' : 'effect_uncertain';
    execution.facts = clone(facts);
    return {
      operation_id:identity.operation_id,
      execution_id:identity.execution_id,
      attempt_epoch,
      request_sha256:execution.request_sha256,
      mutation_certainty:value,
      effect_ref:facts.effect_ref,
      response_sha256:'transport' in facts ? facts.response_sha256 : null,
    };
  }

  async appendProof(input) {
    const execution = this.executions.get(input.execution_id);
    if (!execution || execution.identity.authority_revision !== input.authority_revision
        || execution.identity.authority_epoch !== input.authority_epoch) {
      throw Object.assign(new Error('proof identity mismatch'), { code:'PROOF_IDENTITY_MISMATCH' });
    }
    if (!execution.proof_ids.includes(input.proof_id)) execution.proof_ids.push(input.proof_id);
    return clone(input);
  }

  async settleExecution(input) {
    const execution = this.executions.get(input.identity.execution_id);
    if (!execution || execution.identity.lease_ref !== input.identity.lease_ref
        || execution.identity.lease_epoch !== input.identity.lease_epoch) {
      throw Object.assign(new Error('stale execution'), { code:'STALE_EXECUTION' });
    }
    if (execution.settlement_receipt) return clone(execution.settlement_receipt);
    if (execution.mutation_certainty === 'may_have_mutated') {
      throw Object.assign(new Error('effect uncertain'), { code:'EFFECT_UNCERTAIN' });
    }
    const receipt = {
      schema:'settlement-receipt-v1',
      execution_id:input.identity.execution_id,
      operation_id:input.identity.operation_id,
      authority_revision:input.identity.authority_revision,
      authority_epoch:input.identity.authority_epoch,
      lifecycle:'settled',
      disposition:input.disposition,
      effect_ref:input.effect_ref,
      evidence_sha256:input.evidence_sha256,
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

function githubState({ changeAfterVerification = false } = {}) {
  const source = 'a'.repeat(40);
  const moved = 'c'.repeat(40);
  const previous = 'b'.repeat(40);
  const state = { dev:source, main:previous, updateCalls:0 };
  const run = {
    id:123,
    path:'.github/workflows/exact-revision-v8.yml',
    event:'push',
    head_branch:'dev',
    head_sha:source,
    status:'completed',
    conclusion:'success',
  };

  const withGitHubAppApiClient = async (_repo, callback) => callback({
    async call(_provider, request) {
      const path = String(request.path);
      if (request.method === 'GET' && path.includes('/branches/')) {
        const branch = decodeURIComponent(path.split('/').pop());
        return { status:200, body:{ commit:{ sha:state[branch] } } };
      }
      if (request.method === 'GET' && path.includes('/actions/runs?')) {
        if (changeAfterVerification) state.dev = moved;
        return { status:200, body:{ workflow_runs:[run] } };
      }
      if (request.method === 'GET' && path.endsWith('/actions/runs/123')) {
        return { status:200, body:run };
      }
      if (request.method === 'GET' && path.includes('/compare/')) {
        return { status:200, body:{ status:'ahead' } };
      }
      if (request.method === 'PATCH' && path.includes('/git/refs/heads/')) {
        state.updateCalls += 1;
        state.main = request.body.sha;
        return { status:200, body:{ object:{ sha:state.main } } };
      }
      throw new Error(`unexpected GitHub request: ${request.method} ${path}`);
    },
  });
  return { source, state, withGitHubAppApiClient };
}

function runtimeFor(github, store) {
  return productionPromotionFor({
    db:{},
    branchRoles:{
      repository:'laurajoyhutchins/overcenter',
      development_branch:'dev',
      production_branch:'main',
      production_source_ref:'refs/heads/main',
    },
    executionTransactionStore:store,
    withGitHubAppApiClient:github.withGitHubAppApiClient,
  });
}

test('production promotion uses one durable kernel execution and one provider mutation', async () => {
  const github = githubState();
  const runtime = runtimeFor(github, new MemoryExecutionTransactionStore());
  const result = await runtime.promote({ repo:'laurajoyhutchins/overcenter' });
  assert.equal(result.ok, true);
  assert.equal(result.production_revision, github.source);
  assert.equal(github.state.updateCalls, 1);
  assert.equal(github.state.main, github.source);
});

test('source revision drift is settled as a rejected execution before mutation', async () => {
  const github = githubState({ changeAfterVerification:true });
  const runtime = runtimeFor(github, new MemoryExecutionTransactionStore());
  await assert.rejects(
    runtime.promote({ repo:'laurajoyhutchins/overcenter' }),
    error => error?.code === 'PRODUCTION_PROMOTION_NOT_COMPLETED' && error?.may_have_mutated === false,
  );
  assert.equal(github.state.updateCalls, 0);
});
