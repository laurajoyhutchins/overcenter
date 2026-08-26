import { sha256Text } from 'lib/canonical-json.js';
import { classifyCommandError } from 'lib/command-response.js';
import { createExecutionAuthorityService } from 'lib/execution-authority.js';
import {
  applyGithubChangeset,
  createGithubChangesetReceiptStore,
  normalizeGithubChangesetRequest,
} from 'lib/github-apply-changeset.js';
import { safeRequestProjection, semanticRequestHash } from 'lib/orchestration-journal.js';
import { executionProjection } from 'lib/work-leases.js';

const NOW = '2026-08-25T14:00:00.000Z';
const TOKEN = 'fixture-live-lease-token';
const REPO = 'laurajoyhutchins/test';
const WORK_REF = 'LJH-405';
const LEASE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = 'run-authority-fixture';
const GATE = 'lane:repo-implementation';

function sha(seed) {
  return String(seed).padStart(40, '0').slice(-40).replace(/[^0-9a-f]/g, 'a');
}

function issue(overrides = {}) {
  return {
    identifier: WORK_REF,
    title: 'Execution authority fixture',
    description: `Repository: ${REPO}\nOutcome: Mutations require current Busbar authority.\nNext action: Implement the bounded change.`,
    priority: 1,
    archivedAt: null,
    updatedAt: '2026-08-25T13:59:00.000Z',
    state: { id: 'state-todo', name: 'Todo', type: 'unstarted' },
    labels: [{ id: 'lane-repo', name: GATE }],
    teamStates: [],
    teamLabels: [],
    project: { id: 'project-busbar', name: 'Busbar Reliability' },
    team: { id: 'team-ljh', name: 'Ljh-projects' },
    relations: [],
    ...overrides,
  };
}

async function fixture(overrides = {}) {
  const authoritativeIssue = overrides.issue || issue();
  const projection = executionProjection(authoritativeIssue);
  const tokenHash = await sha256Text(TOKEN);
  const lease = {
    lease_id: LEASE_ID,
    work_ref: WORK_REF,
    gate: GATE,
    run_id: RUN_ID,
    status: 'active',
    expires_at: '2026-08-25T14:30:00.000Z',
    hard_expires_at: '2026-08-25T16:30:00.000Z',
    claim_receipt: {
      execution_projection: projection,
      execution_fingerprint: 'fixture-execution-fingerprint',
    },
    ...overrides.lease,
  };
  const slot = {
    work_ref: WORK_REF,
    gate: GATE,
    lease_id: LEASE_ID,
    expires_at: '2026-08-25T14:30:00.000Z',
    ...overrides.slot,
  };
  const run = {
    run_id: RUN_ID,
    status: 'active',
    deadline_at: '2026-08-25T16:45:00.000Z',
    ...overrides.run,
  };
  const store = {
    async getLeaseByTokenHash(hash) { return hash === tokenHash ? lease : null; },
    async getSlot() { return slot; },
    async getRun() { return run; },
  };
  const authoritative = {
    async getIssue() { return overrides.current_issue || authoritativeIssue; },
  };
  return {
    lease,
    slot,
    run,
    service: createExecutionAuthorityService({ store, authoritative, now: () => overrides.now || NOW }),
  };
}

class FakeGithub {
  constructor() {
    this.main = sha(2);
    this.branches = new Map();
    this.commitCreates = 0;
    this.refMutations = 0;
    this.reads = 0;
  }

  async resolveCommit() { this.reads += 1; return { sha: this.main, tree_sha: sha(1), message: 'base' }; }
  async getBranch(repo, branch) { this.reads += 1; const value = this.branches.get(branch); return value ? { ...value } : null; }
  async getCommit() { this.reads += 1; return { sha: this.main, tree_sha: sha(1), message: 'base' }; }
  async getPathEntries(repo, treeSha, paths) { this.reads += 1; return new Map(paths.map(path => [path, null])); }
  async createTree() { return sha(3); }
  async createCommit() { this.commitCreates += 1; return sha(4); }
  async createBranch(repo, branch, commitSha) { this.refMutations += 1; this.branches.set(branch, { sha: commitSha }); }
  async updateBranch(repo, branch, commitSha) { this.refMutations += 1; this.branches.set(branch, { sha: commitSha }); }
}

