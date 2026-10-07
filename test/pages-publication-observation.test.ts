import assert from 'node:assert/strict';
import test from 'node:test';
import {
  observeCertifiedGitHubPagesPublication,
  githubPagesPublicationEvidenceMatches,
  readPagesServedFile,
} from '../src/providers/github/certified-pages.ts';

import { publication, pagesProvider } from './fixtures/pages-publication.ts';

test('exact build and all served bytes verify while metadata remains tree-only', async () => {
  const p = publication();
  const observed = await observeCertifiedGitHubPagesPublication(p, {
    token: 'fixture',
    get: pagesProvider(p),
    readGitTree: async () => p.manifest,
    readServedFile: async (url) => {
      assert.equal(url, 'https://acme.github.io/widget/index.html');
      return Buffer.from('abc');
    },
    clock: () => '2026-10-07T00:02:00Z',
  });
  assert.equal(observed.observation_error, '');
  assert.equal(
    githubPagesPublicationEvidenceMatches(p, { ...observed, verifier: 'file-content-equals/v1' }),
    false,
  );
  assert.equal(githubPagesPublicationEvidenceMatches(p, observed), true);
  assert.equal(
    githubPagesPublicationEvidenceMatches({ ...p, source_sha: 'f'.repeat(40) }, observed),
    false,
  );
  assert.equal(
    githubPagesPublicationEvidenceMatches(p, {
      ...observed,
      provider_evidence: { verified: true },
    }),
    false,
  );
});
test('old builds, settings drift, moved refs, and stale bytes cannot verify', async () => {
  const p = publication();
  for (const change of [{ old: true }, { failed: true }, { drift: true }, { moved: true }]) {
    const observed = await observeCertifiedGitHubPagesPublication(p, {
      token: 'fixture',
      get: pagesProvider(p, change),
      readGitTree: async () => p.manifest,
      readServedFile: async () => Buffer.from('abc'),
    });
    assert.equal(githubPagesPublicationEvidenceMatches(p, observed), false);
    assert.equal(observed.mutation_certainty, 'uncertain');
  }
  for (const bytes of ['xyz', 'abcd']) {
    const observed = await observeCertifiedGitHubPagesPublication(p, {
      token: 'fixture',
      get: pagesProvider(p),
      readGitTree: async () => p.manifest,
      readServedFile: async () => Buffer.from(bytes),
    });
    assert.equal(githubPagesPublicationEvidenceMatches(p, observed), false);
  }
  const limited = { ...p, limits: { ...p.limits, max_observation_calls: 1 } };
  assert.equal(
    githubPagesPublicationEvidenceMatches(
      limited,
      await observeCertifiedGitHubPagesPublication(limited, {
        token: 'fixture',
        get: pagesProvider(p),
        readGitTree: async () => p.manifest,
        readServedFile: async () => Buffer.from('abc'),
      }),
    ),
    false,
  );
});
test('served reads reject redirects and enforce decoded byte bounds', async () => {
  await assert.rejects(
    readPagesServedFile(
      'https://acme.github.io/widget/index.html',
      3,
      async () => new Response('', { status: 302, headers: { location: 'https://other.test/' } }),
    ),
  );
  await assert.rejects(
    readPagesServedFile(
      'https://acme.github.io/widget/index.html',
      3,
      async () => new Response('abcd'),
    ),
  );
  assert.deepEqual(
    await readPagesServedFile(
      'https://acme.github.io/widget/index.html',
      3,
      async () => new Response('abc'),
    ),
    Buffer.from('abc'),
  );
});
