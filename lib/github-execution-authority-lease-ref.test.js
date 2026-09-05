// Focused regression coverage for the #67 bootstrap authority transition and graph-native transition authority.
import { sha256Text } from 'lib/canonical-json.js';
import { createExecutionAuthorityService, createPostgresExecutionAuthorityService } from 'lib/execution-authority.js';
import { executionProjection } from 'lib/work-leases.js';

const NOW = '2026-08-26T16:00:00.000Z';
const TOKEN = 'fixture-token';
const LEASE_REF = '11111111-1111-4111-8111-111111111111';
const WORK_REF = 'LJH-lease-ref';
const RUN_ID = 'run-lease-ref';
const REPO = 'laurajoyhutchins/overcenter';
const GATE = 'lane:repo-implementation';
const PROJECT_LEASE_REF = '33333333-3333-4333-8333-333333333333';
const PROJECT_RUN_ID = 'run-project-transition';
const PROJECT_REF = 'github:laurajoyhutchins/overcenter';
const TRANSITION_ID = 'graph-native-transition';
const PROJECT_SLOT_SCOPE = 'project_transition';
const GRAPH_FINGERPRINT = 'graph-fingerprint';
const TRANSITION_FINGERPRINT = 'transition-fingerprint';

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

function projectTransitionFixture(overrides = {}) {
  const subject = {
    project_ref: PROJECT_REF,
    transition_id: TRANSITION_ID,
    repository: REPO,
    authority_revision: '1'.repeat(40),
    authority_derivation: 'test',
    graph_fingerprint: GRAPH_FINGERPRINT,
    transition_definition_fingerprint: TRANSITION_FINGERPRINT,
    ...(overrides.subject || {}),
  };
  const lease = {
    lease_id: PROJECT_LEASE_REF,
    work_ref: `project_transition:${PROJECT_REF}:${TRANSITION_ID}`,
    gate: PROJECT_SLOT_SCOPE,
    run_id: PROJECT_RUN_ID,
    status: 'active',
    expires_at: '2026-08-26T16:30:00.000Z',
    hard_expires_at: '2026-08-26T18:00:00.000Z',
    claim_receipt: {
      schema: 'project-transition-lease-claim-v1',
      subject: 'project_transition',
      project_transition: subject,
      execution_fingerprint: GRAPH_FINGERPRINT,
    },
    ...(overrides.lease || {}),
  };
  const verified = {
    ok: true,
    lease_ref: PROJECT_LEASE_REF,
    subject: 'project_transition',
    run_id: PROJECT_RUN_ID,
    project_ref: PROJECT_REF,
    transition_id: TRANSITION_ID,
    repository: REPO,
    authority: { kind: 'github', repository: REPO, revision: '1111111111111111111111111111111111111111', derivation: 'test' },
    graph_fingerprint: GRAPH_FINGERPRINT,
    transition_definition_fingerprint: TRANSITION_FINGERPRINT,
    ...(overrides.verified || {}),
  };
  const store = {
    async getLeaseById(id) { return id === PROJECT_LEASE_REF ? lease : null; },
    async getLeaseByTokenHash() { return null; },
    async getSlot() { throw new Error('graph-native authority must not read a legacy work slot'); },
    async getRun() { throw new Error('graph-native authority must let the project-transition validator confirm its owning run'); },
  };
  const projectTransitions = {
    async require() {
      if (overrides.projectTransitionError) throw overrides.projectTransitionError;
      return verified;
    },
  };
  return createExecutionAuthorityService({ store, projectTransitions, now: () => overrides.now || NOW });
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

function projectTransitionError(code) {
  return Object.assign(new Error(code), { code });
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

  results.push(await run('graph-native project transition authority derives repository from the verified lease subject', async () => {
    const service = projectTransitionFixture();
    const result = await service.require({ lease_ref: PROJECT_LEASE_REF });
    check(result.subject === 'project_transition', 'project transition authority was not discriminated by subject');
    check(result.repository === REPO, 'project transition authority did not derive repository from its verified subject');
    check(result.transition_id === TRANSITION_ID && result.run_id === PROJECT_RUN_ID, 'graph-native subject identity was incomplete');
    check(!('gate' in result), 'graph-native authority exposed a legacy lane gate');
    check(!('work_ref' in result), 'graph-native authority exposed a legacy Linear work identity');
  }));

  results.push(await run('expired graph-native authority fails closed', async () => {
    const service = projectTransitionFixture({ lease: { expires_at: '2026-08-26T15:59:59.000Z' } });
    await expectCode(service.require({ lease_ref: PROJECT_LEASE_REF, repository: REPO }), 'EXECUTION_AUTHORITY_STALE');
  }));

  results.push(await run('malformed graph-native subject identity fails closed', async () => {
    const service = projectTransitionFixture({ subject: { transition_id: '' } });
    await expectCode(service.require({ lease_ref: PROJECT_LEASE_REF, repository: REPO }), 'EXECUTION_AUTHORITY_INVALID');
  }));

  results.push(await run('non-owning graph-native authority fails closed', async () => {
    const service = projectTransitionFixture({ projectTransitionError: projectTransitionError('PROJECT_TRANSITION_LEASE_STALE') });
    await expectCode(service.require({ lease_ref: PROJECT_LEASE_REF, repository: REPO }), 'EXECUTION_AUTHORITY_STALE');
  }));

  results.push(await run('wrong project-transition run evidence fails closed', async () => {
    const service = projectTransitionFixture({ verified: { run_id: 'different-run' } });
    await expectCode(service.require({ lease_ref: PROJECT_LEASE_REF, repository: REPO }), 'EXECUTION_AUTHORITY_INVALID');
  }));

  results.push(await run('wrong project-transition identity evidence fails closed', async () => {
    const service = projectTransitionFixture({ verified: { transition_id: 'different-transition' } });
    await expectCode(service.require({ lease_ref: PROJECT_LEASE_REF, repository: REPO }), 'EXECUTION_AUTHORITY_INVALID');
  }));

  results.push(await run('wrong project-transition repository request fails closed', async () => {
    const service = projectTransitionFixture();
    await expectCode(service.require({ lease_ref: PROJECT_LEASE_REF, repository: 'laurajoyhutchins/other' }), 'EXECUTION_AUTHORITY_SCOPE_MISMATCH');
  }));

  results.push(await run('wrong project-transition repository evidence fails closed', async () => {
    const service = projectTransitionFixture({ verified: { repository: 'laurajoyhutchins/other' } });
    await expectCode(service.require({ lease_ref: PROJECT_LEASE_REF, repository: REPO }), 'EXECUTION_AUTHORITY_INVALID');
  }));

  results.push(await run('production Postgres factory preserves project-transition validator injection', async () => {
    const subject = { project_ref:PROJECT_REF, transition_id:TRANSITION_ID, repository:REPO, authority_revision:'1'.repeat(40), authority_derivation:'test', graph_fingerprint:GRAPH_FINGERPRINT, transition_definition_fingerprint:TRANSITION_FINGERPRINT };
    const lease = { lease_id:PROJECT_LEASE_REF, work_ref:`project_transition:${PROJECT_REF}:${TRANSITION_ID}`, gate:PROJECT_SLOT_SCOPE, run_id:PROJECT_RUN_ID, status:'active', expires_at:'2026-08-26T16:30:00.000Z', hard_expires_at:'2026-08-26T18:00:00.000Z', claim_receipt:{ subject:'project_transition', project_transition:subject } };
    const store = { async getLeaseById(id){return id===PROJECT_LEASE_REF?lease:null;}, async getLeaseByTokenHash(){return null;} };
    let validations=0;
    const service=createPostgresExecutionAuthorityService({ store, projectTransitions:{async require(){validations+=1;return{ok:true,lease_ref:PROJECT_LEASE_REF,subject:'project_transition',run_id:PROJECT_RUN_ID,project_ref:PROJECT_REF,transition_id:TRANSITION_ID,repository:REPO,authority:{kind:'github',repository:REPO,revision:'1'.repeat(40),derivation:'test'},graph_fingerprint:GRAPH_FINGERPRINT,transition_definition_fingerprint:TRANSITION_FINGERPRINT};}}, authoritative:{async getIssue(){throw new Error('graph-native factory must not read Linear');}}, now:()=>NOW });
    const result=await service.require({lease_ref:PROJECT_LEASE_REF,repository:REPO});
    check(result.subject==='project_transition'&&validations===1,'production factory dropped project-transition validator');
  }));

  const failed = results.filter(result => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results };
}