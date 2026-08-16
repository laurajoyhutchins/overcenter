import { applyGithubChangeset, GitHubChangesetError } from 'lib/github-apply-changeset.js';

function sha(seed) {
  return String(seed).padStart(40, '0').slice(-40).replace(/[^0-9a-f]/g, 'a');
}

class MemoryReceipts {
  constructor() { this.rows = new Map(); }
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
  async succeed(n, receipt) { Object.assign(this.rows.get(this.key(n)), { state: 'succeeded', receipt }); }
  async abandon(n) { this.rows.delete(this.key(n)); }
}

class FakeGithub {
  constructor() {
    this.blobSeq = 20;
    this.treeSeq = 30;
    this.commitSeq = 40;
    this.commitCreates = 0;
    this.refMutations = 0;
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
  async createBlob(repo, content) { this.blobSeq += 1; return sha(this.blobSeq); }
  async createTree(repo, baseTreeSha, entries) {
    const next = new Map(this.trees.get(baseTreeSha) || []);
    for (const entry of entries) {
      if (entry.sha === null) next.delete(entry.path);
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
    branch: 'agent/test-change',
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

  results.push(await run('12 target branch creation race', async () => {
    const gh = new FakeGithub();
    gh.beforeFinal = async (g, kind, branch) => { if (kind === 'create') g.branches.set(branch, sha(777)); };
    const r = await applyGithubChangeset(request(), { github: gh });
    check(!r.ok && r.error === 'BRANCH_CREATION_RACE', 'branch creation race not detected');
    check(gh.branches.get('agent/test-change') === sha(777), 'concurrent branch was overwritten');
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

  const failed = results.filter(result => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results };
}