import {
  buildLinearWorkDescription,
  createPortfolioReconcileService,
  createLinearPortfolioAuthority,
  normalizePortfolioReconcileRequest,
} from 'lib/portfolio-reconcile-work-surface.js';

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function check(condition, message) { if (!condition) throw new Error(message); }
async function run(name, fn) {
  try { await fn(); return { name, ok: true }; }
  catch (error) { return { name, ok: false, error: String(error?.message || error) }; }
}

function baseRequest(overrides = {}) {
  const item = {
    source: {
      kind: 'github_issue',
      repo: 'laurajoyhutchins/test-repo',
      issue_number: 7,
      expected_revision: '2026-08-16T20:00:00Z',
    },
    projection: {
      title: 'Implement bounded source normalization',
      state: 'Todo',
      lane: 'lane:repo-implementation',
      priority: 2,
      outcome: 'Normalize the selected source into the existing repository contract.',
      next_action: 'Implement the bounded repository change and produce verification-ready evidence.',
      actor: 'worker',
      changes_authority_or_produces_evidence: true,
      disposition: 'KEEP_EXECUTABLE',
      authoritative_complete: false,
      objective: 'Normalize the selected source into the existing repository contract.',
      gate: 'Produce one bounded repository candidate suitable for independent verification.',
      acceptance: ['Source identity is preserved', 'Existing behavior remains unchanged'],
      repository: 'laurajoyhutchins/test-repo',
      exact_coordinate: null,
      owner_impact: 'none',
      dependencies: [],
    },
  };
  return {
    project: 'Portfolio Orchestration',
    items: [item],
    idempotency_key: 'test-idem-1',
    ...overrides,
  };
}

class FakeGithub {
  constructor() {
    this.repo = { full_name: 'laurajoyhutchins/test-repo', archived: false };
    this.issue = {
      number: 7,
      state: 'open',
      title: 'GitHub authority title',
      updated_at: '2026-08-16T20:00:00Z',
      body: 'SECRET_GITHUB_PROSE_DO_NOT_COPY',
    };
    this.error = null;
  }
  async getRepository(repo) {
    if (this.error) throw this.error;
    if (repo.toLowerCase() !== this.repo.full_name.toLowerCase()) return null;
    return clone(this.repo);
  }
  async getIssue(repo, number) {
    if (this.error) throw this.error;
    if (repo.toLowerCase() !== this.repo.full_name.toLowerCase() || number !== this.issue.number) return null;
    return clone(this.issue);
  }
}

class FakeIdentityStore {
  constructor() { this.rows = new Map(); this.writes = 0; }
  async get(sourceKey) { return clone(this.rows.get(sourceKey) || null); }
  async put(row) { this.writes += 1; this.rows.set(row.source_key, clone(row)); return clone(row); }
}

class FakeReceiptStore {
  constructor() { this.rows = new Map(); this.writes = 0; }
  async claim(key, hash) {
    const row = this.rows.get(key);
    if (!row) {
      const progress = { version: 'portfolio-reconcile-progress-v1', may_have_mutated: false, items: [] };
      this.rows.set(key, { hash, state: 'processing', receipt: null, progress });
      return { kind: 'claimed', progress: clone(progress) };
    }
    if (row.hash !== hash) return { kind: 'conflict' };
    if (row.state === 'succeeded') return { kind: 'existing', receipt: clone(row.receipt) };
    if (row.state === 'indeterminate') {
      row.state = 'processing';
      return { kind: 'recover', progress: clone(row.progress), last_error: clone(row.last_error) };
    }
    return { kind: 'in_progress' };
  }
  async checkpoint(key, hash, phase, progress) {
    const row = this.rows.get(key);
    if (!row || row.hash !== hash || row.state !== 'processing') throw Object.assign(new Error('receipt ownership lost'), { code: 'IDEMPOTENCY_IN_PROGRESS' });
    this.writes += 1;
    row.phase = phase;
    row.progress = clone(progress);
  }
  async markIndeterminate(key, hash, progress, error) {
    const row = this.rows.get(key);
    if (!row || row.hash !== hash) return;
    this.writes += 1;
    row.state = 'indeterminate';
    row.progress = clone(progress);
    row.last_error = clone(error);
  }
  async succeed(key, hash, receipt, progress = null) {
    this.writes += 1;
    this.rows.set(key, { hash, state: 'succeeded', receipt: clone(receipt), progress: clone(progress) });
  }
  async abandon(key, hash) {
    const row = this.rows.get(key);
    if (row?.hash === hash && row.state === 'processing' && !row.progress?.may_have_mutated) this.rows.delete(key);
  }
}

class FakeLeaseStore {
  constructor() { this.active = new Map(); }
  async getActive(workRef, now) {
    const lease = this.active.get(workRef) || null;
    if (!lease || Date.parse(lease.expires_at) <= Date.parse(now)) return null;
    return clone(lease);
  }
}

