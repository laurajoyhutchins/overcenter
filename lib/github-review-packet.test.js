import {
  GitHubReviewPacketError,
  createGithubReviewApiAdapter,
  mapGithubReviewPacketAuthError,
  reviewGithubPullRequest,
} from 'lib/github-review-packet.js';

function sha(seed) {
  return String(seed).padStart(40, '0').slice(-40).replace(/[^0-9a-f]/g, 'a');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function run(name, fn) {
  try { await fn(); return { name, ok: true }; }
  catch (error) { return { name, ok: false, error: String(error?.message || error) }; }
}

class FakeGithub {
  constructor(overrides = {}) {
    this.reads = 0;
    this.prSequence = overrides.prSequence || [this.pr(overrides.pr || {})];
    this.review = overrides.review || {
      decision: 'APPROVED', unresolved_thread_count: 0, threads_complete: true,
      unresolved_threads: [], unresolved_threads_complete: true,
    };
    this.checkRuns = overrides.checkRuns || { items: [], complete: true, total_count: 0 };
    this.statuses = overrides.statuses || { items: [], complete: true };
    this.changed = overrides.changed || { count: 1, paths: ['README.md'], complete: true, limit: 500 };
    this.rules = overrides.rules || { rules: [], complete: true };
  }

  pr(overrides = {}) {
    return {
      state: 'open', draft: false, merged: false,
      base: { ref: 'main', sha: sha(1) },
      head: { ref: 'agent/test', sha: sha(2), repo: 'laurajoyhutchins/test' },
      cross_repository: false,
      merge: { mergeable: true, merge_state: 'clean' },
      changed_file_count: 1,
      ...overrides,
    };
  }

  async getPullRequest() {
    const value = this.prSequence[Math.min(this.reads, this.prSequence.length - 1)];
    this.reads += 1;
    return clone(value);
  }
  async getReviewState() { return clone(this.review); }
  async listCheckRuns() { return clone(this.checkRuns); }
  async listStatuses() { return clone(this.statuses); }
  async listChangedPaths() { return clone(this.changed); }
  async listRulesForBranch() { return clone(this.rules); }
}

const NO_CLASSIC = async () => ({ configured: false, body: null });
const UNAVAILABLE_CLASSIC = async () => ({
  available: false,
  unavailable: { reason: 'github_app_permission_unavailable', required_permission: { administration: 'read' } },
});

function request(overrides = {}) {
  return { repo: 'laurajoyhutchins/test', pull_request: 1, ...overrides };
}

function review(overrides = {}) {
  return {
    decision: 'APPROVED', unresolved_thread_count: 0, threads_complete: true,
    unresolved_threads: [], unresolved_threads_complete: true,
    ...overrides,
  };
}

function checkRun(name, state = 'success', appId = 1) {
  const id = [...`${name}:${state}:${appId}`].reduce((sum, ch) => (sum * 33 + ch.charCodeAt(0)) % 1000000, 17) + 1;
  return {
    name,
    status: state === 'pending' ? 'in_progress' : 'completed',
    conclusion: state === 'pending' ? null : state,
    app: { id: appId, slug: 'ci' }, id,
    html_url: `https://github.com/checks/${encodeURIComponent(name)}`,
  };
}

function status(name, state = 'success') {
  return { context: name, state, id: 1, creator: { login: 'ci' }, target_url: `https://ci.example/${encodeURIComponent(name)}` };
}

function rulesetRequiredCheck(name, appId = null, strict = false) {
  return {
    type: 'required_status_checks',
    parameters: {
      required_status_checks: [{ context: name, ...(appId === null ? {} : { integration_id: appId }) }],
      strict_required_status_checks_policy: strict,
    },
  };
}

function rulesetPullRequest(overrides = {}) {
  return {
    type: 'pull_request',
    parameters: {
      required_approving_review_count: 1,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_review_thread_resolution: true,
      required_reviewers: [],
      ...overrides,
    },
  };
}

function classicProtection(overrides = {}) {
  return {
    configured: true,
    body: {
      required_status_checks: null,
      required_pull_request_reviews: null,
      required_conversation_resolution: { enabled: false },
      ...overrides,
    },
  };
}

export async function runGithubReviewPacketTests() {
  const results = [];

  results.push(await run('1 open non-draft PR', async () => {
    const r = await reviewGithubPullRequest(request(), { github: new FakeGithub(), protectionProvider: NO_CLASSIC });
    check(r.ok && r.state === 'open' && r.draft === false, 'open PR identity incorrect');
  }));

  results.push(await run('2 draft PR', async () => {
    const gh = new FakeGithub(); gh.prSequence = [gh.pr({ draft: true })];
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(r.ok && r.draft === true, 'draft not preserved');
  }));

  results.push(await run('3 closed PR', async () => {
    const gh = new FakeGithub(); gh.prSequence = [gh.pr({ state: 'closed' })];
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(r.ok && r.state === 'closed' && r.merged === false, 'closed state incorrect');
  }));

  results.push(await run('4 merged PR', async () => {
    const gh = new FakeGithub(); gh.prSequence = [gh.pr({ state: 'closed', merged: true })];
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(r.ok && r.merged === true, 'merged state incorrect');
  }));

  results.push(await run('5 exact base/head SHA returned', async () => {
    const r = await reviewGithubPullRequest(request(), { github: new FakeGithub(), protectionProvider: NO_CLASSIC });
    check(r.base.sha === sha(1) && r.head.sha === sha(2), 'exact SHAs not returned');
  }));

  results.push(await run('6 successful expected_head', async () => {
    const r = await reviewGithubPullRequest(request({ expected_head: sha(2) }), { github: new FakeGithub(), protectionProvider: NO_CLASSIC });
    check(r.ok && r.snapshot.head_sha === sha(2), 'expected head success failed');
  }));

  results.push(await run('7 stale expected_head', async () => {
    const r = await reviewGithubPullRequest(request({ expected_head: sha(99) }), { github: new FakeGithub(), protectionProvider: NO_CLASSIC });
    check(!r.ok && r.error === 'HEAD_MISMATCH' && r.actual_head === sha(2), 'stale head not rejected');
  }));

  results.push(await run('8 head movement between initial and final PR read', async () => {
    const gh = new FakeGithub();
    gh.prSequence = [gh.pr(), gh.pr({ head: { ref: 'agent/test', sha: sha(3), repo: 'laurajoyhutchins/test' } })];
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(!r.ok && r.error === 'HEAD_MOVED_DURING_INSPECTION' && r.initial_head === sha(2) && r.current_head === sha(3), 'head movement not detected');
  }));

  results.push(await run('9 mergeable PR', async () => {
    const r = await reviewGithubPullRequest(request(), { github: new FakeGithub(), protectionProvider: NO_CLASSIC });
    check(r.merge.mergeable === true && r.merge.merge_state === 'clean', 'mergeability incorrect');
  }));

  results.push(await run('10 conflicting PR', async () => {
    const gh = new FakeGithub(); gh.prSequence = [gh.pr({ merge: { mergeable: false, merge_state: 'dirty' } })];
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(r.ok && r.merge.mergeable === false && r.merge.merge_state === 'dirty', 'conflict state incorrect');
  }));

  results.push(await run('11 temporarily unknown mergeability', async () => {
    const gh = new FakeGithub(); gh.prSequence = [gh.pr({ merge: { mergeable: null, merge_state: 'unknown' } })];
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(r.ok && r.merge.mergeable === null && gh.reads >= 3, 'unknown mergeability refresh behavior incorrect');
  }));

  results.push(await run('12 approved review decision', async () => {
    const r = await reviewGithubPullRequest(request(), { github: new FakeGithub({ review: review({ decision: 'APPROVED' }) }), protectionProvider: NO_CLASSIC });
    check(r.review.decision === 'APPROVED' && r.review.changes_requested === false, 'approved review incorrect');
  }));

  results.push(await run('13 changes-requested review decision', async () => {
    const r = await reviewGithubPullRequest(request(), { github: new FakeGithub({ review: review({ decision: 'CHANGES_REQUESTED' }) }), protectionProvider: NO_CLASSIC });
    check(r.review.decision === 'CHANGES_REQUESTED' && r.review.changes_requested === true, 'changes requested incorrect');
  }));

  results.push(await run('14 unresolved review thread', async () => {
    const r = await reviewGithubPullRequest(request(), { github: new FakeGithub({ review: review({ unresolved_thread_count: 1, unresolved_threads: [{ id: 'T1', path: 'a.js', line: 4, author: 'x', url: null }], unresolved_threads_complete: true }) }), protectionProvider: NO_CLASSIC });
    check(r.review.unresolved_thread_count === 1 && r.review.unresolved_threads[0].id === 'T1', 'unresolved thread missing');
  }));

  results.push(await run('15 multiple pages of review threads', async () => {
    let graphqlCalls = 0;
    const apiClient = {
      async call() { return { status: 500, body: { message: 'unused' } }; },
      async graphql() {
        graphqlCalls += 1;
        return { status: 200, body: { data: { repository: { pullRequest: {
          reviewDecision: 'APPROVED',
          reviewThreads: {
            pageInfo: { hasNextPage: graphqlCalls === 1, endCursor: graphqlCalls === 1 ? 'next' : null },
            nodes: [{ id: `T${graphqlCalls}`, isResolved: false, path: 'a.js', line: graphqlCalls, startLine: null, comments: { nodes: [] } }],
          },
        } } } } };
      },
    };
    const adapter = createGithubReviewApiAdapter(apiClient);
    const state = await adapter.getReviewState('laurajoyhutchins/test', 1);
    check(graphqlCalls === 2 && state.unresolved_thread_count === 2 && state.threads_complete, 'thread pagination incomplete');
  }));

  results.push(await run('16 no silent success on truncated thread enumeration', async () => {
    const r = await reviewGithubPullRequest(request(), { github: new FakeGithub({ review: review({ unresolved_thread_count: null, observed_unresolved_thread_count: 4, threads_complete: false, unresolved_threads_complete: false }) }), protectionProvider: NO_CLASSIC });
    check(r.review.unresolved_thread_count === null && r.review.threads_complete === false, 'truncated threads reported clean');
  }));

  results.push(await run('17 passing checks', async () => {
    const gh = new FakeGithub({ checkRuns: { items: [checkRun('test')], complete: true, total_count: 1 } });
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(r.checks.rollup_state === 'SUCCESS' && r.checks.passing.includes('test'), 'passing check normalization failed');
  }));

  results.push(await run('18 pending checks', async () => {
    const gh = new FakeGithub({ checkRuns: { items: [checkRun('test', 'pending')], complete: true, total_count: 1 } });
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(r.checks.rollup_state === 'PENDING' && r.checks.pending.includes('test'), 'pending check normalization failed');
  }));

  results.push(await run('19 failing checks', async () => {
    const gh = new FakeGithub({ checkRuns: { items: [checkRun('test', 'failure')], complete: true, total_count: 1 } });
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(r.checks.rollup_state === 'FAILURE' && r.checks.failing.includes('test'), 'failing check normalization failed');
  }));

  results.push(await run('20 required check missing', async () => {
    const gh = new FakeGithub({ rules: { rules: [rulesetRequiredCheck('test')], complete: true } });
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(r.checks.required_satisfied === false && r.checks.missing_required.includes('test'), 'missing required check not detected');
  }));

  results.push(await run('21 required-check set unavailable', async () => {
    const r = await reviewGithubPullRequest(request(), { github: new FakeGithub(), protectionProvider: UNAVAILABLE_CLASSIC });
    check(r.checks.required_set_complete === false && r.checks.required_satisfied === null, 'unavailable required set claimed success');
  }));

  results.push(await run('22 classic branch protection when supported', async () => {
    const provider = async () => classicProtection({
      required_status_checks: { checks: [{ context: 'test', app_id: 1 }] },
      required_pull_request_reviews: { required_approving_review_count: 1, require_code_owner_reviews: false, require_last_push_approval: false },
      required_conversation_resolution: { enabled: true },
    });
    const gh = new FakeGithub({ checkRuns: { items: [checkRun('test', 'success', 1)], complete: true, total_count: 1 } });
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: provider });
    check(r.protection.source === 'branch_protection' && r.protection.evaluation === 'satisfied' && r.review.required_approvals === 1, 'classic protection evaluation failed');
  }));

  results.push(await run('23 applicable ruleset behavior when supported', async () => {
    const gh = new FakeGithub({
      rules: { rules: [rulesetRequiredCheck('test'), rulesetPullRequest()], complete: true },
      checkRuns: { items: [checkRun('test')], complete: true, total_count: 1 },
    });
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(r.protection.source === 'rulesets' && r.protection.evaluation === 'satisfied' && r.checks.required_satisfied === true, 'ruleset evaluation failed');
  }));

  results.push(await run('24 protection metadata unavailable because of app permission', async () => {
    const r = await reviewGithubPullRequest(request(), { github: new FakeGithub(), protectionProvider: UNAVAILABLE_CLASSIC });
    check(r.protection.evaluation === 'unavailable' && r.protection.unavailable.required_permission.administration === 'read', 'permission limitation not structural');
  }));

  results.push(await run('25 changed-path pagination', async () => {
    let page = 0;
    const apiClient = {
      async call(name, options) {
        if (!options.path.endsWith('/files')) return { status: 500, body: { message: 'unused' } };
        page += 1;
        const count = page === 1 ? 100 : 3;
        return { status: 200, body: Array.from({ length: count }, (_, i) => ({ filename: `p${page}-${i}.txt` })) };
      },
    };
    const adapter = createGithubReviewApiAdapter(apiClient);
    const changed = await adapter.listChangedPaths('laurajoyhutchins/test', 1, 103);
    check(page === 2 && changed.paths.length === 103 && changed.complete, 'changed path pagination failed');
  }));

  results.push(await run('26 changed-path truncation is explicit', async () => {
    const gh = new FakeGithub({ changed: { count: 5000, paths: Array.from({ length: 500 }, (_, i) => `f${i}.txt`), complete: false, limit: 500 } });
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(r.changed_files.count === 5000 && r.changed_files.paths.length === 500 && r.changed_files.complete === false, 'changed paths silently truncated');
  }));

  results.push(await run('27 cross-repository PR', async () => {
    const gh = new FakeGithub(); gh.prSequence = [gh.pr({ head: { ref: 'fork', sha: sha(2), repo: 'someone/fork' }, cross_repository: true })];
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(r.cross_repository === true && r.head.repo === 'someone/fork', 'cross-repository identity incorrect');
  }));

  results.push(await run('28 private repository with installed GitHub App', async () => {
    const r = await reviewGithubPullRequest(request(), { github: new FakeGithub(), protectionProvider: NO_CLASSIC });
    check(r.ok, 'installed-app read path should be repository-visibility agnostic');
  }));

  results.push(await run('29 repository without app installation', async () => {
    const mapped = mapGithubReviewPacketAuthError(Object.assign(new Error('not found'), { status: 404 }), { pull_requests: 'read' });
    check(mapped.error === 'GITHUB_APP_INSTALLATION_NOT_FOUND', 'installation error mapping failed');
  }));

  results.push(await run('30 permission denied', async () => {
    const mapped = mapGithubReviewPacketAuthError(Object.assign(new Error('permissions not permitted'), { status: 422 }), { checks: 'read' });
    check(mapped.error === 'GITHUB_APP_PERMISSION_DENIED' && mapped.required_permissions.checks === 'read', 'permission error mapping failed');
  }));

  results.push(await run('31 malformed PR number', async () => {
    const r = await reviewGithubPullRequest(request({ pull_request: 0 }), { github: new FakeGithub(), protectionProvider: NO_CLASSIC });
    check(!r.ok && r.error === 'INVALID_PULL_REQUEST', 'malformed PR accepted');
  }));

  results.push(await run('32 malformed repository identity', async () => {
    const r = await reviewGithubPullRequest(request({ repo: 'https://github.com/x/y' }), { github: new FakeGithub(), protectionProvider: NO_CLASSIC });
    check(!r.ok && r.error === 'INVALID_REPOSITORY', 'malformed repo accepted');
  }));

  results.push(await run('33 malformed expected SHA', async () => {
    const r = await reviewGithubPullRequest(request({ expected_head: 'abc' }), { github: new FakeGithub(), protectionProvider: NO_CLASSIC });
    check(!r.ok && r.error === 'INVALID_SHA', 'malformed SHA accepted');
  }));

  results.push(await run('34 stable snapshot digest for identical normalized state', async () => {
    const opts = { protectionProvider: NO_CLASSIC, now: () => new Date('2026-08-16T22:00:00Z') };
    const a = await reviewGithubPullRequest(request(), { ...opts, github: new FakeGithub() });
    const b = await reviewGithubPullRequest(request(), { ...opts, github: new FakeGithub() });
    check(a.snapshot.sha256 === b.snapshot.sha256, 'stable state produced different digest');
  }));

  results.push(await run('35 snapshot digest changes when material state changes', async () => {
    const opts = { protectionProvider: NO_CLASSIC, now: () => new Date('2026-08-16T22:00:00Z') };
    const a = await reviewGithubPullRequest(request(), { ...opts, github: new FakeGithub() });
    const b = await reviewGithubPullRequest(request(), { ...opts, github: new FakeGithub({ review: review({ decision: 'CHANGES_REQUESTED' }) }) });
    check(a.snapshot.sha256 !== b.snapshot.sha256, 'material state change did not alter digest');
  }));

  results.push(await run('36 check-run and commit-status normalization coexist', async () => {
    const gh = new FakeGithub({
      checkRuns: { items: [checkRun('test')], complete: true, total_count: 1 },
      statuses: { items: [status('lint', 'success')], complete: true },
    });
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(r.checks.passing.includes('test') && r.checks.passing.includes('lint') && r.checks.items.length === 2, 'check/status mechanisms not normalized together');
  }));

  results.push(await run('37 strict required checks reject a behind head', async () => {
    const gh = new FakeGithub({
      rules: { rules: [rulesetRequiredCheck('test', null, true)], complete: true },
      checkRuns: { items: [checkRun('test')], complete: true, total_count: 1 },
    });
    gh.prSequence = [gh.pr({ merge: { mergeable: true, merge_state: 'behind' } })];
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(r.protection.evaluation === 'unsatisfied' && r.protection.unsatisfied_requirements.includes('branch_up_to_date') && r.protection.branch_up_to_date_satisfied === false, 'behind strict head claimed policy satisfaction');
  }));

  results.push(await run('38 strict required checks stay unknown when GitHub cannot establish up-to-date state', async () => {
    const gh = new FakeGithub({
      rules: { rules: [rulesetRequiredCheck('test', null, true)], complete: true },
      checkRuns: { items: [checkRun('test')], complete: true, total_count: 1 },
    });
    gh.prSequence = [gh.pr({ merge: { mergeable: true, merge_state: 'blocked' } })];
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(r.protection.evaluation === 'unknown' && r.protection.branch_up_to_date_satisfied === null, 'strict up-to-date state was inferred from a non-clean merge state');
  }));

  results.push(await run('39 fully available policy surfaces are explicit', async () => {
    const r = await reviewGithubPullRequest(request(), { github: new FakeGithub(), protectionProvider: NO_CLASSIC });
    check(r.ok && r.protection.available === true, 'fully available policy was not marked available');
    check(r.protection.policy_surfaces.rulesets.available === true, 'rulesets availability missing');
    check(r.protection.policy_surfaces.classic_branch_protection.available === true, 'classic availability missing');
  }));

  results.push(await run('40 classic protection permission limitation is explicit partial knowledge', async () => {
    const provider = async () => ({
      available: false,
      unavailable: {
        reason: 'permission_denied',
        error: 'GITHUB_APP_PERMISSION_DENIED',
        message: 'Branch protection could not be inspected.',
        required_permission: { administration: 'read' },
      },
    });
    const r = await reviewGithubPullRequest(request(), { github: new FakeGithub(), protectionProvider: provider });
    check(r.ok && r.protection.available === false, 'permission-limited packet did not remain successful partial knowledge');
    check(r.protection.policy_surfaces.classic_branch_protection.available === false, 'classic unavailability missing');
    check(r.protection.policy_surfaces.classic_branch_protection.unavailable.reason === 'permission_denied', 'classic unavailable reason missing');
  }));

  results.push(await run('41 ruleset permission limitation degrades only ruleset policy evidence', async () => {
    const gh = new FakeGithub();
    gh.listRulesForBranch = async () => {
      throw new GitHubReviewPacketError('GITHUB_PERMISSION_DENIED', 'Rulesets could not be inspected.', {
        status: 403,
        github_path: '/repos/laurajoyhutchins/test/rules/branches/main',
      }, 403);
    };
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(r.ok, 'ruleset permission limitation collapsed the packet');
    check(r.protection.policy_surfaces.rulesets.available === false, 'ruleset unavailability missing');
    check(r.protection.policy_surfaces.rulesets.unavailable.reason === 'permission_denied', 'ruleset unavailable reason missing');
    check(r.checks.required_satisfied === null, 'unknown required-check policy was treated as satisfied');
  }));

  results.push(await run('42 known-empty protection differs from unavailable protection', async () => {
    const known = await reviewGithubPullRequest(request(), { github: new FakeGithub(), protectionProvider: NO_CLASSIC });
    const unavailable = await reviewGithubPullRequest(request(), { github: new FakeGithub(), protectionProvider: UNAVAILABLE_CLASSIC });
    check(known.protection.policy_surfaces.classic_branch_protection.available === true, 'known-empty classic evidence not marked available');
    check(known.protection.policy_surfaces.classic_branch_protection.configured === false, 'known-empty classic evidence not marked unconfigured');
    check(unavailable.protection.policy_surfaces.classic_branch_protection.available === false, 'unavailable classic evidence not distinct');
  }));

  results.push(await run('43 ruleset unavailable makes policy-dependent conclusions indeterminate', async () => {
    const gh = new FakeGithub();
    gh.listRulesForBranch = async () => {
      throw new GitHubReviewPacketError('GITHUB_UPSTREAM_ERROR', 'Rules API unavailable.', { status: 503 }, 502);
    };
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(r.ok, 'bounded ruleset upstream outage collapsed the packet');
    check(r.protection.evaluation === 'unavailable', 'policy evaluation did not become unavailable');
    check(r.review.required_approvals === null, 'review policy was inferred despite unavailable rulesets');
    check(r.checks.required_satisfied === null, 'required checks were inferred despite unavailable rulesets');
  }));

  results.push(await run('44 exact-head coherence survives optional evidence loss', async () => {
    const gh = new FakeGithub();
    gh.listRulesForBranch = async () => {
      throw new GitHubReviewPacketError('GITHUB_PERMISSION_DENIED', 'Rulesets unavailable.', { status: 403 }, 403);
    };
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: UNAVAILABLE_CLASSIC });
    check(r.ok && r.snapshot.head_sha === sha(2) && r.snapshot.base_sha === sha(1), 'coherent identity was lost during partial observation');
  }));

  results.push(await run('45 head movement remains command failure with optional evidence unavailable', async () => {
    const gh = new FakeGithub();
    gh.listRulesForBranch = async () => {
      throw new GitHubReviewPacketError('GITHUB_PERMISSION_DENIED', 'Rulesets unavailable.', { status: 403 }, 403);
    };
    gh.prSequence = [gh.pr(), gh.pr({ head: { ref: 'agent/test', sha: sha(3), repo: 'laurajoyhutchins/test' } })];
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: UNAVAILABLE_CLASSIC });
    check(!r.ok && r.error === 'HEAD_MOVED_DURING_INSPECTION', 'head movement was degraded into partial knowledge');
  }));

  results.push(await run('46 inability to establish PR identity remains command failure', async () => {
    const gh = new FakeGithub();
    gh.getPullRequest = async () => {
      throw new GitHubReviewPacketError('GITHUB_INVALID_RESPONSE', 'PR identity incomplete.', null, 502);
    };
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(!r.ok && r.error === 'GITHUB_INVALID_RESPONSE', 'identity failure was degraded into partial knowledge');
  }));

  results.push(await run('47 broad authentication failure remains command failure', async () => {
    const mapped = mapGithubReviewPacketAuthError(Object.assign(new Error('installation token denied'), { status: 403 }), { pull_requests: 'read' });
    check(mapped.ok === false && mapped.error === 'GITHUB_APP_PERMISSION_DENIED', 'broad authentication failure was not command-level');
  }));

  results.push(await run('48 unexpected internal failure is not swallowed as partial knowledge', async () => {
    const gh = new FakeGithub();
    gh.listRulesForBranch = async () => { throw new TypeError('programmer bug'); };
    let threw = false;
    try {
      await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    } catch (error) {
      threw = error instanceof TypeError && error.message === 'programmer bug';
    }
    check(threw, 'unexpected internal failure was swallowed');
  }));

  results.push(await run('49 known-empty and unavailable policy states have different snapshot digests', async () => {
    const opts = { now: () => new Date('2026-08-17T15:00:00Z') };
    const known = await reviewGithubPullRequest(request(), { ...opts, github: new FakeGithub(), protectionProvider: NO_CLASSIC });
    const unavailable = await reviewGithubPullRequest(request(), { ...opts, github: new FakeGithub(), protectionProvider: UNAVAILABLE_CLASSIC });
    check(known.snapshot.sha256 !== unavailable.snapshot.sha256, 'snapshot digest collapsed unavailable into known-empty');
  }));

  results.push(await run('50 malformed optional ruleset response still fails closed', async () => {
    const gh = new FakeGithub();
    gh.listRulesForBranch = async () => {
      throw new GitHubReviewPacketError('GITHUB_INVALID_RESPONSE', 'Rules response malformed.', null, 502);
    };
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(!r.ok && r.error === 'GITHUB_INVALID_RESPONSE', 'malformed optional evidence was swallowed');
  }));

  results.push(await run('51 optional policy upstream outage is explicit machine-readable evidence', async () => {
    const gh = new FakeGithub();
    gh.listRulesForBranch = async () => {
      throw new GitHubReviewPacketError('GITHUB_UPSTREAM_ERROR', 'temporary outage', { status: 503 }, 502);
    };
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    const unavailable = r.protection.policy_surfaces.rulesets.unavailable;
    check(unavailable.reason === 'upstream_unavailable' && unavailable.error === 'GITHUB_UPSTREAM_ERROR', 'upstream partial evidence is not machine-readable');
  }));

  results.push(await run('52 full-capability ruleset behavior remains unchanged', async () => {
    const gh = new FakeGithub({
      rules: { rules: [rulesetRequiredCheck('test'), rulesetPullRequest()], complete: true },
      checkRuns: { items: [checkRun('test')], complete: true, total_count: 1 },
    });
    const r = await reviewGithubPullRequest(request(), { github: gh, protectionProvider: NO_CLASSIC });
    check(r.protection.evaluation === 'satisfied' && r.checks.required_satisfied === true && r.review.required_approvals === 1, 'full-capability behavior changed');
  }));

  const failed = results.filter(result => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results };
}