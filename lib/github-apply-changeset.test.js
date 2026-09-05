import { applyGithubChangeset, classifyGithubAppChangesetAuthError, createGithubApiAdapter, GitHubChangesetError } from 'lib/github-apply-changeset.js';
import { githubAppChangesetPermissionProfile, githubAppPermissionProfile } from 'lib/github-app-auth.js';
import { runGithubTextTransportSpec } from 'lib/github-text-transport.spec.js';

function sha(seed) {
  return String(seed).padStart(40, '0').slice(-40).replace(/[^0-9a-f]/g, 'a');
}

class MemoryReceipts {
  constructor() { this.rows = new Map(); this.heartbeats = []; }
  key(n) { return `${n.repo}#${n.idempotency_key}`; }
  async claim(n, digest, attemptToken) {
    const key = this.key(n);
    const row = this.rows.get(key);
    if (!row) {
      const created = { repo: n.repo, idempotency_key: n.idempotency_key, request_sha256: digest, state: 'processing', attempt_token: attemptToken, branch: n.branch };
      this.rows.set(key, created);
      return { kind: 'claimed', row: created };
    }
    if (row.request_sha256 !== digest) return { kind: 'conflict', row };
    if (row.state === 'succeeded' || row.state === 'prepared') return { kind: 'existing', row };
    return { kind: 'in_progress', row };
  }
  async savePlan(n, token, plan) { Object.assign(this.rows.get(this.key(n)), { base_sha: plan.baseSha, old_head: plan.oldHead, created_branch: plan.createdBranch, precondition_verified: plan.preconditionVerified, changed_paths: plan.changedPaths }); }
  async saveTree(n, token, treeSha) { this.rows.get(this.key(n)).tree_sha = treeSha; }
  async saveCommit(n, token, commitSha) { Object.assign(this.rows.get(this.key(n)), { commit_sha: commitSha, state: 'prepared' }); }
  async heartbeat(n, token, phase) { this.heartbeats.push({ key: this.key(n), token, phase }); }
  async succeed(n, attemptToken, receipt) {
    const row = this.rows.get(this.key(n));
    if (!row || row.attempt_token !== attemptToken) return false;
    Object.assign(row, { state: 'succeeded', receipt });
    return true;
  }
  async abandon(n) { this.rows.delete(this.key(n)); }
}

class FakeGithub {
  constructor() {
    this.blobSeq = 20;
    this.treeSeq = 30;
    this.commitSeq = 40;
    this.commitCreates = 0;
    this.refMutations = 0;
    this.blobContents = [];
    this.treeEntries = [];
    this.failFinal = null;
    this.beforeFinal = null;
    this.trees = new Map();
    this.commits = new Map();
    this.branches = new Map();
    const rootTree = sha(1);
    const mainCommit = sha(2);
    this.trees.set(rootTree, new Map([
      ['README.md', { path: 'README.md', mode: '100644', type: 'blob', sha: sha(10), content: 'old readme' }],
      ['docs/existing.md', { path: 'docs/existing.md', mode: '100644', type: 'blob', sha: sha(11), content: 'old docs' }],
      ['obsolete.md', { path: 'obsolete.md', mode: '100644', type: 'blob', sha: sha(12), content: 'obsolete' }],
    ]));
    this.commits.set(mainCommit, { sha: mainCommit, tree_sha: rootTree, message: 'base', parents: [] });
    this.branches.set('main', mainCommit);
    this.main = mainCommit;
  }
  async resolveCommit(repo, selector) {
    const commitSha = this.branches.get(selector) || selector;
    const commit = this.commits.get(commitSha);
    if (!commit) throw new GitHubChangesetError('GITHUB_NOT_FOUND', 'commit not found');
    return { sha: commit.sha, tree_sha: commit.tree_sha };
  }
  async getBranch(repo, branch) { return this.branches.has(branch) ? { sha: this.branches.get(branch) } : null; }
  async getCommit(repo, commitSha) {
    const commit = this.commits.get(commitSha);
    if (!commit) throw new GitHubChangesetError('GITHUB_NOT_FOUND', 'commit not found');
    return { ...commit };
  }
  async getPathEntries(repo, treeSha, paths) {
    const tree = this.trees.get(treeSha) || new Map();
    return new Map(paths.map(path => [path, tree.get(path) || null]));
  }
  async createBlob(repo, content) { this.blobContents.push(content); this.blobSeq += 1; return sha(this.blobSeq); }
  async createTree(repo, baseTreeSha, entries) {
    this.treeEntries = entries.map(entry => ({ ...entry }));
    const next = new Map(this.trees.get(baseTreeSha) || []);
    for (const entry of entries) {
      if (entry.sha === null) next.delete(entry.path);
      else if (entry.content !== undefined) next.set(entry.path, { ...entry, sha: sha(500 + next.size), content: entry.content });
      else next.set(entry.path, { ...entry });
    }
    this.treeSeq += 1;
    const nextSha = sha(this.treeSeq);
    this.trees.set(nextSha, next);
    return nextSha;
  }
  async createCommit(repo, { message, treeSha, parentSha }) {
    this.commitCreates += 1;
    this.commitSeq += 1;
    const commitSha = sha(this.commitSeq);
    this.commits.set(commitSha, { sha: commitSha, tree_sha: treeSha, message, parents: [parentSha] });
    return commitSha;
  }
  async createBranch(repo, branch, commitSha) {
    if (this.beforeFinal) await this.beforeFinal(this, 'create', branch, commitSha);
    if (this.failFinal) throw this.failFinal;
    if (this.branches.has(branch)) throw new GitHubChangesetError('GITHUB_REF_REJECTED', 'Reference already exists');
    this.branches.set(branch, commitSha);
    this.refMutations += 1;
  }
  async updateBranch(repo, branch, commitSha) {
    if (this.beforeFinal) await this.beforeFinal(this, 'update', branch, commitSha);
    if (this.failFinal) throw this.failFinal;
    this.branches.set(branch, commitSha);
    this.refMutations += 1;
  }
}