class FakeLinear {
  constructor() {
    this.counter = 100;
    this.revision = 0;
    this.issues = new Map();
    this.relationWrites = 0;
    this.permissionError = null;
    this.concurrentEdit = false;
    this.createCalls = 0;
    this.updateCalls = 0;
    this.loseCreateResponseOnCall = null;
    this.loseUpdateResponseOnCall = null;
    this.loseDependencyResponseOnCall = null;
    this.project = {
      id: 'project-1', name: 'Portfolio Orchestration', team_id: 'team-1',
      states: [
        { id: 'state-backlog', name: 'Backlog', type: 'backlog' },
        { id: 'state-todo', name: 'Todo', type: 'unstarted' },
        { id: 'state-progress', name: 'In Progress', type: 'started' },
        { id: 'state-done', name: 'Done', type: 'completed' },
        { id: 'state-canceled', name: 'Canceled', type: 'canceled' },
        { id: 'state-duplicate', name: 'Duplicate', type: 'canceled' },
      ],
      labels: [
        { id: 'lane-repo', name: 'lane:repo-implementation' },
        { id: 'lane-source', name: 'lane:source-implementation' },
        { id: 'lane-verification', name: 'lane:verification' },
        { id: 'lane-integration', name: 'lane:integration' },
      ],
    };
  }
  rev() { this.revision += 1; return `2026-08-16T20:00:${String(this.revision).padStart(2, '0')}Z`; }
  async resolveProject(name) {
    if (this.permissionError) throw this.permissionError;
    return name === this.project.name ? clone(this.project) : null;
  }
  addIssue(overrides = {}) {
    const identifier = overrides.identifier || `LJH-${this.counter++}`;
    const issue = {
      id: overrides.id || `id-${identifier}`,
      identifier,
      title: overrides.title || 'Existing item',
      description: overrides.description || '',
      priority: overrides.priority ?? 2,
      updatedAt: overrides.updatedAt || this.rev(),
      archivedAt: overrides.archivedAt ?? null,
      project: clone(overrides.project || { id: this.project.id, name: this.project.name }),
      state: clone(overrides.state || { id: 'state-todo', name: 'Todo', type: 'unstarted' }),
      labels: clone(overrides.labels || [{ id: 'lane-repo', name: 'lane:repo-implementation' }]),
      dependencies: clone(overrides.dependencies || []),
    };
    this.issues.set(identifier, issue);
    return clone(issue);
  }
  async findBySource(repo, number) {
    if (this.permissionError) throw this.permissionError;
    const repoLine = `Repository: ${repo}`.toLowerCase();
    const authorityLine = `Authority: GitHub #${number}`.toLowerCase();
    return [...this.issues.values()].filter(issue => {
      const text = String(issue.description || '').replace(/\*\*/g, '').toLowerCase();
      return issue.project?.name === this.project.name && text.includes(repoLine) && text.includes(authorityLine);
    }).map(clone);
  }
  async getIssue(ref) {
    if (this.permissionError) throw this.permissionError;
    const issue = [...this.issues.values()].find(x => x.identifier === ref || x.id === ref) || null;
    if (!issue) return null;
    if (this.concurrentEdit) {
      this.concurrentEdit = false;
      issue.title = `${issue.title} human edit`;
      issue.updatedAt = this.rev();
    }
    return clone(issue);
  }
  async countActiveProjectIssues(projectId) {
    return [...this.issues.values()].filter(issue => issue.project?.id === projectId && !issue.archivedAt && !['completed','canceled','duplicate'].includes(String(issue.state?.type || '').toLowerCase())).length;
  }
  async createIssue(input) {
    if (this.permissionError) throw this.permissionError;
    this.createCalls += 1;
    const state = this.project.states.find(x => x.id === input.stateId);
    const labels = this.project.labels.filter(x => (input.labelIds || []).includes(x.id));
    const created = this.addIssue({ title: input.title, description: input.description, priority: input.priority, state, labels });
    if (this.loseCreateResponseOnCall === this.createCalls) throw new Error('create response lost after durable mutation');
    return created;
  }
  async updateIssue({ identifier, expectedRevision, input }) {
    if (this.permissionError) throw this.permissionError;
    this.updateCalls += 1;
    const issue = this.issues.get(identifier);
    if (!issue) throw Object.assign(new Error('not found'), { code: 'LINEAR_NOT_FOUND' });
    if (issue.updatedAt !== expectedRevision) throw Object.assign(new Error('revision changed'), { code: 'LINEAR_REVISION_MISMATCH', details: { actual_revision: issue.updatedAt } });
    if (input.title !== undefined) issue.title = input.title;
    if (input.description !== undefined) issue.description = input.description;
    if (input.priority !== undefined) issue.priority = input.priority;
    if (input.projectId !== undefined) issue.project = { id: this.project.id, name: this.project.name };
    if (input.stateId !== undefined) issue.state = clone(this.project.states.find(x => x.id === input.stateId));
    if (input.labelIds !== undefined) issue.labels = clone(this.project.labels.filter(x => input.labelIds.includes(x.id)));
    issue.updatedAt = this.rev();
    const result = clone(issue);
    if (this.loseUpdateResponseOnCall === this.updateCalls) throw new Error('update response lost after durable mutation');
    return result;
  }
  async ensureDependencyRelation(issueRef, dependencyRef) {
    const issue = this.issues.get(issueRef);
    const dependency = await this.getIssue(dependencyRef);
    if (!issue || !dependency) throw Object.assign(new Error('dependency missing'), { code: 'DEPENDENCY_NOT_FOUND' });
    if (!issue.dependencies.includes(dependency.identifier)) {
      issue.dependencies.push(dependency.identifier);
      issue.updatedAt = this.rev();
      this.relationWrites += 1;
      if (this.loseDependencyResponseOnCall === this.relationWrites) throw new Error('dependency response lost after durable mutation');
    }
    return clone(issue);
  }
}

