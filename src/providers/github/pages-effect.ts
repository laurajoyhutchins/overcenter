import type { EffectAuthority, KernelCore } from '../../authority/engine.ts';
import type { Data } from '../../model.ts';
import { validatePagesPublication } from './pages-contract.ts';
import { pagesGitText, readPagesGitManifest } from './pages-git.ts';
import { observePagesCoordinate } from './certified-pages.ts';
import { githubGetAsync, type GitHubJsonGetAsync } from './rest.ts';
import type { PagesPushRequest } from './pages-transport.ts';
export { createPagesGitPush } from './pages-transport.ts';

export type PagesPublicationAuthority = EffectAuthority<
  'github-pages/publish-static-tree/v1',
  'github-pages-static-tree-published/v1'
>;
export interface PagesEffectContext {
  token: string;
  destination: {
    repository_id: number;
    repository_full_name: string;
    destination_ref: string;
    default_ref: string;
    site_base_url: string;
  };
  object_repo: string;
  pushWithExpectedHead: (request: PagesPushRequest) => Promise<void>;
  get?: GitHubJsonGetAsync;
  clock?: () => string;
}
export async function performGitHubPagesPublicationEffect(
  kernel: KernelCore,
  authority: PagesPublicationAuthority,
  context: PagesEffectContext,
): Promise<Data> {
  return await kernel.performEffect(authority, async () => {
    const p = authority.postcondition;
    validatePagesPublication(p);
    const destination = context.destination;
    if (!context.token) throw new Error('GITHUB_TOKEN_UNAVAILABLE');
    if (
      destination.repository_id !== p.repository_id ||
      destination.repository_full_name !== p.repository_full_name ||
      destination.destination_ref !== p.destination_ref ||
      destination.site_base_url !== p.site_base_url ||
      destination.default_ref === p.destination_ref ||
      p.source_ref === p.destination_ref
    )
      throw new Error('PAGES_DESTINATION_NOT_ADMITTED');
    if (
      pagesGitText(context.object_repo, ['rev-parse', `${p.publication_sha}^{tree}`]) !==
        p.publication_tree_sha ||
      readPagesGitManifest(context.object_repo, p.publication_tree_sha, p.limits).sha256 !==
        p.manifest.sha256
    )
      throw new Error('PAGES_PUBLICATION_OBJECT_MISMATCH');
    // Revision walkers honor grafts and shallow boundaries. Authority binds the
    // raw immutable commit headers instead.
    const headers = pagesGitText(context.object_repo, [
      'cat-file',
      'commit',
      p.publication_sha,
    ]).split('\n\n', 1)[0]!;
    const parent = headers
      .split('\n')
      .filter((line) => line.startsWith('parent '))
      .map((line) => line.slice(7));
    if (
      parent.length !== (p.expected_head_sha === null ? 0 : 1) ||
      (p.expected_head_sha !== null && parent[0] !== p.expected_head_sha)
    )
      throw new Error('PAGES_PUBLICATION_PARENT_MISMATCH');
    await observePagesCoordinate(p, {
      token: context.token,
      get: context.get ?? githubGetAsync,
      clock: context.clock ?? (() => new Date().toISOString()),
    });
    await context.pushWithExpectedHead({
      repository_full_name: p.repository_full_name,
      destination_ref: p.destination_ref,
      expected_head_sha: p.expected_head_sha,
      publication_sha: p.publication_sha,
    });
    return {
      repository_id: p.repository_id,
      repository_full_name: p.repository_full_name,
      publication_sha: p.publication_sha,
      publication_tree_sha: p.publication_tree_sha,
      manifest_sha256: p.manifest.sha256,
    };
  });
}
