import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OvercenterKernel } from '../src/authority/kernel.ts';
import { dispatchAdmittedEffect } from '../src/providers/effect-dispatch.ts';
import {
  writePagesGitTree,
  pagesGit,
  pagesGitText,
  readPagesGitManifest,
} from '../src/providers/github/pages-git.ts';
import { publication, pagesProvider } from './fixtures/pages-publication.ts';

test('reserved publication settles by independent readback and crash recovery never pushes twice', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pages-kernel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const objectRepo = join(root, 'objects.git');
  execFileSync('git', ['init', '--bare', '-q', objectRepo]);
  const files = join(root, 'files');
  await mkdir(files);
  await writeFile(join(files, '.nojekyll'), '');
  await writeFile(join(files, 'index.html'), 'abc');
  const p = publication();
  p.publication_tree_sha = await writePagesGitTree(
    objectRepo,
    files,
    p.manifest,
    join(root, 'index'),
  );
  p.publication_sha = pagesGit(objectRepo, ['commit-tree', p.publication_tree_sha], 'publication', {
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.test',
  })
    .toString('utf8')
    .trim();
  const db = join(root, 'authority.sqlite');
  let pushes = 0;
  let pending = false;
  let provider = pagesProvider(p);
  const options = {
    githubToken: 'fixture',
    observationContext: {
      pages: {
        get: async (token: string, path: string) => {
          if (pending && path.endsWith('/pages/builds/latest')) throw new Error('build pending');
          return await provider(token, path);
        },
        readGitTree: async () => {
          assert.equal(
            pagesGitText(objectRepo, ['rev-parse', `${p.publication_sha}^{tree}`]),
            p.publication_tree_sha,
          );
          return readPagesGitManifest(objectRepo, p.publication_tree_sha, p.limits);
        },
        readServedFile: async () => Buffer.from('abc'),
      },
    },
  };
  let kernel = new OvercenterKernel(db, options);
  t.after(() => kernel.close());
  kernel.initialize();
  kernel.define({
    id: 'publish',
    dependencies: [],
    packet: { effect_contract: 'github-pages/publish-static-tree/v1' },
    postcondition: p,
  });
  const ready = kernel.deriveReadyWork();
  assert.ok(ready);
  const permit = kernel.claim(ready.id, ready.revision);
  const context = {
    pages: {
      token: 'fixture',
      object_repo: objectRepo,
      get: pagesProvider(p),
      destination: {
        repository_id: 42,
        repository_full_name: 'acme/widget',
        destination_ref: p.destination_ref,
        default_ref: p.source_ref,
        site_base_url: p.site_base_url,
      },
      pushWithExpectedHead: async () => {
        assert.equal(kernel.hasUnresolvedEffect(permit.id), true);
        pushes++;
      },
    },
  };
  await dispatchAdmittedEffect(kernel, permit, context);
  await assert.rejects(dispatchAdmittedEffect(kernel, permit, context));
  assert.equal(pushes, 1);
  kernel.close();
  kernel = new OvercenterKernel(db, options);
  kernel.recoverInterrupted(permit);
  pending = true;
  const uncertain = await kernel.resolveAsync(permit);
  assert.notEqual(uncertain.disposition, 'DONE');
  pending = false;
  provider = pagesProvider(p, { moved: true });
  assert.notEqual((await kernel.resolveAsync(permit)).disposition, 'DONE');
  provider = pagesProvider(p);
  const settled = await kernel.resolveAsync(permit);
  assert.equal(settled.disposition, 'DONE');
  assert.equal(kernel.inspect()[0]?.status, 'DONE');
  assert.equal(pushes, 1);
});

test('raw commit parent checks reject graft-hidden ancestry before transport', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pages-graft-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const objects = join(root, 'objects.git');
  execFileSync('git', ['init', '--bare', '-q', objects]);
  const files = join(root, 'files');
  await mkdir(files);
  await writeFile(join(files, '.nojekyll'), '');
  await writeFile(join(files, 'index.html'), 'abc');
  const p = publication();
  p.publication_tree_sha = await writePagesGitTree(objects, files, p.manifest, join(root, 'index'));
  const env = {
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.test',
  };
  const parent = pagesGit(objects, ['commit-tree', p.publication_tree_sha], 'parent', env)
    .toString()
    .trim();
  p.publication_sha = pagesGit(
    objects,
    ['commit-tree', p.publication_tree_sha, '-p', parent],
    'child',
    env,
  )
    .toString()
    .trim();
  await writeFile(join(objects, 'info/grafts'), `${p.publication_sha}\n`);
  const kernel = new OvercenterKernel(join(root, 'authority.sqlite'));
  t.after(() => kernel.close());
  kernel.initialize();
  kernel.define({
    id: 'grafted',
    dependencies: [],
    packet: { effect_contract: 'github-pages/publish-static-tree/v1' },
    postcondition: p,
  });
  const ready = kernel.deriveReadyWork();
  assert.ok(ready);
  const permit = kernel.claim(ready.id, ready.revision);
  let pushes = 0;
  await assert.rejects(
    dispatchAdmittedEffect(kernel, permit, {
      pages: {
        token: 'fixture',
        object_repo: objects,
        get: pagesProvider(p),
        destination: {
          repository_id: 42,
          repository_full_name: 'acme/widget',
          destination_ref: p.destination_ref,
          default_ref: p.source_ref,
          site_base_url: p.site_base_url,
        },
        pushWithExpectedHead: async () => {
          pushes++;
        },
      },
    }),
    /PAGES_PUBLICATION_PARENT_MISMATCH/,
  );
  assert.equal(pushes, 0);
});