function harness() {
  const github = new FakeGithub();
  const linear = new FakeLinear();
  const identity = new FakeIdentityStore();
  const receipts = new FakeReceiptStore();
  const leases = new FakeLeaseStore();
  const lifecycle = {
    row: { repository:'laurajoyhutchins/test-repo', disposition:'ACTIVE', ordinary_work_enabled:true, successor_repository:null, compatibility_bound:false },
    async observe(repository) { return { ...this.row, repository }; },
  };
  const service = createPortfolioReconcileService({
    github, linear, identityStore: identity, receiptStore: receipts, leaseStore: leases, repositoryLifecycle: lifecycle,
    now: () => '2026-08-16T20:30:00Z',
  });
  return { github, linear, identity, receipts, leases, lifecycle, service };
}

async function reconcile(h, request = baseRequest()) { return h.service.reconcile(request); }
function sourceKey() { return 'github:laurajoyhutchins/test-repo#issue:7'; }
function existingDescription(projection = baseRequest().items[0].projection) {
  return buildLinearWorkDescription({ repo: 'laurajoyhutchins/test-repo', issueNumber: 7, projection });
}

export async function runPortfolioReconcileWorkSurfaceTests() {
  const results = [];

  results.push(await run('01 new GitHub issue creates one Linear issue', async () => {
    const h = harness(); const r = await reconcile(h);
    check(r.ok && r.items[0].result === 'created' && h.linear.issues.size === 1, 'new item was not created exactly once');
  }));

  results.push(await run('02 exact semantic replay reuses canonical item without duplicate', async () => {
    const h = harness(); await reconcile(h); const r = await reconcile(h, { ...baseRequest(), idempotency_key: 'test-idem-2' });
    check(r.items[0].result === 'reused' && h.linear.issues.size === 1, 'semantic replay duplicated work');
  }));

  results.push(await run('03 Repository + Authority markers bootstrap missing durable identity', async () => {
    const projection = baseRequest().items[0].projection;
    const h = harness(); const issue = h.linear.addIssue({ title: projection.title, description: existingDescription() }); const r = await reconcile(h);
    check(r.items[0].linear_issue === issue.identifier && r.items[0].result === 'reused', 'legacy exact identity was not reused');
  }));

  results.push(await run('04 existing issue discovery adopts identity map', async () => {
    const h = harness(); h.linear.addIssue({ description: existingDescription() }); await reconcile(h);
    check(h.identity.rows.has(sourceKey()), 'identity map was not adopted');
  }));

  results.push(await run('05 exact existing projection is reused without description churn', async () => {
    const h = harness(); const issue = h.linear.addIssue({ title: baseRequest().items[0].projection.title, description: existingDescription() }); const before = issue.updatedAt; const r = await reconcile(h);
    const after = await h.linear.getIssue(issue.identifier);
    check(r.items[0].result === 'reused' && after.updatedAt === before, 'exact projection churned Linear');
  }));

  results.push(await run('06 explicit title update changes only title', async () => {
    const h = harness(); h.linear.addIssue({ title: 'Old title', description: existingDescription() }); const r = await reconcile(h);
    check(r.items[0].result === 'updated' && JSON.stringify(r.items[0].changed_fields) === JSON.stringify(['title']), 'title-only update was not bounded');
  }));

  results.push(await run('07 explicit priority update changes only priority', async () => {
    const h = harness(); h.linear.addIssue({ title: baseRequest().items[0].projection.title, priority: 4, description: existingDescription() }); const r = await reconcile(h);
    check(r.items[0].changed_fields.length === 1 && r.items[0].changed_fields[0] === 'priority', 'priority-only update was not bounded');
  }));

  results.push(await run('08 explicit outcome update materially changes the minimal packet', async () => {
    const h = harness(); const old = baseRequest().items[0].projection; h.linear.addIssue({ title: old.title, description: existingDescription({ ...old, outcome: 'Old outcome' }) }); const r = await reconcile(h);
    check(r.items[0].result === 'updated' && r.items[0].changed_fields.includes('outcome'), 'outcome update was not detected');
  }));

  results.push(await run('09 formatting-only difference does not churn description', async () => {
    const h = harness(); const p = baseRequest().items[0].projection; const description = existingDescription(p).replace('Outcome: Normalize', 'Outcome:   Normalize'); const issue = h.linear.addIssue({ title: p.title, description }); const before = issue.updatedAt; const r = await reconcile(h); const after = await h.linear.getIssue(issue.identifier);
    check(r.items[0].result === 'reused' && after.updatedAt === before, 'formatting-only difference caused churn');
  }));

  results.push(await run('10 stale GitHub expected_revision is rejected', async () => {
    const h = harness(); const req = baseRequest(); req.items[0].source.expected_revision = '2026-08-15T00:00:00Z'; const r = await reconcile(h, req);
    check(r.items[0].result === 'rejected' && r.items[0].reason === 'SOURCE_REVISION_MISMATCH' && h.linear.issues.size === 0, 'stale source revision mutated Linear');
  }));

  results.push(await run('11 closed GitHub issue on new admission is rejected', async () => {
    const h = harness(); h.github.issue.state = 'closed'; const r = await reconcile(h);
    check(r.items[0].reason === 'SOURCE_NOT_OPEN' && h.linear.issues.size === 0, 'closed source was admitted');
  }));

  results.push(await run('12 closed GitHub issue evicts active Linear work to Done', async () => {
    const h = harness(); h.github.issue.state = 'closed'; const issue = h.linear.addIssue({ title: baseRequest().items[0].projection.title, description: existingDescription() }); const r = await reconcile(h); const settled = await h.linear.getIssue(issue.identifier);
    check(r.items[0].reason === 'SOURCE_CLOSED' && settled.state.name === 'Done', 'closed source did not evict active Linear work');
  }));

  results.push(await run('13 archived repository is not admitted', async () => {
    const h = harness(); h.github.repo.archived = true; const r = await reconcile(h);
    check(r.items[0].reason === 'DISPOSED_REPOSITORY' && h.linear.issues.size === 0, 'archived repository admitted work');
  }));

  results.push(await run('13b canonical SUPERSEDED disposition blocks projection and returns successor', async () => {
    const h = harness();
    h.lifecycle.row = { repository:'laurajoyhutchins/test-repo', disposition:'SUPERSEDED', ordinary_work_enabled:false, successor_repository:'laurajoyhutchins/new-repo', compatibility_bound:false };
    const r = await reconcile(h, { ...baseRequest(), idempotency_key:'superseded-reconcile' });
    check(r.items[0].reason === 'SUPERSEDED' && r.items[0].successor_repository === 'laurajoyhutchins/new-repo' && h.linear.issues.size === 0, 'superseded repository projected active work or lost successor routing');
  }));

  results.push(await run('14 GitHub issue not found is rejected', async () => {
    const h = harness(); h.github.issue.number = 8; const r = await reconcile(h);
    check(r.items[0].reason === 'SOURCE_NOT_FOUND', 'missing issue was not rejected deterministically');
  }));

  results.push(await run('15 GitHub App not installed is stable rejection', async () => {
    const h = harness(); h.github.error = Object.assign(new Error('not installed'), { code: 'GITHUB_APP_INSTALLATION_NOT_FOUND' }); const r = await reconcile(h);
    check(r.items[0].reason === 'GITHUB_APP_INSTALLATION_NOT_FOUND', 'GitHub App installation failure was not normalized');
  }));

  results.push(await run('16 GitHub permission failure is request-level failure', async () => {
    const h = harness(); h.github.error = Object.assign(new Error('denied'), { code: 'GITHUB_PERMISSION_DENIED' }); const r = await reconcile(h);
    check(!r.ok && r.error === 'GITHUB_PERMISSION_DENIED', 'GitHub permission failure should stop trustworthy reconciliation');
  }));

  results.push(await run('17 Linear permission failure is request-level failure', async () => {
    const h = harness(); h.linear.permissionError = Object.assign(new Error('denied'), { code: 'LINEAR_PERMISSION_DENIED' }); const r = await reconcile(h);
    check(!r.ok && r.error === 'LINEAR_PERMISSION_DENIED', 'Linear credential failure should stop trustworthy reconciliation');
  }));

  results.push(await run('18 duplicate Linear representations return IDENTITY_CONFLICT', async () => {
    const h = harness(); h.linear.addIssue({ description: existingDescription() }); h.linear.addIssue({ description: existingDescription() }); const r = await reconcile(h);
    check(r.items[0].reason === 'IDENTITY_CONFLICT' && r.items[0].conflicts.length === 2, 'identity conflict was guessed through');
  }));

  results.push(await run('19 active work lease prevents unsafe update', async () => {
    const h = harness(); const issue = h.linear.addIssue({ title: 'Old title', description: existingDescription() }); h.leases.active.set(issue.identifier, { expires_at: '2026-08-16T21:00:00Z', lease_id: 'lease-1' }); const r = await reconcile(h);
    check(r.items[0].reason === 'ACTIVE_WORK_LEASE' && r.items[0].lease_expires_at && !('lease_token' in r.items[0]), 'active lease was not protected');
  }));

  results.push(await run('20 expired lease is not an ownership blocker', async () => {
    const h = harness(); const issue = h.linear.addIssue({ title: 'Old title', description: existingDescription() }); h.leases.active.set(issue.identifier, { expires_at: '2026-08-16T20:00:00Z', lease_id: 'lease-1' }); const r = await reconcile(h);
    check(r.items[0].result === 'updated', 'expired lease incorrectly blocked update');
  }));

  results.push(await run('21 In Progress without active lease is not treated as owned', async () => {
    const h = harness(); const progress = h.linear.project.states.find(x => x.name === 'In Progress'); h.linear.addIssue({ title: baseRequest().items[0].projection.title, description: existingDescription(), state: progress }); const r = await reconcile(h);
    check(r.items[0].result === 'updated' && r.items[0].reason === 'PROJECTION_UPDATED', 'stale unleased In Progress state was treated as active ownership');
  }));

  results.push(await run('22 invalid lane is rejected', async () => {
    const h = harness(); const req = baseRequest(); req.items[0].projection.lane = 'lane:dispatch'; const r = await reconcile(h, req);
    check(r.items[0].reason === 'INVALID_LANE', 'invalid lane was accepted');
  }));

  results.push(await run('23 invalid state is rejected', async () => {
    const h = harness(); const req = baseRequest(); req.items[0].projection.state = 'Done'; const r = await reconcile(h, req);
    check(r.items[0].reason === 'INVALID_STATE', 'invalid state was accepted');
  }));

  results.push(await run('24 new item cannot enter In Progress', async () => {
    const h = harness(); const req = baseRequest(); req.items[0].projection.state = 'In Progress'; const r = await reconcile(h, req);
    check(r.items[0].reason === 'INVALID_STATE' && h.linear.issues.size === 0, 'new work entered In Progress');
  }));

  results.push(await run('25 unresolved dependency rejects without placeholder', async () => {
    const h = harness(); const req = baseRequest(); req.items[0].projection.dependencies = [{ kind: 'linear_issue', ref: 'LJH-9999' }]; const r = await reconcile(h, req);
    check(r.items[0].reason === 'DEPENDENCY_NOT_FOUND' && h.linear.issues.size === 0, 'unresolved dependency created work');
  }));

  results.push(await run('26 existing dependency is reused idempotently', async () => {
    const h = harness(); const dep = h.linear.addIssue({ identifier: 'LJH-50' }); const req = baseRequest(); req.items[0].projection.dependencies = [{ kind: 'linear_issue', ref: dep.identifier }]; await reconcile(h, req); const r = await reconcile(h, { ...req, idempotency_key: 'dep-replay' });
    check(r.items[0].result === 'reused' && h.linear.relationWrites === 1, 'dependency relation was duplicated');
  }));

  results.push(await run('27 duplicate dependency declarations do not duplicate relation', async () => {
    const h = harness(); const dep = h.linear.addIssue({ identifier: 'LJH-50' }); const req = baseRequest(); req.items[0].projection.dependencies = [{ kind: 'linear_issue', ref: dep.identifier }, { kind: 'linear_issue', ref: dep.identifier }]; const r = await reconcile(h, req);
    check(r.items[0].result === 'created' && h.linear.relationWrites === 1, 'duplicate dependency produced duplicate relation');
  }));

  results.push(await run('28 Linear concurrent edit returns optimistic conflict', async () => {
    const h = harness(); h.linear.addIssue({ title: 'Old title', description: existingDescription() }); h.linear.concurrentEdit = true; const r = await reconcile(h);
    check(r.items[0].reason === 'LINEAR_REVISION_MISMATCH', 'concurrent Linear edit was overwritten');
  }));

  results.push(await run('29 idempotency replay returns stored receipt', async () => {
    const h = harness(); const first = await reconcile(h); const second = await reconcile(h);
    check(first.items[0].linear_issue === second.items[0].linear_issue && second.idempotent_replay === true && h.linear.issues.size === 1, 'idempotency replay did not return stored receipt');
  }));

  results.push(await run('30 idempotency key semantic conflict is request-level conflict', async () => {
    const h = harness(); await reconcile(h); const req = baseRequest(); req.items[0].projection.title = 'Different semantic request'; const r = await reconcile(h, req);
    check(!r.ok && r.error === 'IDEMPOTENCY_CONFLICT', 'same key accepted a different semantic request');
  }));

  results.push(await run('31 mixed batch returns create + reuse + reject independently', async () => {
    const h = harness(); const p = baseRequest().items[0].projection; h.linear.addIssue({ title: p.title, description: buildLinearWorkDescription({ repo: 'laurajoyhutchins/test-repo', issueNumber: 8, projection: { ...p, repository: 'laurajoyhutchins/test-repo' } }) });
    const req = baseRequest({ idempotency_key: 'batch-1' }); req.items = [clone(req.items[0]), clone(req.items[0]), clone(req.items[0])];
    req.items[1].source.issue_number = 8; req.items[1].source.expected_revision = '2026-08-16T20:00:00Z';
    req.items[2].source.issue_number = 9; req.items[2].source.expected_revision = '2026-08-16T20:00:00Z';
    const originalGet = h.github.getIssue.bind(h.github); h.github.getIssue = async (repo, n) => n === 8 ? { ...clone(h.github.issue), number: 8 } : originalGet(repo, n);
    const r = await reconcile(h, req); const kinds = r.items.map(x => x.result);
    check(kinds.includes('created') && kinds.includes('reused') && kinds.includes('rejected'), 'mixed batch outcomes were not isolated');
  }));

  results.push(await run('32 later batch rejection does not corrupt prior success', async () => {
    const h = harness(); const req = baseRequest({ idempotency_key: 'batch-2' }); req.items = [clone(req.items[0]), clone(req.items[0])]; req.items[1].source.issue_number = 999; const r = await reconcile(h, req);
    check(r.items[0].result === 'created' && r.items[1].result === 'rejected' && h.linear.issues.size === 1, 'later failure corrupted earlier item');
  }));

  results.push(await run('33 dry-run creates no Linear issue', async () => {
    const h = harness(); const r = await reconcile(h, { ...baseRequest(), dry_run: true });
    check(r.items[0].result === 'would_create' && h.linear.issues.size === 0, 'dry-run mutated Linear');
  }));

  results.push(await run('34 dry-run creates no identity row or receipt', async () => {
    const h = harness(); await reconcile(h, { ...baseRequest(), dry_run: true });
    check(h.identity.writes === 0 && h.receipts.writes === 0 && h.identity.rows.size === 0, 'dry-run persisted connector state');
  }));

  results.push(await run('35 unknown input fields are rejected', async () => {
    let rejected = false; try { normalizePortfolioReconcileRequest({ ...baseRequest(), surprise: true }); } catch (error) { rejected = error.code === 'INVALID_REQUEST'; }
    check(rejected, 'unknown top-level input field was accepted');
  }));

  results.push(await run('36 GitHub issue body is not persisted in Hatchable identity state', async () => {
    const h = harness(); await reconcile(h); const persisted = JSON.stringify([...h.identity.rows.values()]);
    check(!persisted.includes('SECRET_GITHUB_PROSE_DO_NOT_COPY'), 'GitHub issue body leaked into identity state');
  }));

  results.push(await run('37 GitHub issue body is not copied into Linear', async () => {
    const h = harness(); await reconcile(h); const issue = [...h.linear.issues.values()][0];
    check(!issue.description.includes('SECRET_GITHUB_PROSE_DO_NOT_COPY'), 'GitHub prose was copied into Linear');
  }));

  results.push(await run('38 secrets are not logged', async () => {
    const h = harness(); const captured = []; const original = console.log; console.log = (...args) => captured.push(args.join(' '));
    try { await reconcile(h); } finally { console.log = original; }
    check(!captured.join('\n').includes('SECRET_GITHUB_PROSE_DO_NOT_COPY') && captured.length === 0, 'sensitive content appeared in logs');
  }));

  results.push(await run('39 Backlog requires explicit promotion condition', async () => {
    const h = harness(); const req = baseRequest(); req.items[0].projection.state = 'Backlog'; const r = await reconcile(h, req);
    check(r.items[0].reason === 'INVALID_STATE', 'caller was allowed to force executable work into Backlog');
  }));

  results.push(await run('40 new work cannot start directly in downstream verification lane', async () => {
    const h = harness(); const req = baseRequest(); req.items[0].projection.lane = 'lane:verification'; const r = await reconcile(h, req);
    check(r.items[0].reason === 'PHASE_TICKET_NOT_ADMITTED', 'new demand entered downstream lane');
  }));

  results.push(await run('41 proven pre-effect failure abandons receipt and retries normally', async () => {
    const h = harness();
    h.linear.permissionError = Object.assign(new Error('denied before project resolution'), { code: 'LINEAR_PERMISSION_DENIED' });
    const first = await reconcile(h);
    check(first.ok === false && h.receipts.rows.size === 0, 'pre-effect failure retained a receipt as if mutation were possible');
    h.linear.permissionError = null;
    const retry = await reconcile(h);
    check(retry.ok === true && h.linear.issues.size === 1, 'same request could not retry after proven pre-effect failure');
  }));

  results.push(await run('42 Linear create succeeds, response is lost, replay discovers exact work without duplicate', async () => {
    const h = harness();
    h.linear.loseCreateResponseOnCall = 1;
    const first = await reconcile(h);
    check(first.ok === false && first.error === 'PORTFOLIO_RECONCILE_INDETERMINATE' && first.may_have_mutated === true, 'lost create response was not indeterminate');
    check(h.linear.issues.size === 1 && h.receipts.rows.get('test-idem-1')?.state === 'indeterminate', 'created work or recovery marker missing');
    h.linear.loseCreateResponseOnCall = null;
    const retry = await reconcile(h);
    check(retry.ok === true && retry.recovered_indeterminate === true, 'indeterminate create did not recover');
    check(h.linear.issues.size === 1 && h.linear.createCalls === 1, 'replay duplicated the created Linear issue');
    check(retry.items[0].recovery_outcome === 'effect_confirmed', 'recovery did not classify the prior effect as confirmed');
  }));

  results.push(await run('43 completed item progress survives when a later item becomes indeterminate', async () => {
    const h = harness();
    const req = baseRequest({ idempotency_key: 'partial-batch' });
    req.items = [clone(req.items[0]), clone(req.items[0])];
    req.items[1].source.issue_number = 8;
    const originalGet = h.github.getIssue.bind(h.github);
    h.github.getIssue = async (repo, number) => number === 8 ? { ...clone(h.github.issue), number: 8 } : originalGet(repo, number);
    h.linear.loseCreateResponseOnCall = 2;
    const first = await reconcile(h, req);
    check(first.error === 'PORTFOLIO_RECONCILE_INDETERMINATE' && h.linear.issues.size === 2, 'later ambiguous item was not retained');
    const progress = h.receipts.rows.get('partial-batch')?.progress;
    check(progress?.items?.find(item => item.index === 0)?.state === 'completed', 'item 1 completion progress was not durable');
    h.linear.loseCreateResponseOnCall = null;
    const retry = await reconcile(h, req);
    check(retry.ok === true && h.linear.issues.size === 2, 'partial replay duplicated work');
    check(h.linear.createCalls === 2, 'completed item or uncertain item was blindly recreated');
    check(retry.items[0].recovery_outcome === 'effect_confirmed', 'completed item was not reused from durable progress');
  }));

  results.push(await run('44 Linear update succeeds, response is lost, replay reconciles current projection', async () => {
    const h = harness();
    h.linear.addIssue({ title: 'Old title', description: existingDescription() });
    h.linear.loseUpdateResponseOnCall = 1;
    const first = await reconcile(h);
    check(first.error === 'PORTFOLIO_RECONCILE_INDETERMINATE', 'lost update response was not indeterminate');
    h.linear.loseUpdateResponseOnCall = null;
    const retry = await reconcile(h);
    check(retry.ok === true && h.linear.updateCalls === 1, 'retry duplicated Linear update');
    check(retry.items[0].recovery_outcome === 'effect_confirmed', 'updated projection was not confirmed on replay');
  }));

  results.push(await run('45 dependency relation succeeds, later response is lost, replay does not duplicate relation', async () => {
    const h = harness();
    const dependency = h.linear.addIssue({ identifier: 'LJH-50' });
    const req = baseRequest({ idempotency_key: 'dependency-loss' });
    req.items[0].projection.dependencies = [{ kind: 'linear_issue', ref: dependency.identifier }];
    h.linear.loseDependencyResponseOnCall = 1;
    const first = await reconcile(h, req);
    check(first.error === 'PORTFOLIO_RECONCILE_INDETERMINATE' && h.linear.relationWrites === 1, 'dependency response loss was not retained');
    h.linear.loseDependencyResponseOnCall = null;
    const retry = await reconcile(h, req);
    check(retry.ok === true && h.linear.relationWrites === 1, 'replay duplicated dependency relation');
    check(h.linear.issues.size === 2, 'dependency recovery created an inconsistent duplicate work item');
  }));

  results.push(await run('46 material source authority change during recovery fails closed with structured conflict', async () => {
    const h = harness();
    h.linear.loseCreateResponseOnCall = 1;
    const first = await reconcile(h);
    check(first.error === 'PORTFOLIO_RECONCILE_INDETERMINATE', 'fixture did not enter indeterminate recovery');
    h.linear.loseCreateResponseOnCall = null;
    h.github.issue.updated_at = '2026-08-17T22:00:00Z';
    const retry = await reconcile(h);
    check(retry.ok === false && retry.error === 'PORTFOLIO_RECONCILE_RECOVERY_CONFLICT', `material authority change did not fail closed: ${retry.error}`);
    check(retry.reason === 'SOURCE_REVISION_MISMATCH' && retry.source_key, 'structured mismatch evidence missing');
    check(h.receipts.rows.get('test-idem-1')?.state === 'indeterminate', 'material conflict discarded recovery marker');
  }));

  results.push(await run('47 reconciliation request accepts a non-legacy campaign project', async () => {
    const normalized = normalizePortfolioReconcileRequest(baseRequest({ project: 'STE-Lint Complete' }));
    check(normalized.project === 'STE-Lint Complete', 'campaign project was not preserved');
  }));

  results.push(await run('48 new admission creates work directly in the selected campaign project', async () => {
    const h = harness();
    h.linear.project = { ...h.linear.project, id: 'project-ste', name: 'STE-Lint Complete' };
    const r = await reconcile(h, baseRequest({ project: 'STE-Lint Complete', idempotency_key: 'campaign-create' }));
    const created = [...h.linear.issues.values()][0];
    check(r.ok === true && r.items[0].result === 'created', 'campaign admission did not create work');
    check(created?.project?.id === 'project-ste' && created?.project?.name === 'STE-Lint Complete', 'created issue did not land in selected campaign project');
  }));

  results.push(await run('49 existing canonical work can move into the selected campaign project without changing identity', async () => {
    const h = harness();
    const existing = h.linear.addIssue({ title: baseRequest().items[0].projection.title, description: existingDescription() });
    h.identity.rows.set(sourceKey(), { source_key: sourceKey(), linear_issue_id: existing.id, linear_identifier: existing.identifier });
    h.linear.project = { ...h.linear.project, id: 'project-ste', name: 'STE-Lint Complete' };
    const r = await reconcile(h, baseRequest({ project: 'STE-Lint Complete', idempotency_key: 'campaign-move' }));
    const moved = await h.linear.getIssue(existing.identifier);
    check(r.ok === true && r.items[0].linear_issue === existing.identifier, 'canonical identity changed during campaign move');
    check(r.items[0].changed_fields.includes('project'), 'campaign move was not represented as a project change');
    check(moved?.project?.id === 'project-ste' && moved?.project?.name === 'STE-Lint Complete', 'existing issue did not move to selected campaign project');
  }));

  results.push(await run('50 source fallback discovery searches the whole team, not only the target project', async () => {
    const calls = [];
    const apiBinding = {
      async call(name, request) {
        check(name === 'linear', 'unexpected API binding');
        const query = String(request?.body?.query || '');
        calls.push(query);
        if (query.includes('query PortfolioProject(')) {
          return { status: 200, body: { data: { projects: { nodes: [{ id: 'project-ste', name: 'STE-Lint Complete' }] } } } };
        }
        if (query.includes('query PortfolioProjectTeam')) {
          return { status: 200, body: { data: { project: { id: 'project-ste', name: 'STE-Lint Complete', teams: { nodes: [{ id: 'team-1', name: 'Ljh-projects' }] } } } } };
        }
        if (query.includes('query PortfolioTeamConfig')) {
          return { status: 200, body: { data: { team: { states: { nodes: [] }, labels: { nodes: [] } } } } };
        }
        if (query.includes('query PortfolioLegacyIdentity')) {
          if (query.includes('filter: { project:')) return { status: 200, body: { data: { issues: { nodes: [] } } } };
          const issue = {
            id: 'issue-old', identifier: 'LJH-OLD', title: 'Existing canonical work',
            description: 'Repository: `laurajoyhutchins/test-repo`\n\nAuthority: GitHub #7',
            priority: 2, updatedAt: 'rev-old', archivedAt: null,
            project: { id: 'project-other', name: 'Other Campaign' },
            state: { id: 'todo', name: 'Todo', type: 'unstarted' },
            labels: { nodes: [{ id: 'lane', name: 'lane:repo-implementation' }] },
          };
          return { status: 200, body: { data: { issues: { nodes: [issue] } } } };
        }
        throw new Error(`unexpected Linear query: ${query}`);
      },
    };
    const authority = createLinearPortfolioAuthority(apiBinding);
    await authority.resolveProject('STE-Lint Complete');
    const matches = await authority.findBySource('laurajoyhutchins/test-repo', 7);
    check(matches.length === 1 && matches[0].identifier === 'LJH-OLD', 'team-wide source fallback did not recover canonical work outside target project');
    check(calls.some(query => query.includes('filter: { team:')), 'fallback query did not use team scope');
  }));

  results.push(await run('51 non-executable candidate is not admitted', async () => {
    const h = harness(); const req = baseRequest({ idempotency_key:'no-action' }); req.items[0].projection.next_action = '';
    const r = await reconcile(h, req);
    check(r.items[0].reason === 'NO_EXECUTABLE_ACTION' && h.linear.issues.size === 0, 'actionless candidate entered Linear');
  }));

  results.push(await run('52 deterministic bookkeeping is not projected as reasoning work', async () => {
    const h = harness(); const req = baseRequest({ idempotency_key:'derived' }); req.items[0].projection.actor = 'deterministic';
    const r = await reconcile(h, req);
    check(r.items[0].reason === 'DERIVED_STATE' && h.linear.issues.size === 0, 'derived state entered Linear');
  }));

  results.push(await run('53 explicit supersession evicts existing work and stale source cannot resurrect it', async () => {
    const h = harness(); const issue = h.linear.addIssue({ title:baseRequest().items[0].projection.title, description:existingDescription() });
    const req = baseRequest({ idempotency_key:'explicit-supersede' }); req.items[0].projection.disposition = 'SUPERSEDED'; req.items[0].projection.actor = 'none'; req.items[0].projection.changes_authority_or_produces_evidence = false;
    const first = await reconcile(h, req); const settled = await h.linear.getIssue(issue.identifier);
    check(first.items[0].reason === 'SUPERSEDED' && settled.state.name === 'Canceled', 'superseded work did not terminalize');
    const stale = baseRequest({ idempotency_key:'stale-resurrection' }); const replay = await reconcile(h, stale);
    check(replay.items[0].reason === 'ALREADY_TERMINAL' && (await h.linear.getIssue(issue.identifier)).state.name === 'Canceled', 'stale source resurrected terminal work');
  }));

  results.push(await run('54 one roadmap source can project distinct bounded units', async () => {
    const h = harness(); const req = baseRequest({ idempotency_key:'unit-batch' }); req.items = [clone(req.items[0]), clone(req.items[0])];
    req.items[0].source.unit_key = 'unit-a'; req.items[1].source.unit_key = 'unit-b'; req.items[1].projection.title = 'Second bounded unit'; req.items[1].projection.outcome = 'Ship second bounded unit';
    const r = await reconcile(h, req);
    check(r.items.every(item => item.result === 'created') && h.linear.issues.size === 2, 'roadmap units collapsed or conflicted incorrectly');
  }));

  results.push(await run('55 bounded frontier limits and replenishes after settlement', async () => {
    const h = harness(); h.linear.project = { ...h.linear.project, id:'project-jurisdiction', name:'U.S. Jurisdiction Coverage' };
    const req = baseRequest({ project:'U.S. Jurisdiction Coverage', idempotency_key:'frontier-fill' }); req.items = [0,1,2,3].map(index => {
      const item = clone(req.items[0]); item.source.unit_key = `unit-${index}`; item.projection.title = `Unit ${index}`; item.projection.outcome = `Ship unit ${index}`; return item;
    });
    const first = await reconcile(h, req);
    check(first.items.filter(item => item.result === 'created').length === 3 && first.items[3].reason === 'FRONTIER_LIMIT_REACHED', 'frontier admitted more than three');
    const done = [...h.linear.issues.values()][0]; done.state = { id:'state-done', name:'Done', type:'completed' }; done.updatedAt = h.linear.rev(); h.linear.issues.set(done.identifier, done);
    const next = clone(req.items[3]); const second = await reconcile(h, { project:'U.S. Jurisdiction Coverage', items:[next], idempotency_key:'frontier-replenish' });
    check(second.items[0].result === 'created' && h.linear.issues.size === 4, 'frontier did not replenish after settlement');
  }));

  results.push(await run('56 historical record can become terminal without deletion', async () => {
    const h = harness(); const issue = h.linear.addIssue({ title:'Incident postmortem', description:existingDescription() });
    const req = baseRequest({ idempotency_key:'historical' }); req.items[0].projection.disposition = 'HISTORICAL_REFERENCE'; req.items[0].projection.actor = 'none'; req.items[0].projection.changes_authority_or_produces_evidence = false; req.items[0].projection.authoritative_complete = true;
    const r = await reconcile(h, req); const preserved = await h.linear.getIssue(issue.identifier);
    check(r.items[0].reason === 'HISTORICAL_REFERENCE' && preserved.state.name === 'Done' && h.linear.issues.has(issue.identifier), 'historical record was not preserved as terminal');
  }));

  results.push(await run('57 canonical key prevents duplicate projection', async () => {
    const h = harness(); const req = baseRequest({ idempotency_key:'canonical-dedupe' }); req.items = [clone(req.items[0]), clone(req.items[0])];
    req.items[0].source.canonical_key = 'same.outcome'; req.items[1].source.canonical_key = 'same.outcome';
    const r = await reconcile(h, req);
    check(r.items[0].result === 'created' && r.items[1].result === 'reused' && h.linear.issues.size === 1, 'canonical duplicate created a second Linear issue');
  }));

  results.push(await run('58 disposed repository evicts an existing active projection', async () => {
    const h = harness(); const issue = h.linear.addIssue({ title:baseRequest().items[0].projection.title, description:existingDescription() }); h.github.repo.archived = true;
    const r = await reconcile(h, baseRequest({ idempotency_key:'disposed-eviction' })); const settled = await h.linear.getIssue(issue.identifier);
    check(r.items[0].reason === 'DISPOSED_REPOSITORY' && settled.state.name === 'Canceled', 'disposed repository work remained active');
  }));

  results.push(await run('59 managed Linear packet contains only execution facts and authority references', async () => {
    const h = harness(); await reconcile(h, baseRequest({ idempotency_key:'minimal-packet' })); const issue = [...h.linear.issues.values()][0]; const text = issue.description;
    check(text.includes('Repository:') && text.includes('Authority:') && text.includes('Outcome:') && text.includes('Next action:'), 'minimal packet omitted execution facts');
    check(!/Objective:|Gate:|Acceptance:|Exact coordinate:|Owner impact:/i.test(text), 'duplicated authority fields remained in managed packet');
  }));

  const failed = results.filter(result => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results };
}