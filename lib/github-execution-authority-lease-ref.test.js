import { sha256Text } from 'lib/canonical-json.js';
import { createExecutionAuthorityService } from 'lib/execution-authority.js';
import { executionProjection } from 'lib/work-leases.js';

const NOW = '2026-08-26T16:00:00.000Z';
const TOKEN = 'fixture-token';
const LEASE_REF = '11111111-1111-4111-8111-111111111111';
const WORK_REF = 'LJH-lease-ref';
const RUN_ID = 'run-lease-ref';
const REPO = 'laurajoyhutchins/overcenter';
const GATE = 'lane:repo-implementation';

function issue() {
  return {
    identifier: WORK_REF,
    title: 'Lease reference authority fixture',
    description: `Repository: ${REPO}\nOutcome: Resolve mutation authority without exposing capability material.\nNext action: Verify the bounded authority lookup.`,
    priority: 1,
    archivedAt: null,
    updatedAt: '2026-08-26T15:59:00.000Z',
    state: { id: 'state-todo', name: 'Todo', type: 'unstarted' },
    labels: [{ id: 'lane-repo', name: GATE }],
    teamStates: [],
    teamLabels: [],
    project: { id: 'project-overcenter', name: 'Overcenter Reliability' },
    team: { id: 'team-ljh', name: 'Ljh-projects' },
    relations: [],
  };
}

async function fixture() {
  const authoritativeIssue = issue();
  const lease = {
    lease_id: LEASE_REF,
    work_ref: WORK_REF,
    gate: GATE,
    run_id: RUN_ID,
    status: 'active',
    expires_at: '2026-08-26T16:30:00.000Z',
    hard_expires_at: '2026-08-26T18:00:00.000Z',
    claim_receipt: {
      execution_projection: executionProjection(authoritativeIssue),
      execution_fingerprint: 'lease-ref-fixture',
    },
  };
  const tokenHash = await sha256Text(TOKEN);
  const store = {
    async getLeaseById(id) { return id === LEASE_REF ? lease : null; },
    async getLeaseByTokenHash(hash) { return hash === tokenHash ? lease : null; },
    async getSlot() { return { work_ref: WORK_REF, gate: GATE, lease_id: LEASE_REF, expires_at: '2026-08-26T16:30:00.000Z' }; },
    async getRun() { return { run_id: RUN_ID, status: 'active', deadline_at: '2026-08-26T17:00:00.000Z' }; },
  };
  return createExecutionAuthorityService({
    store,
    authoritative: { async getIssue() { return authoritativeIssue; } },
    now: () => NOW,
  });
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

export async function runGithubExecutionAuthorityLeaseRefTests() {
  const results = [];

  results.push(await run('non-secret lease reference resolves the same durable execution authority', async () => {
    const service = await fixture();
    const result = await service.require({ lease_ref: LEASE_REF, repository: REPO, allowed_gates: [GATE] });
    check(result.lease_id === LEASE_REF, 'lease reference did not resolve the expected lease');
    check(result.work_ref === WORK_REF && result.run_id === RUN_ID && result.repository === REPO, 'resolved authority evidence was incomplete');
    check(!JSON.stringify(result).includes(TOKEN), 'resolved authority leaked capability material');
  }));

  results.push(await run('unknown lease reference fails closed', async () => {
    const service = await fixture();
    await expectCode(service.require({ lease_ref: '22222222-2222-4222-8222-222222222222', repository: REPO, allowed_gates: [GATE] }), 'EXECUTION_AUTHORITY_INVALID');
  }));

  results.push(await run('token plus lease reference is rejected as ambiguous', async () => {
    const service = await fixture();
    await expectCode(service.require({ lease_token: TOKEN, lease_ref: LEASE_REF, repository: REPO, allowed_gates: [GATE] }), 'EXECUTION_AUTHORITY_INVALID');
  }));

  const failed = results.filter(result => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results };
}