function request(overrides = {}) {
  return {
    repo: 'laurajoyhutchins/test',
    base_ref: 'main',
    branch: 'feat/test-change',
    changes: [{ path: 'new.txt', operation: 'create', content: 'hello\n' }],
    commit_message: 'Apply fixture changeset',
    ...overrides,
  };
}

function check(condition, message) { if (!condition) throw new Error(message); }

async function run(name, fn) {
  try { await fn(); return { name, ok: true }; }
  catch (error) { return { name, ok: false, error: String(error?.message || error) }; }
}

export async function runGithubApplyChangesetTests() {
  const results = [];

  results.push(await run('1 create one file on a new branch', async () => {
    const gh = new FakeGithub();
    const r = await applyGithubChangeset(request(), { github: gh });
    check(r.ok && r.created_branch === true, 'expected successful branch creation');
    check(gh.branches.get(r.branch) === r.commit_sha, 'branch must point to changeset commit');
  }));

  results.push(await run('1b reject a new legacy execution-identity branch but grandfather an existing one', async () => {
    const createGh = new FakeGithub();
    const rejected = await applyGithubChangeset(request({ branch: 'agent/new-work' }), { github: createGh });
    check(!rejected.ok && rejected.error === 'INVALID_BRANCH_POLICY', 'new legacy branch was accepted');
    check(createGh.refMutations === 0, 'rejected legacy branch mutated a ref');

    const existingGh = new FakeGithub(); existingGh.branches.set('agent/existing', existingGh.main);
    const existing = await applyGithubChangeset(request({ branch: 'agent/existing' }), { github: existingGh });
    check(existing.ok, 'existing legacy branch was not grandfathered');
  }));

  results.push(await run('2 update several files in one commit', async () => {
    const gh = new FakeGithub(); gh.branches.set('agent/existing', gh.main);
    const r = await applyGithubChangeset(request({ branch: 'agent/existing', changes: [
      { path: 'README.md', operation: 'update', content: 'new readme' },
      { path: 'docs/existing.md', operation: 'update', content: 'new docs' },
    ] }), { github: gh });
    check(r.ok && gh.commitCreates === 1, 'updates must create exactly one commit');
  }));

  results.push(await run('3 create update delete in one changeset', async () => {
    const gh = new FakeGithub();
    const r = await applyGithubChangeset(request({ changes: [
      { path: 'new.txt', operation: 'create', content: 'new' },
      { path: 'README.md', operation: 'update', content: 'updated' },
      { path: 'obsolete.md', operation: 'delete' },
    ] }), { github: gh });
    check(r.ok, 'mixed changeset failed');
    const tree = gh.trees.get(r.tree_sha);
    check(tree.has('new.txt') && tree.has('README.md') && !tree.has('obsolete.md'), 'mixed tree state incorrect');
  }));

  results.push(await run('4 existing branch fast-forward', async () => {
    const gh = new FakeGithub(); gh.branches.set('agent/existing', gh.main);
    const r = await applyGithubChangeset(request({ branch: 'agent/existing' }), { github: gh });
    check(r.ok && r.old_head === gh.main && gh.branches.get('agent/existing') === r.commit_sha, 'existing branch did not fast-forward');
  }));

  results.push(await run('5 expected_head success', async () => {
    const gh = new FakeGithub(); gh.branches.set('agent/existing', gh.main);
    const r = await applyGithubChangeset(request({ branch: 'agent/existing', expected_head: gh.main }), { github: gh });
    check(r.ok && r.precondition_verified === true, 'expected_head was not verified');
  }));

  results.push(await run('6 stale expected_head rejection with no ref mutation', async () => {
    const gh = new FakeGithub(); gh.branches.set('agent/existing', gh.main);
    const r = await applyGithubChangeset(request({ branch: 'agent/existing', expected_head: sha(999) }), { github: gh });
    check(!r.ok && r.error === 'HEAD_MISMATCH', 'stale head must reject');
    check(gh.refMutations === 0 && gh.branches.get('agent/existing') === gh.main, 'stale head mutated ref');
  }));

  results.push(await run('7 duplicate-path validation', async () => {
    const gh = new FakeGithub();
    const r = await applyGithubChangeset(request({ changes: [
      { path: 'same.txt', operation: 'create', content: 'a' },
      { path: 'same.txt', operation: 'update', content: 'b' },
    ] }), { github: gh });
    check(!r.ok && r.error === 'DUPLICATE_PATH' && gh.commitCreates === 0, 'duplicate path not rejected');
  }));

  results.push(await run('8 missing update/delete target behavior', async () => {
    const gh1 = new FakeGithub();
    const u = await applyGithubChangeset(request({ changes: [{ path: 'missing.txt', operation: 'update', content: 'x' }] }), { github: gh1 });
    check(!u.ok && u.error === 'UPDATE_TARGET_MISSING', 'missing update target not rejected');
    const gh2 = new FakeGithub();
    const d = await applyGithubChangeset(request({ changes: [{ path: 'missing.txt', operation: 'delete' }] }), { github: gh2 });
    check(!d.ok && d.error === 'DELETE_TARGET_MISSING', 'missing delete target not rejected');
  }));

  results.push(await run('9 invalid path rejection', async () => {
    const gh = new FakeGithub();
    const r = await applyGithubChangeset(request({ changes: [{ path: '../escape.txt', operation: 'create', content: 'x' }] }), { github: gh });
    check(!r.ok && r.error === 'INVALID_PATH' && gh.commitCreates === 0, 'invalid path not rejected');
  }));

  results.push(await run('10 permission/protected-branch failure propagation', async () => {
    const denied = new FakeGithub(); denied.branches.set('agent/existing', denied.main);
    denied.failFinal = new GitHubChangesetError('GITHUB_PERMISSION_DENIED', 'repository write denied', { status: 403, github_message: 'repository write denied' }, 403);
    const permission = await applyGithubChangeset(request({ branch: 'agent/existing' }), { github: denied });
    check(!permission.ok && permission.error === 'GITHUB_PERMISSION_DENIED' && permission.status === 403, 'permission failure not propagated');
    check(denied.branches.get('agent/existing') === denied.main, 'permission failure mutated ref');

    const protectedBranch = new FakeGithub(); protectedBranch.branches.set('agent/existing', protectedBranch.main);
    protectedBranch.failFinal = new GitHubChangesetError('GITHUB_REF_REJECTED', 'protected branch update rejected', { status: 422, github_message: 'protected branch update rejected' }, 422);
    const protection = await applyGithubChangeset(request({ branch: 'agent/existing' }), { github: protectedBranch });
    check(!protection.ok && protection.error === 'GITHUB_REF_REJECTED' && protection.status === 422, 'protected-branch failure not propagated');
    check(protectedBranch.branches.get('agent/existing') === protectedBranch.main, 'protected-branch failure mutated ref');
  }));

  results.push(await run('11 retry/idempotency behavior', async () => {
    const gh = new FakeGithub(); const receipts = new MemoryReceipts();
    const req = request({ idempotency_key: 'fixture-idempotency-1' });
    const first = await applyGithubChangeset(req, { github: gh, receipts, idFactory: () => '00000000-0000-4000-8000-000000000001' });
    const second = await applyGithubChangeset(req, { github: gh, receipts, idFactory: () => '00000000-0000-4000-8000-000000000002' });
    check(first.ok && second.ok && second.idempotent_replay === true, 'idempotent replay failed');
    check(first.commit_sha === second.commit_sha && gh.commitCreates === 1, 'retry created duplicate commit');
  }));

  results.push(await run('11b completion retains the attempt identity that performed the effect', async () => {
    const gh = new FakeGithub();
    const receipts = new MemoryReceipts();
    const expectedAttemptToken = '00000000-0000-4000-8000-000000000011';
    let completionAttemptToken = null;
    receipts.succeed = async (normalized, attemptToken) => {
      completionAttemptToken = attemptToken;
      const row = receipts.rows.get(receipts.key(normalized));
      if (row) row.state = 'succeeded';
    };
    const r = await applyGithubChangeset(request({ idempotency_key: 'fixture-completion-identity-11b' }), {
      github: gh,
      receipts,
      idFactory: () => expectedAttemptToken,
    });
    check(r.ok, 'identity-bound completion fixture changeset failed');
    check(completionAttemptToken === expectedAttemptToken, 'completion did not retain the claim attempt identity');
  }));

  results.push(await run('11c prepared recovery completes with the effect-producing attempt identity', async () => {
    const gh = new FakeGithub();
    const receipts = new MemoryReceipts();
    const originalAttemptToken = '00000000-0000-4000-8000-000000000012';
    const laterCandidateToken = '00000000-0000-4000-8000-000000000013';
    const completionTokens = [];
    receipts.succeed = async (normalized, attemptToken) => {
      completionTokens.push(attemptToken);
      // Keep the receipt prepared so the next invocation must reconcile the prior effect.
    };
    const req = request({ idempotency_key: 'fixture-prepared-completion-identity-11c' });
    const first = await applyGithubChangeset(req, { github: gh, receipts, idFactory: () => originalAttemptToken });
    const second = await applyGithubChangeset(req, { github: gh, receipts, idFactory: () => laterCandidateToken });
    check(first.ok && second.ok, 'prepared recovery fixture did not reconcile successfully');
    check(completionTokens.length === 2, 'prepared recovery did not attempt both completion writes');
    check(completionTokens[1] === originalAttemptToken, 'prepared recovery rebound completion to a later invocation identity');
  }));

  results.push(await run('12 target branch creation race', async () => {
    const gh = new FakeGithub();
    gh.beforeFinal = async (g, kind, branch) => { if (kind === 'create') g.branches.set(branch, sha(777)); };
    const r = await applyGithubChangeset(request(), { github: gh });
    check(!r.ok && r.error === 'BRANCH_CREATION_RACE', 'branch creation race not detected');
    check(gh.branches.get('feat/test-change') === sha(777), 'concurrent branch was overwritten');
  }));

  results.push(await run('13 ref update race between preflight and final mutation', async () => {
    const gh = new FakeGithub(); gh.branches.set('agent/existing', gh.main);
    gh.beforeFinal = async (g, kind, branch) => {
      if (kind === 'update') {
        g.branches.set(branch, sha(778));
        throw new GitHubChangesetError('GITHUB_REF_REJECTED', 'Update is not a fast forward', { status: 422 }, 422);
      }
    };
    const r = await applyGithubChangeset(request({ branch: 'agent/existing', expected_head: gh.main }), { github: gh });
    check(!r.ok && r.error === 'HEAD_MISMATCH', 'ref update race not surfaced as head mismatch');
    check(gh.branches.get('agent/existing') === sha(778), 'concurrent head was overwritten');
  }));

  results.push(await run('14 multi-file operation produces exactly one new commit', async () => {
    const gh = new FakeGithub();
    const r = await applyGithubChangeset(request({ changes: [
      { path: 'a.txt', operation: 'create', content: 'a' },
      { path: 'b.txt', operation: 'create', content: 'b' },
      { path: 'README.md', operation: 'update', content: 'readme' },
    ] }), { github: gh });
    check(r.ok && gh.commitCreates === 1 && gh.refMutations === 1, 'multi-file changeset was not one commit/ref mutation');
  }));

  results.push(await run('15 changeset GitHub App token scope remains contents write only', async () => {
    const permissions = githubAppPermissionProfile('changeset');
    check(JSON.stringify(permissions) === JSON.stringify({ contents: 'write' }), 'changeset token permission scope changed');
  }));

  results.push(await run('15b workflow path selection does not widen ordinary changesets', async () => {
    check(githubAppChangesetPermissionProfile(['README.md']) === 'changeset', 'ordinary path requested workflow scope');
    check(githubAppChangesetPermissionProfile(['.github/workflows/ci.yml']) === 'workflow_changeset', 'workflow path did not request workflow scope');
  }));

  results.push(await run('15c missing workflow permission is typed before mutation', async () => {
    const error = Object.assign(new Error('The permissions requested are not granted to this installation.'), {
      status: 422,
      phase: 'auth.token_mint',
      githubPath: '/app/installations/1/access_tokens',
      mayHaveMutated: false,
    });
    const failure = classifyGithubAppChangesetAuthError(error, 'workflow_changeset');
    check(failure.ok === false && failure.error === 'GITHUB_WORKFLOWS_PERMISSION_REQUIRED', 'workflow permission denial was not typed');
    check(failure.phase === 'auth.token_mint' && failure.may_have_mutated === false, 'workflow permission denial lost pre-mutation evidence');
    const ordinary = classifyGithubAppChangesetAuthError(error, 'changeset');
    check(ordinary.error !== 'GITHUB_WORKFLOWS_PERMISSION_REQUIRED', 'ordinary auth failure was mislabeled as workflow-specific');
  }));

  results.push(await run('16 review-packet permissions cannot leak into changeset calls', async () => {
    const permissions = githubAppPermissionProfile('changeset');
    check(!permissions.pull_requests && !permissions.checks && !permissions.statuses && !permissions.administration && !permissions.metadata, 'review permission leaked into changeset scope');
  }));

  results.push(await run('17 ensure_final_newline repairs tool-transport EOF loss', async () => {
    const gh = new FakeGithub();
    const r = await applyGithubChangeset(request({ changes: [
      { path: 'new.txt', operation: 'create', content: 'hello', ensure_final_newline: true },
    ] }), { github: gh });
    check(r.ok, 'ensure_final_newline changeset failed');
    const entry = gh.treeEntries.find(item => item.path === 'new.txt');
    check(entry?.content === 'hello\n', 'final newline was not preserved in the tree content mutation');
  }));

  results.push(await run('18 multi-file text changes are carried by one tree mutation without per-file blob calls', async () => {
    const gh = new FakeGithub();
    const r = await applyGithubChangeset(request({ changes: [
      { path: 'a.txt', operation: 'create', content: 'a' },
      { path: 'b.txt', operation: 'create', content: 'b' },
      { path: 'README.md', operation: 'update', content: 'readme' },
    ] }), { github: gh });
    check(r.ok, 'batched tree-content changeset failed');
    check(gh.blobContents.length === 0, 'changeset still issued per-file blob mutations');
    check(gh.treeEntries.filter(entry => entry.content !== undefined).length === 3, 'tree mutation did not carry all text content');
  }));

  results.push(await run('19 idempotent processing receipts heartbeat after expensive preflight', async () => {
    const gh = new FakeGithub();
    const receipts = new MemoryReceipts();
    const r = await applyGithubChangeset(request({ idempotency_key: 'fixture-heartbeat-1' }), {
      github: gh,
      receipts,
      idFactory: () => '00000000-0000-4000-8000-000000000019',
    });
    check(r.ok, 'heartbeat fixture changeset failed');
    check(receipts.heartbeats.some(item => item.phase === 'preflight_complete'), 'processing receipt was not heartbeated after preflight');
  }));

  results.push(await run('19b lost durable attempt fence stops before first provider mutation', async () => {
    const gh = new FakeGithub();
    const receipts = new MemoryReceipts();
    receipts.heartbeat = async () => false;
    const r = await applyGithubChangeset(request({ idempotency_key: 'fixture-pre-effect-fence-19b' }), {
      github: gh,
      receipts,
      idFactory: () => '00000000-0000-4000-8000-000000000119',
    });
    check(!r.ok && r.error === 'GITHUB_CHANGESET_ATTEMPT_FENCE_LOST', 'lost attempt fence did not fail closed');
    check(r.phase === 'preflight_complete' && r.may_have_mutated === false, 'lost attempt fence was not classified as pre-mutation');
    check(gh.treeEntries.length === 0 && gh.commitCreates === 0 && gh.refMutations === 0, 'provider mutation escaped after the attempt fence was lost');
  }));

  results.push(await run('20 safe GitHub reads retry bounded transient upstream failures', async () => {
    let calls = 0;
    const apiClient = {
      async call() {
        calls += 1;
        if (calls < 3) return { status: 503, body: { message: 'temporary upstream failure' }, headers: { 'x-github-request-id': `req-${calls}` } };
        return { status: 200, body: { object: { sha: sha(222) } }, headers: { 'x-github-request-id': 'req-3' } };
      },
    };
    const github = createGithubApiAdapter(apiClient, { sleep: async () => {}, random: () => 0 });
    const branch = await github.getBranch('laurajoyhutchins/test', 'main');
    check(branch?.sha === sha(222), 'safe read did not recover after bounded retries');
    check(calls === 3, `safe read expected 3 attempts, observed ${calls}`);
  }));

  results.push(await run('21 GitHub mutation transport failures expose phase and request evidence without automatic retry', async () => {
    let calls = 0;
    const apiClient = {
      async call() {
        calls += 1;
        return {
          status: 503,
          body: { message: 'upstream unavailable' },
          headers: { 'x-github-request-id': 'REQ-TRANSPORT-21', 'retry-after': '2' },
        };
      },
    };
    const github = createGithubApiAdapter(apiClient, { sleep: async () => {}, random: () => 0 });
    let failure = null;
    try {
      await github.createCommit('laurajoyhutchins/test', { message: 'x', treeSha: sha(1), parentSha: sha(2) });
    } catch (error) {
      failure = error;
    }
    check(failure instanceof GitHubChangesetError, 'mutation transport failure was not normalized');
    check(failure?.details?.phase === 'mutation.commit', 'mutation failure omitted transport phase');
    check(failure?.details?.github_path?.includes('/git/commits'), 'mutation failure omitted GitHub API path');
    check(failure?.details?.github_request_id === 'REQ-TRANSPORT-21', 'mutation failure omitted GitHub request id');
    check(failure?.details?.retry_after === '2', 'mutation failure omitted Retry-After');
    check(failure?.details?.attempts === 1, 'mutation failure must not auto-retry');
    check(failure?.details?.may_have_mutated === true, 'mutation failure did not flag ambiguity boundary');
    check(calls === 1, `mutation transport must not retry automatically; observed ${calls} calls`);
  }));

  results.push(await run('22 consecutive mechanical cleanup commits must coalesce', async () => {
    const gh = new FakeGithub();
    gh.branches.set('agent/existing', gh.main);
    const first = await applyGithubChangeset(request({
      branch: 'agent/existing',
      expected_head: gh.main,
      commit_message: 'style: format first batch',
      changes: [{ path: 'README.md', operation: 'update', content: 'formatted readme' }],
    }), { github: gh });
    check(first.ok, 'first consolidated mechanical cleanup should be allowed');

    const second = await applyGithubChangeset(request({
      branch: 'agent/existing',
      expected_head: first.commit_sha,
      commit_message: 'style: format second batch',
      changes: [{ path: 'docs/existing.md', operation: 'update', content: 'formatted docs' }],
    }), { github: gh });
    check(!second.ok && second.error === 'MECHANICAL_CHANGESET_MUST_COALESCE', 'second consecutive mechanical cleanup must be rejected');
    check(gh.commitCreates === 1 && gh.branches.get('agent/existing') === first.commit_sha, 'rejected mechanical follow-up mutated the branch');

    const substantive = await applyGithubChangeset(request({
      branch: 'agent/existing',
      expected_head: first.commit_sha,
      commit_message: 'fix: repair operator behavior',
      changes: [{ path: 'docs/existing.md', operation: 'update', content: 'substantive repair' }],
    }), { github: gh });
    check(substantive.ok, 'substantive follow-up after a mechanical commit must remain allowed');
  }));

  results.push(await run('23 gzip-base64 text content is decoded before semantic normalization', async () => {
    const gh = new FakeGithub();
    const r = await applyGithubChangeset(request({ changes: [
      { path: 'new.txt', operation: 'create', content_gzip_base64: 'H4sIAFjEg2oC/8tIzcnJ5wIAIDA6NgYAAAA=' },
    ] }), { github: gh });
    check(r.ok, 'gzip-base64 changeset failed');
    const entry = gh.treeEntries.find(item => item.path === 'new.txt');
    check(entry?.content === 'hello\n', 'gzip-base64 content was not decoded to exact UTF-8 text');
  }));

  results.push(...await runGithubTextTransportSpec());

  const failed = results.filter(result => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results };
}