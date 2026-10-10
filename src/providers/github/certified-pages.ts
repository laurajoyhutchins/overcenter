import { canonicalDigest, sha256 } from '../../digest.ts';
import type { Observation } from '../../model.ts';

// Prospective provider evidence, deliberately outside the kernel's admitted
// observation union until a separately verified activation.
export type PagesObservation = Omit<Observation, 'verifier'> & {
  verifier: 'github-pages-static-tree-published/v1';
};
import { isData } from '../../validation.ts';
import { materializeGitHubOperationRequest } from './openapi.ts';
import { observeCertifiedGitHubRead200 } from './certified-observation.ts';
import { observeCertifiedGitHubRepository } from './certified-repository.ts';
import { observeCertifiedGitHubRefFence } from './certified-ref.ts';
import { GITHUB_OPENAPI_SHA256 } from './contract.ts';
import { PAGES_SETTINGS_OPERATION, PAGES_BUILD_OPERATION } from './pages-operations.generated.ts';
import {
  validatePagesPublication,
  validatePagesManifest,
  type PagesManifest,
  type GitHubPagesPublicationPostcondition,
} from './pages-contract.ts';
import { githubGetAsync, runGitHubReadObserverAsync, type GitHubJsonGetAsync } from './rest.ts';

export interface PagesObservationContext {
  token: string;
  get?: GitHubJsonGetAsync;
  readGitTree: (publication: GitHubPagesPublicationPostcondition) => Promise<PagesManifest>;
  readServedFile?: (url: string, maxDecodedBytes: number) => Promise<Uint8Array>;
  clock?: () => string;
}
export async function readPagesServedFile(
  url: string,
  maxDecodedBytes: number,
  request: typeof fetch = fetch,
): Promise<Uint8Array> {
  const response = await request(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (
    response.status !== 200 ||
    !response.body ||
    response.redirected ||
    (response.url && response.url !== url)
  )
    throw new Error('PAGES_SERVED_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxDecodedBytes) throw new Error('PAGES_SERVED_BYTE_BUDGET');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
export function pagesUncertain(
  p: GitHubPagesPublicationPostcondition,
  error: string,
): PagesObservation {
  return {
    verifier: p.verifier,
    provider: 'github',
    repository_id: p.repository_id,
    repository_full_name: p.repository_full_name,
    ref: p.destination_ref,
    commit_sha: p.publication_sha,
    expected_sha256: canonicalDigest(p),
    mutation_certainty: 'uncertain',
    observation_error: error,
  };
}
function settingsMatch(p: GitHubPagesPublicationPostcondition, value: unknown): boolean {
  if (!isData(value) || !isData(value.source)) return false;
  return (
    value.public === true &&
    value.build_type === 'legacy' &&
    value.html_url === p.site_base_url &&
    value.source.branch === p.destination_ref.slice('refs/heads/'.length) &&
    value.source.path === p.pages_source_path &&
    (value.cname === null || value.cname === new URL(p.site_base_url).hostname)
  );
}
export async function observePagesCoordinate(
  p: GitHubPagesPublicationPostcondition,
  context: { token: string; get: GitHubJsonGetAsync; clock: () => string },
) {
  return await runGitHubReadObserverAsync(
    context.token,
    (get) => {
      const repository = observeCertifiedGitHubRepository(context.token, {
        repositoryId: p.repository_id,
        repositoryFullName: p.repository_full_name,
        get,
        clock: context.clock,
        observerId: p.verifier,
      });
      const { owner, repo } = repository.fact.object;
      const request = materializeGitHubOperationRequest(PAGES_SETTINGS_OPERATION, { owner, repo });
      const read = observeCertifiedGitHubRead200({
        token: context.token,
        operation: PAGES_SETTINGS_OPERATION,
        request,
        fields: ['source.branch', 'source.path', 'html_url', 'build_type', 'cname', 'public'].map(
          (path) => ({ path }),
        ),
        get,
        clock: context.clock,
        observerId: 'github-pages-static-tree-published/v1',
      });
      if (!settingsMatch(p, read.certified.outcome.value)) throw new Error('PAGES_SETTINGS_DRIFT');
      return {
        repository_id: p.repository_id,
        repository_full_name: repository.fact.object.full_name,
        settings: read.certified,
      };
    },
    context.get,
  );
}
export async function observeCertifiedGitHubPagesPublication(
  p: GitHubPagesPublicationPostcondition,
  context: PagesObservationContext,
): Promise<PagesObservation> {
  try {
    validatePagesPublication(p);
    if (!context.token) throw new Error('GITHUB_TOKEN_UNAVAILABLE');
    let remaining = p.limits.max_observation_calls;
    const take = () => {
      if (--remaining < 0) throw new Error('PAGES_OBSERVATION_CALL_BUDGET');
    };
    const get: GitHubJsonGetAsync = async (token, path) => {
      take();
      return await (context.get ?? githubGetAsync)(token, path);
    };
    const clock = context.clock ?? (() => new Date().toISOString());
    const coordinate = () => observePagesCoordinate(p, { token: context.token, get, clock });
    const ref = async () => {
      const result = await runGitHubReadObserverAsync(
        context.token,
        (syncGet) => {
          // Prime outside the synchronous fence's error catcher so async acquisition
          // requests are not mistaken for provider read failures.
          syncGet(context.token, `/repos/${p.repository_full_name}`);
          syncGet(
            context.token,
            `/repos/${p.repository_full_name}/git/ref/${encodeURIComponent(p.destination_ref.slice(5))}`,
          );
          return observeCertifiedGitHubRefFence(context.token, {
            repositoryId: p.repository_id,
            repositoryFullName: p.repository_full_name,
            ref: p.destination_ref,
            expectedSha: p.publication_sha,
            get: syncGet,
            clock,
          });
        },
        get,
      );
      if (result.state !== 'CURRENT')
        throw new Error(
          `PAGES_PUBLICATION_REF_NOT_CURRENT:${result.observation_error ?? result.reason}`,
        );
      return result;
    };
    const first = await coordinate();
    const firstRef = await ref();
    take();
    const tree = await context.readGitTree(p);
    validatePagesManifest(tree, p.limits);
    if (tree.sha256 !== p.manifest.sha256) throw new Error('PAGES_PUBLICATION_TREE_MISMATCH');
    const build = await runGitHubReadObserverAsync(
      context.token,
      (syncGet) => {
        const [owner, repo] = p.repository_full_name.split('/');
        const request = materializeGitHubOperationRequest(PAGES_BUILD_OPERATION, {
          owner: owner!,
          repo: repo!,
        });
        return observeCertifiedGitHubRead200({
          token: context.token,
          operation: PAGES_BUILD_OPERATION,
          request,
          fields: ['url', 'commit', 'status', 'error.message'].map((path) => ({ path })),
          get: syncGet,
          clock,
          observerId: p.verifier,
        }).certified;
      },
      get,
    );
    const value = build.outcome.value;
    if (
      !isData(value) ||
      value.commit !== p.publication_sha ||
      value.status !== 'built' ||
      !isData(value.error) ||
      value.error.message !== null
    )
      throw new Error('PAGES_EXACT_BUILD_NOT_BUILT');
    const served = [];
    for (const file of p.manifest.files) {
      if (file.delivery === 'metadata') continue;
      take();
      const url = new URL(file.path, p.site_base_url).href;
      const bytes = await (context.readServedFile ?? readPagesServedFile)(url, file.bytes);
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
        throw new Error('PAGES_SERVED_BYTES_MISMATCH');
      served.push({ path: file.path, url, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const last = await coordinate();
    const lastRef = await ref();
    return {
      ...pagesUncertain(p, ''),
      mutation_certainty: 'present',
      actual_sha256: p.manifest.sha256,
      provider_evidence: {
        publication_sha256: canonicalDigest(p),
        first,
        first_ref: firstRef,
        tree,
        build,
        served,
        last,
        last_ref: lastRef,
      },
    };
  } catch (error: unknown) {
    return pagesUncertain(p, error instanceof Error ? error.message : 'PAGES_OBSERVATION_FAILED');
  }
}
export function githubPagesPublicationEvidenceMatches(
  p: GitHubPagesPublicationPostcondition,
  observed: PagesObservation | Observation,
): boolean {
  try {
    validatePagesPublication(p);
    const e = observed.provider_evidence;
    if (
      observed.verifier !== p.verifier ||
      observed.provider !== 'github' ||
      observed.repository_id !== p.repository_id ||
      observed.repository_full_name !== p.repository_full_name ||
      observed.ref !== p.destination_ref ||
      observed.commit_sha !== p.publication_sha ||
      observed.expected_sha256 !== canonicalDigest(p) ||
      observed.actual_sha256 !== p.manifest.sha256 ||
      observed.mutation_certainty !== 'present' ||
      !isData(e) ||
      e.publication_sha256 !== canonicalDigest(p)
    )
      return false;
    for (const key of ['first', 'last']) {
      const c = e[key];
      if (
        !isData(c) ||
        c.repository_id !== p.repository_id ||
        c.repository_full_name !== p.repository_full_name ||
        !isData(c.settings) ||
        !isData(c.settings.contract) ||
        c.settings.contract.schema_sha256 !== GITHUB_OPENAPI_SHA256 ||
        c.settings.contract.operation_id !== PAGES_SETTINGS_OPERATION.operation_id ||
        !isData(c.settings.outcome) ||
        !settingsMatch(p, c.settings.outcome.value)
      )
        return false;
    }
    for (const key of ['first_ref', 'last_ref']) {
      const r = e[key];
      if (
        !isData(r) ||
        r.state !== 'CURRENT' ||
        r.actual_sha !== p.publication_sha ||
        !isData(r.evidence) ||
        r.evidence.repository_id !== p.repository_id ||
        r.evidence.canonical_ref !== p.destination_ref ||
        r.evidence.actual_sha !== p.publication_sha
      )
        return false;
    }
    validatePagesManifest(e.tree, p.limits);
    if (
      e.tree.sha256 !== p.manifest.sha256 ||
      !isData(e.build) ||
      !isData(e.build.contract) ||
      e.build.contract.schema_sha256 !== GITHUB_OPENAPI_SHA256 ||
      e.build.contract.operation_id !== PAGES_BUILD_OPERATION.operation_id ||
      !isData(e.build.outcome) ||
      !isData(e.build.outcome.value)
    )
      return false;
    const b = e.build.outcome.value;
    if (
      b.commit !== p.publication_sha ||
      b.status !== 'built' ||
      !isData(b.error) ||
      b.error.message !== null ||
      !Array.isArray(e.served)
    )
      return false;
    const served = p.manifest.files.filter((file) => file.delivery === 'served');
    const reads = e.served;
    return (
      reads.length === served.length &&
      served.every((file, index) => {
        const read = reads[index];
        return (
          isData(read) &&
          read.path === file.path &&
          read.bytes === file.bytes &&
          read.sha256 === file.sha256 &&
          read.url === new URL(file.path, p.site_base_url).href
        );
      })
    );
  } catch {
    return false;
  }
}
