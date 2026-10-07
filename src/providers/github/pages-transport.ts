import { pagesGit, pagesGitText } from './pages-git.ts';
import { isAbsolute, join, resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

export interface PagesPushRequest {
  repository_full_name: string;
  destination_ref: string;
  expected_head_sha: string | null;
  publication_sha: string;
}
export function createPagesGitPush(
  repo: string,
  remote: string,
  credentialEnvironment: Record<string, string> = {},
): (request: PagesPushRequest) => Promise<void> {
  if (remote.startsWith('-') || remote.includes('\0')) throw new Error('PAGES_GIT_REMOTE_INVALID');
  if (!remote.startsWith('https:') && !isAbsolute(remote))
    throw new Error('PAGES_GIT_REMOTE_INVALID');
  if (/^https?:/.test(remote)) {
    const url = new URL(remote);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      throw new Error('PAGES_GIT_REMOTE_INVALID');
  }
  return async (request) => {
    if (
      remote.startsWith('https:') &&
      new URL(remote).pathname !== `/${request.repository_full_name}.git`
    )
      throw new Error('PAGES_GIT_REPOSITORY_MISMATCH');
    if (
      request.destination_ref !== 'refs/heads/gh-pages' ||
      !/^[0-9a-f]{40}$/.test(request.publication_sha) ||
      (request.expected_head_sha !== null && !/^[0-9a-f]{40}$/.test(request.expected_head_sha))
    )
      throw new Error('PAGES_GIT_PUSH_COORDINATE_INVALID');
    const transport = await mkdtemp(join(tmpdir(), 'pages-transport-'));
    try {
      // An empty transport repository cannot inherit source-local URL rewrites,
      // followTags, hooks, signing, or replacement refs. Only objects are shared.
      pagesGit(transport, ['init', '--bare', '--quiet']);
      const objectDirectory = resolve(
        repo,
        pagesGitText(repo, ['rev-parse', '--git-path', 'objects']),
      );
      pagesGit(
        transport,
        [
          'push',
          '--porcelain',
          '--no-follow-tags',
          `--force-with-lease=${request.destination_ref}:${request.expected_head_sha ?? ''}`,
          remote,
          `${request.publication_sha}:${request.destination_ref}`,
        ],
        undefined,
        { ...credentialEnvironment, GIT_OBJECT_DIRECTORY: objectDirectory },
      );
    } catch {
      throw new Error('PAGES_GIT_PUSH_FAILED');
    } finally {
      await rm(transport, { recursive: true, force: true });
    }
  };
}
