import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { OvercenterKernel } from '../src/authority/kernel.ts';
import { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../src/effect-adapter.ts';
import {
  performGitHubPullRequestPublicationEffect,
  type GitHubPullRequestPost,
} from '../src/providers/github/pr-publication-effect.ts';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const HEAD_REF = 'refs/heads/overcenter/candidate/run-1';

function repository() {
  return {
    id: 42,
    node_id: 'R_42',
    full_name: 'acme/widget',
    name: 'widget',
    owner: { login: 'acme' },
  };
}

function ref(refName: string, sha: string) {
  return { ref: refName, object: { type: 'commit', sha } };
}

function pull() {
  return {
    id: 3700,
    node_id: 'PR_node_37',
    number: 37,
    state: 'open',
    title: 'Overcenter verified candidate aaaaaaaaaaaa',
    user: { login: 'acme' },
    head: { sha: HEAD },
    base: { ref: 'main', sha: BASE },
    updated_at: '2026-10-05T00:00:00Z',
  };
}

function define(kernel: OvercenterKernel) {
  kernel.initialize();
  kernel.define({
    id: 'publish-pr',
    packet: { effect_contract: GITHUB_SOURCE_INTEGRATION_EFFECT },
    postcondition: {
      verifier: 'source-integration/v1',
      provider: 'github',
      repository_id: 42,
      repository_full_name: 'acme/widget',
      ref: HEAD_REF,
      commit_sha: HEAD,
      base_ref: 'main',
      expected_base_sha: BASE,
    },
  });
  const ready = kernel.deriveReadyWork();
  assert.ok(ready);
  return kernel.claim(ready.id, ready.revision);
}

function getProvider(published: () => boolean, headSha = HEAD, baseSha = BASE) {
  return async (_token: string, path: string): Promise<unknown> => {
    if (path === '/repos/acme/widget') return repository();
    if (path.includes('/git/ref/')) {
      const decoded = decodeURIComponent(path);
      if (decoded.endsWith('heads/overcenter/candidate/run-1')) return ref(HEAD_REF, headSha);
      if (decoded.endsWith('heads/main')) return ref('refs/heads/main', baseSha);
    }
    if (path.startsWith('/repos/acme/widget/pulls?')) return published() ? [pull()] : [];
    throw new Error('unexpected provider path: ' + path);
  };
}

test('PR publication reuses admitted source effect, reserves before POST, and settles from readback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'source-pr-publication-'));
  let published = false;
  const get = getProvider(() => published);
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'), {
    githubToken: 'token',
    observationContext: { githubGetAsync: get },
  });

  try {
    const permit = define(kernel);
    const post: GitHubPullRequestPost = async (_token, path, body) => {
      assert.equal(kernel.hasUnresolvedEffect(permit.id), true);
      assert.equal(path, '/repos/acme/widget/pulls');
      assert.deepEqual(body, {
        title: 'Overcenter verified candidate aaaaaaaaaaaa',
        head: 'overcenter/candidate/run-1',
        base: 'main',
      });
      published = true;
      return { status: 201, body: '{}' };
    };

    await performGitHubPullRequestPublicationEffect(kernel, permit, {
      token: 'token',
      get,
      post,
    });
    const settled = await kernel.resolveAsync(permit);
    assert.equal(settled.disposition, 'DONE');
    assert.equal(settled.verified, true);
    assert.equal(kernel.hasUnresolvedEffect(permit.id), false);
    assert.equal(settled.observed?.pull_number, 37);
    assert.equal(settled.observed?.actual_head_sha, HEAD);
    assert.equal(settled.observed?.expected_base_sha, BASE);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('timeout after PR creation reconciles to DONE without a second mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'source-pr-publication-timeout-'));
  let published = false;
  let posts = 0;
  const get = getProvider(() => published);
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'), {
    githubToken: 'token',
    observationContext: { githubGetAsync: get },
  });

  try {
    const permit = define(kernel);
    await assert.rejects(
      performGitHubPullRequestPublicationEffect(kernel, permit, {
        token: 'token',
        get,
        post: async () => {
          posts += 1;
          published = true;
          throw new Error('transport timeout');
        },
      }),
      /transport timeout/,
    );
    assert.equal(posts, 1);
    assert.equal(kernel.hasUnresolvedEffect(permit.id), true);

    const settled = await kernel.resolveAsync(permit);
    assert.equal(settled.disposition, 'DONE');
    assert.equal(settled.verified, true);
    assert.equal(posts, 1);
    assert.equal(kernel.hasUnresolvedEffect(permit.id), false);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale head fails before reservation and POST', async () => {
  const root = mkdtempSync(join(tmpdir(), 'source-pr-publication-stale-'));
  let posts = 0;
  const get = getProvider(() => false, OTHER);
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));

  try {
    const permit = define(kernel);
    await assert.rejects(
      performGitHubPullRequestPublicationEffect(kernel, permit, {
        token: 'token',
        get,
        post: async () => {
          posts += 1;
          return { status: 201, body: '{}' };
        },
      }),
      /SOURCE_PR_PUBLICATION_HEAD_NOT_CURRENT/,
    );
    assert.equal(posts, 0);
    assert.equal(kernel.hasUnresolvedEffect(permit.id), false);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale base fails before reservation and POST', async () => {
  const root = mkdtempSync(join(tmpdir(), 'source-pr-publication-stale-base-'));
  let posts = 0;
  const get = getProvider(() => false, HEAD, OTHER);
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));

  try {
    const permit = define(kernel);
    await assert.rejects(
      performGitHubPullRequestPublicationEffect(kernel, permit, {
        token: 'token',
        get,
        post: async () => {
          posts += 1;
          return { status: 201, body: '{}' };
        },
      }),
      /SOURCE_PR_PUBLICATION_BASE_NOT_CURRENT/,
    );
    assert.equal(posts, 0);
    assert.equal(kernel.hasUnresolvedEffect(permit.id), false);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('duplicate exact PR readback remains recovery-required', async () => {
  const root = mkdtempSync(join(tmpdir(), 'source-pr-publication-duplicate-'));
  let published = false;
  const baseGet = getProvider(() => published);
  const get = async (token: string, path: string): Promise<unknown> => {
    if (path.startsWith('/repos/acme/widget/pulls?') && published) {
      return [
        pull(),
        { ...pull(), id: 3701, node_id: 'PR_node_38', number: 38 },
      ];
    }
    return baseGet(token, path);
  };
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'), {
    githubToken: 'token',
    observationContext: { githubGetAsync: get },
  });

  try {
    const permit = define(kernel);
    await performGitHubPullRequestPublicationEffect(kernel, permit, {
      token: 'token',
      get,
      post: async () => {
        published = true;
        return { status: 201, body: '{}' };
      },
    });
    const receipt = await kernel.resolveAsync(permit);
    assert.equal(receipt.disposition, 'RECOVERY_REQUIRED');
    assert.equal(receipt.verified, false);
    assert.equal(kernel.hasUnresolvedEffect(permit.id), true);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ambiguous create with no observed PR remains recovery-required', async () => {
  const root = mkdtempSync(join(tmpdir(), 'source-pr-publication-recovery-'));
  const get = getProvider(() => false);
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'), {
    githubToken: 'token',
    observationContext: { githubGetAsync: get },
  });

  try {
    const permit = define(kernel);
    await assert.rejects(
      performGitHubPullRequestPublicationEffect(kernel, permit, {
        token: 'token',
        get,
        post: async () => {
          throw new Error('transport timeout');
        },
      }),
      /transport timeout/,
    );
    const receipt = await kernel.resolveAsync(permit);
    assert.equal(receipt.disposition, 'RECOVERY_REQUIRED');
    assert.equal(receipt.verified, false);
    assert.equal(kernel.hasUnresolvedEffect(permit.id), true);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});