class MemoryReceipts {
  constructor() { this.row = null; }
  async claim(normalized, digest, attemptToken) {
    if (!this.row) {
      this.row = { state: 'processing', request_sha256: digest, attempt_token: attemptToken };
      return { kind: 'claimed', row: this.row };
    }
    if (this.row.request_sha256 !== digest) return { kind: 'conflict', row: this.row };
    if (this.row.state === 'succeeded' || this.row.state === 'prepared') return { kind: 'existing', row: this.row };
    return { kind: 'in_progress', row: this.row };
  }
  async savePlan(normalized, attemptToken, plan) {
    Object.assign(this.row, {
      base_sha: plan.baseSha,
      old_head: plan.oldHead,
      created_branch: plan.createdBranch,
      precondition_verified: plan.preconditionVerified,
      changed_paths: plan.changedPaths,
    });
  }
  async heartbeat() {}
  async saveTree(normalized, attemptToken, treeSha) { this.row.tree_sha = treeSha; }
  async saveCommit(normalized, attemptToken, commitSha) { this.row.commit_sha = commitSha; this.row.state = 'prepared'; }
  async succeed(normalized, receipt) { this.row.receipt = receipt; this.row.state = 'succeeded'; }
  async abandon() { this.row = null; }
}

function request(overrides = {}) {
  return {
    repo: REPO,
    base_ref: 'main',
    branch: 'feat/authority-required',
    changes: [{ path: 'new.txt', operation: 'create', content: 'hello\n' }],
    commit_message: 'Apply authorized fixture changeset',
    lease_token: TOKEN,
    ...overrides,
  };
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectCode(promise, code) {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    if (error?.code !== code) throw new Error(`expected ${code}, observed ${error?.code || error?.message || error}`);
  }
}

async function run(name, fn) {
  try { await fn(); return { name, ok: true }; }
  catch (error) { return { name, ok: false, error: String(error?.message || error) }; }
}

