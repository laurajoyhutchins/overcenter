import { canonicalDigest, sha256 } from '../../src/digest.ts';
import type { GitHubPagesPublicationPostcondition } from '../../src/providers/github/pages-contract.ts';

export function publication(): GitHubPagesPublicationPostcondition {
  const body = {
    files: [
      { path: '.nojekyll', bytes: 0, sha256: sha256(''), delivery: 'metadata' as const },
      { path: 'index.html', bytes: 3, sha256: sha256('abc'), delivery: 'served' as const },
    ],
    file_count: 2,
    total_bytes: 3,
  };
  return {
    verifier: 'github-pages-static-tree-published/v1',
    provider: 'github',
    repository_id: 42,
    repository_full_name: 'acme/widget',
    source_sha: 'a'.repeat(40),
    source_tree_sha: 'b'.repeat(40),
    source_ref: 'refs/heads/main',
    destination_ref: 'refs/heads/gh-pages',
    expected_head_sha: null,
    publication_sha: 'c'.repeat(40),
    publication_tree_sha: 'd'.repeat(40),
    site_base_url: 'https://acme.github.io/widget/',
    pages_source_path: '/',
    manifest: { ...body, sha256: canonicalDigest(body) },
    limits: { max_files: 10, max_total_bytes: 100, max_observation_calls: 40 },
  };
}
export function pagesProvider(
  p: GitHubPagesPublicationPostcondition,
  change: { old?: boolean; failed?: boolean; drift?: boolean; moved?: boolean } = {},
) {
  let settingReads = 0;
  let refReads = 0;
  return async (_token: string, path: string): Promise<unknown> => {
    if (path === '/repos/acme/widget')
      return {
        id: 42,
        node_id: 'R_42',
        full_name: 'acme/widget',
        name: 'widget',
        default_branch: 'main',
        owner: { login: 'acme' },
      };
    if (path.endsWith('/git/ref/heads%2Fgh-pages'))
      return {
        ref: 'refs/heads/gh-pages',
        node_id: 'REF',
        url: 'https://api.github.com/ref',
        object: {
          type: 'commit',
          sha: change.moved && ++refReads > 1 ? 'f'.repeat(40) : p.publication_sha,
          url: 'https://api.github.com/commit',
        },
      };
    if (path.endsWith('/pages'))
      return {
        url: 'https://api.github.com/repos/acme/widget/pages',
        status: 'built',
        cname: null,
        custom_404: false,
        public: true,
        html_url: change.drift && ++settingReads > 1 ? 'https://example.test/' : p.site_base_url,
        build_type: 'legacy',
        source: { branch: 'gh-pages', path: '/' },
      };
    if (path.endsWith('/pages/builds/latest'))
      return {
        url: 'https://api.github.com/repos/acme/widget/pages/builds/7',
        status: change.failed ? 'errored' : 'built',
        commit: change.old ? 'e'.repeat(40) : p.publication_sha,
        error: { message: null },
        pusher: null,
        duration: 10,
        created_at: '2026-10-07T00:00:00Z',
        updated_at: '2026-10-07T00:01:00Z',
      };
    throw new Error(`Unexpected path: ${path}`);
  };
}
