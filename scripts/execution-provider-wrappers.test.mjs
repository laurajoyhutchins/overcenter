import assert from 'node:assert/strict';
import test from 'node:test';

import { executeDeterministicWorkSettlement } from '../lib/deterministic-work-settlement-execution.js';
import { executeGithubChangeset } from '../lib/github-changeset-execution.js';
import { executeGithubRelease } from '../lib/github-release-execution.js';
import { executePortfolioReconciliation } from '../lib/portfolio-reconcile-execution.js';
import { executeProductionMaterialization } from '../lib/production-materialization-execution.js';
import { executeProjectAuthoring } from '../lib/project-authoring-execution.js';

const revision = 'a'.repeat(40);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class MemoryStore {
  constructor() {
    this.rows = new Map();
    this.operations = [];
  }

  async prepareExecution({ identity }) {
    const existing = this.rows.get(identity.execution_id);
    if (existing) return clone(existing);
    const row = {
      identity: clone(identity),
      lifecycle: 'prepared',
      attempt_epoch: 0,
      mutation_certainty: 'definitely_not_mutated',
      effect_ref: null,
      proof_ids: [],
      settled: false,
      settlement_receipt: null,
    };
    this.rows.set(identity.execution_id, row);
    this.operations.push(clone(identity));
    return clone(row);
  }

  async claimExecution(input) {
    const row = this.rows.get(input.execution_id);
    if (!row) throw Object.assign(new Error('missing execution'), { code: 'EXECUTION_NOT_FOUND' });
    if (row.settled) return { kind: 'replayed', snapshot: clone(row) };
    row.identity.run_id = input.run_id;
    row.identity.lease_ref = input.lease_ref;
    row.identity.lease_epoch = input.lease_epoch;
    row.lifecycle = 'executing';
    return { kind: 'claimed', snapshot: clone(row) };
  }

  async recordAttempt({ identity, attempt_epoch, request_sha256 }) {
    const row = this.rows.get(identity.execution_id);
    row.attempt_epoch = attempt_epoch;
    row.request_sha256 = request_sha256;
    return {
      operation_id: identity.operation_id,
      execution_id: identity.execution_id,
      attempt_epoch,
      request_sha256,
      mutation_certainty: row.mutation_certainty,
      effect_ref: row.effect_ref,
      response_sha256: null,
    };
  }

  async recordInvocation({ identity, attempt_epoch, facts }) {
    const row = this.rows.get(identity.execution_id);
    row.attempt_epoch = attempt_epoch;
    row.mutation_certainty = facts.transport
      ? 'confirmed_mutated'
      : facts.status === 'confirmed' ? 'confirmed_mutated' : 'definitely_not_mutated';
    row.effect_ref = facts.effect_ref;
    row.lifecycle = 'effect_confirmed';
    return {
      operation_id: identity.operation_id,
      execution_id: identity.execution_id,
      attempt_epoch,
      request_sha256: row.request_sha256,
      mutation_certainty: row.mutation_certainty,
      effect_ref: row.effect_ref,
      response_sha256: facts.response_sha256 ?? null,
    };
  }

  async appendProof(input) {
    const row = this.rows.get(input.execution_id);
    row.proof_ids.push(input.proof_id);
    row.proof = clone(input);
    return clone(input);
  }

  async settleExecution(input) {
    const row = this.rows.get(input.identity.execution_id);
    if (row.settlement_receipt) return clone(row.settlement_receipt);
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
    row.lifecycle = 'settled';
    row.settled = true;
    row.settlement_receipt = receipt;
    return clone(receipt);
  }

  async readExecution(executionId) {
    const row = this.rows.get(executionId);
    return row ? clone(row) : null;
  }
}

function providerFor(request) {
  const observed = request.source_revision || request.base_revision || request.target_revision
    || request.expected_revision || revision;
  const calls = { invoke: 0 };
  return {
    calls,
    async preflight() {
      return { provider: 'wrapper-test', observed_revision: observed, provider_identity: {} };
    },
    async invoke() {
      calls.invoke += 1;
      return {
        transport: 'accepted',
        committed: true,
        effect_ref: 'effect:' + calls.invoke,
        response_sha256: 'b'.repeat(64),
        evidence: { observed },
      };
    },
    async confirm() {
      return {
        status: 'confirmed',
        effect_ref: 'effect:1',
        predicate: 'wrapper-test-readback',
        evidence: { observed },
      };
    },
  };
}

function ports(store) {
  return {
    executionTransactionStore: store,
    executionContext: () => ({
      run_id: 'run-wrapper-test',
      subject_kind: 'provider_operation',
      lease_expires_at: '2999-01-01T00:00:00.000Z',
    }),
    providerFor,
  };
}

const project = 'github:laurajoyhutchins/overcenter';
const base = {
  project_ref: project,
  repository: 'laurajoyhutchins/overcenter',
  authority_revision: revision,
  authority_epoch: 3,
  graph_fingerprint: 'graph-wrapper',
  transition_fingerprint: 'transition-wrapper',
};

test('all uncertain provider effects use the same execution transaction wrapper contract', async () => {
  const store = new MemoryStore();
  const cases = [
    [
      executeDeterministicWorkSettlement,
      {
        ...base,
        subject_key: 'work:LJH-117',
        work_ref: 'LJH-117',
        predicate_key: 'scheduled-cycle-v1',
        target_state: 'Done',
        evaluation: { satisfied: true },
      },
    ],
    [
      executeGithubChangeset,
      {
        ...base,
        subject_key: project + ':branch:work',
        repo: base.repository,
        branch: 'work',
        base_revision: revision,
        expected_head: revision,
        changes: { 'README.md': 'updated' },
        commit_message: 'test changeset',
      },
    ],
    [
      executeGithubRelease,
      {
        ...base,
        subject_key: project + ':release:v1',
        repo: base.repository,
        target_revision: revision,
        tag_name: 'v1.0.0',
        body: 'test release',
      },
    ],
    [
      executePortfolioReconciliation,
      {
        ...base,
        subject_key: project + ':portfolio',
        observation: { source: 'github', revision },
        plan: { action: 'reconcile' },
      },
    ],
    [
      executeProductionMaterialization,
      {
        ...base,
        subject_key: project + ':materialization',
        repo: base.repository,
        branch: 'dev',
        source_revision: revision,
        runtime_ref: 'runtime-1',
        expected_version: 1,
        source_manifest_sha256: 'c'.repeat(64),
      },
    ],
    [
      executeProjectAuthoring,
      {
        ...base,
        subject_key: project + ':authoring',
        expected_revision: revision,
        definition: { transitions: [] },
        amendment: { add_transition: 'ship' },
      },
    ],
  ];

  for (const [execute, request] of cases) {
    const first = await execute(request, ports(store));
    const replay = await execute(request, ports(store));
    assert.equal(first.receipt.disposition, 'completed');
    assert.equal(replay.receipt.execution_id, first.receipt.execution_id);
  }

  assert.equal(store.operations.length, cases.length);
  for (const identity of store.operations) {
    assert.equal(identity.subject_kind, 'provider_operation');
    assert.equal(identity.authority_epoch, 3);
    assert.equal(typeof identity.intent_sha256, 'string');
    assert.equal(identity.operation_kind.startsWith('execution.'), false);
  }
});
