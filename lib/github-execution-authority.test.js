import { applyGithubChangeset } from 'lib/github-apply-changeset.js';

function sha(seed) {
  return String(seed).padStart(40, '0').slice(-40).replace(/[^0-9a-f]/g, 'a');
}

class FakeGithub {
  constructor() {
    this.main = sha(2);
    this.commitCreates = 0;
    this.refMutations = 0;
  }

  async resolveCommit() { return { sha: this.main, tree_sha: sha(1) }; }
  async getBranch() { return null; }
  async getPathEntries(repo, treeSha, paths) { return new Map(paths.map(path => [path, null])); }
  async createTree() { return sha(3); }
  async createCommit() { this.commitCreates += 1; return sha(4); }
  async createBranch() { this.refMutations += 1; }
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function run(name, fn) {
  try { await fn(); return { name, ok: true }; }
  catch (error) { return { name, ok: false, error: String(error?.message || error) }; }
}

export async function runGithubExecutionAuthorityTests() {
  const results = [];

  results.push(await run('changeset without execution authority fails before GitHub mutation', async () => {
    const github = new FakeGithub();
    const result = await applyGithubChangeset({
      repo: 'laurajoyhutchins/test',
      base_ref: 'main',
      branch: 'feat/authority-required',
      changes: [{ path: 'new.txt', operation: 'create', content: 'hello\n' }],
      commit_message: 'Apply unauthorized fixture changeset',
    }, { github });

    check(result.ok === false, 'changeset without execution authority unexpectedly succeeded');
    check(result.error === 'EXECUTION_AUTHORITY_REQUIRED', `expected EXECUTION_AUTHORITY_REQUIRED, observed ${result.error || 'success'}`);
    check(github.commitCreates === 0, 'unauthorized changeset created a commit');
    check(github.refMutations === 0, 'unauthorized changeset mutated a ref');
  }));

  const failed = results.filter(result => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results };
}