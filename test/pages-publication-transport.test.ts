import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createPagesGitPush,
  performGitHubPagesPublicationEffect,
  type PagesPublicationAuthority,
} from '../src/providers/github/pages-effect.ts';
import { pagesGitText } from '../src/providers/github/pages-git.ts';
import { OvercenterKernel } from '../src/authority/kernel.ts';
import { publication, pagesProvider } from './fixtures/pages-publication.ts';

test('explicit Git lease rejects competing updates and initial creation races', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pages-lease-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const local = join(root, 'local.git');
  const git = (repo: string, args: string[], input?: string) =>
    execFileSync('git', ['-C', repo, ...args], { input, encoding: 'utf8', stdio: 'pipe' }).trim();
  execFileSync('git', ['init', '--bare', '-q', remote]);
  execFileSync('git', ['init', '--bare', '-q', local]);
  git(local, ['config', 'user.name', 'Fixture']);
  git(local, ['config', 'user.email', 'fixture@example.test']);
  const tree = git(local, ['mktree'], '');
  const a = git(local, ['commit-tree', tree], 'A');
  const b = git(local, ['commit-tree', tree, '-p', a], 'B');
  const c = git(local, ['commit-tree', tree, '-p', a], 'C');
  git(local, ['replace', a, b]);
  assert.equal(pagesGitText(local, ['rev-list', '--parents', '-n', '1', a]), a);
  git(local, ['replace', '-d', a]);
  git(local, ['config', 'push.followTags', 'true']);
  git(local, ['tag', '-a', 'authority-tag', '-m', 'must not escape', a]);
  const push = createPagesGitPush(local, remote);
  await push({
    repository_full_name: 'acme/widget',
    destination_ref: 'refs/heads/gh-pages',
    expected_head_sha: null,
    publication_sha: a,
  });
  assert.equal(git(remote, ['for-each-ref', '--format=%(refname)']), 'refs/heads/gh-pages');
  await assert.rejects(
    push({
      repository_full_name: 'acme/widget',
      destination_ref: 'refs/heads/gh-pages',
      expected_head_sha: null,
      publication_sha: b,
    }),
  );
  await push({
    repository_full_name: 'acme/widget',
    destination_ref: 'refs/heads/gh-pages',
    expected_head_sha: a,
    publication_sha: b,
  });
  git(local, ['update-ref', 'refs/remotes/origin/gh-pages', b]);
  await assert.rejects(
    push({
      repository_full_name: 'acme/widget',
      destination_ref: 'refs/heads/gh-pages',
      expected_head_sha: a,
      publication_sha: c,
    }),
  );
  assert.equal(git(remote, ['rev-parse', 'refs/heads/gh-pages']), b);
  await assert.rejects(
    push({
      repository_full_name: 'acme/widget',
      destination_ref: 'refs/heads/main',
      expected_head_sha: null,
      publication_sha: a,
    }),
  );
});
test('forged authority cannot reach publication transport', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pages-forged-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const kernel = new OvercenterKernel(join(root, 'authority.sqlite'));
  t.after(() => kernel.close());
  let mutations = 0;
  const p = publication();
  await assert.rejects(
    performGitHubPagesPublicationEffect(kernel, { postcondition: p } as PagesPublicationAuthority, {
      token: 'fixture',
      get: pagesProvider(p),
      destination: {
        repository_id: 42,
        repository_full_name: 'acme/widget',
        destination_ref: 'refs/heads/gh-pages',
        default_ref: 'refs/heads/main',
        site_base_url: p.site_base_url,
      },
      object_repo: root,
      pushWithExpectedHead: async () => {
        mutations++;
      },
    }),
  );
  assert.equal(mutations, 0);
});

test('HTTPS transport rejects repository retargeting before Git runs', async () => {
  const push = createPagesGitPush('/does-not-exist', 'https://github.com/other/widget.git');
  await assert.rejects(
    push({
      repository_full_name: 'acme/widget',
      destination_ref: 'refs/heads/gh-pages',
      expected_head_sha: null,
      publication_sha: 'a'.repeat(40),
    }),
    /PAGES_GIT_REPOSITORY_MISMATCH/,
  );
  assert.throws(
    () => createPagesGitPush('/does-not-exist', 'https://user:secret@github.com/acme/widget.git'),
    /PAGES_GIT_REMOTE_INVALID/,
  );
});