export async function runGithubExecutionAuthorityTests() {
  const results = [];

  results.push(await run('missing authority is rejected before GitHub mutation', async () => {
    const { service } = await fixture();
    const github = new FakeGithub();
    const result = await applyGithubChangeset(request({ lease_token: undefined }), { github, executionAuthority: service });
    check(result.ok === false && result.error === 'EXECUTION_AUTHORITY_REQUIRED', `unexpected result ${JSON.stringify(result)}`);
    check(github.commitCreates === 0 && github.refMutations === 0, 'unauthorized changeset mutated GitHub');
  }));

  results.push(await run('unknown authority token is rejected', async () => {
    const { service } = await fixture();
    await expectCode(service.require({ lease_token: 'unknown', repository: REPO, allowed_gates: [GATE] }), 'EXECUTION_AUTHORITY_INVALID');
  }));

  results.push(await run('expired lease is rejected', async () => {
    const { service } = await fixture({ lease: { expires_at: '2026-08-25T13:59:59.000Z' } });
    await expectCode(service.require({ lease_token: TOKEN, repository: REPO, allowed_gates: [GATE] }), 'EXECUTION_AUTHORITY_STALE');
  }));

  results.push(await run('non-owning slot is rejected', async () => {
    const { service } = await fixture({ slot: { lease_id: '22222222-2222-4222-8222-222222222222' } });
    await expectCode(service.require({ lease_token: TOKEN, repository: REPO, allowed_gates: [GATE] }), 'EXECUTION_AUTHORITY_STALE');
  }));

  results.push(await run('inactive orchestration run is rejected', async () => {
    const { service } = await fixture({ run: { status: 'finished' } });
    await expectCode(service.require({ lease_token: TOKEN, repository: REPO, allowed_gates: [GATE] }), 'EXECUTION_AUTHORITY_STALE');
  }));

  results.push(await run('wrong repository is rejected', async () => {
    const { service } = await fixture();
    await expectCode(service.require({ lease_token: TOKEN, repository: 'laurajoyhutchins/other', allowed_gates: [GATE] }), 'EXECUTION_AUTHORITY_SCOPE_MISMATCH');
  }));

  results.push(await run('wrong lifecycle gate is rejected', async () => {
    const { service } = await fixture();
    await expectCode(service.require({ lease_token: TOKEN, repository: REPO, allowed_gates: ['lane:integration'] }), 'EXECUTION_AUTHORITY_SCOPE_MISMATCH');
  }));

  results.push(await run('authoritative work projection change invalidates authority', async () => {
    const { service } = await fixture({ current_issue: issue({ priority: 4 }) });
    await expectCode(service.require({ lease_token: TOKEN, repository: REPO, allowed_gates: [GATE] }), 'EXECUTION_AUTHORITY_STALE');
  }));

  results.push(await run('valid authority permits mutation and returns non-secret evidence', async () => {
    const { service } = await fixture();
    const github = new FakeGithub();
    const result = await applyGithubChangeset(request(), { github, executionAuthority: service });
    check(result.ok === true, `authorized changeset failed: ${JSON.stringify(result)}`);
    check(github.commitCreates === 1 && github.refMutations === 1, 'authorized changeset did not create exactly one commit/ref effect');
    check(result.execution_authority?.work_ref === WORK_REF, 'receipt omitted work authority');
    check(result.execution_authority?.lease_id === LEASE_ID, 'receipt omitted lease identity');
    check(result.execution_authority?.gate === GATE, 'receipt omitted gate identity');
    check(!JSON.stringify(result).includes(TOKEN), 'success receipt leaked lease token');
  }));

  results.push(await run('succeeded idempotent replay is non-mutating and does not re-require live authority', async () => {
    const { service } = await fixture();
    const github = new FakeGithub();
    const receipts = new MemoryReceipts();
    const first = await applyGithubChangeset(request({ idempotency_key: 'authority-replay' }), { github, receipts, executionAuthority: service, idFactory: () => LEASE_ID });
    check(first.ok === true, 'first authorized request failed');
    const mutations = github.refMutations;
    const replay = await applyGithubChangeset(request({ idempotency_key: 'authority-replay', lease_token: 'expired-or-replaced-token' }), {
      github,
      receipts,
      executionAuthority: { async require() { throw new Error('authority should not be reread for succeeded replay'); } },
      idFactory: () => LEASE_ID,
    });
    check(replay.ok === true && replay.idempotent_replay === true, 'succeeded replay did not return durable receipt');
    check(github.refMutations === mutations, 'succeeded replay mutated GitHub again');
  }));

  results.push(await run('lease token is excluded from changeset idempotency and orchestration semantic identity', async () => {
    const a = request({ lease_token: 'token-a' });
    const b = request({ lease_token: 'token-b' });
    const hashA = await semanticRequestHash('github.apply_changeset', a);
    const hashB = await semanticRequestHash('github.apply_changeset', b);
    check(hashA === hashB, 'orchestration semantic hash depends on lease token');
    const projection = safeRequestProjection('github.apply_changeset', a);
    check(!JSON.stringify(projection).includes('token-a'), 'safe journal projection leaked lease token');
  }));

  results.push(await run('durable changeset request excludes lease token', async () => {
    const calls = [];
    const db = {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{ state: 'processing' }] };
      },
    };
    const normalized = normalizeGithubChangesetRequest(request({ idempotency_key: 'redaction' }));
    await createGithubChangesetReceiptStore(db).claim(normalized, 'digest', LEASE_ID);
    const storedRequest = JSON.parse(calls[0].params[3]);
    check(storedRequest.lease_token === undefined, 'durable request persisted lease token');
    check(!calls[0].params[3].includes(TOKEN), 'durable request serialized lease token');
  }));

  results.push(await run('execution authority errors are expected precondition rejections', async () => {
    for (const code of ['EXECUTION_AUTHORITY_REQUIRED', 'EXECUTION_AUTHORITY_INVALID', 'EXECUTION_AUTHORITY_STALE', 'EXECUTION_AUTHORITY_SCOPE_MISMATCH']) {
      const classification = classifyCommandError(code, { command: 'github.apply_changeset' });
      check(classification.error_class === 'precondition' && classification.rejection === true && classification.retryable === false, `${code} classification is not fail-closed precondition rejection`);
    }
    const unavailable = classifyCommandError('EXECUTION_AUTHORITY_UNAVAILABLE', { command: 'github.apply_changeset' });
    check(unavailable.error_class === 'upstream' && unavailable.retryable === true, 'authority unavailability is not retryable upstream state');
  }));

  const failed = results.filter(result => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results };
}