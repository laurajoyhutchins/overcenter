import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  runConfinedWorker,
  type ConfinedWorkerLaunch,
} from '../../src/execution/confined-executor.ts';
import {
  trustedSourceProof,
  type TrustedSourceProofWitness,
} from '../../src/source/source-proof-admission.ts';
import {
  sourceTransactionPlanDigest,
  type SourceTransactionPlan,
} from '../../src/source/transaction.ts';
import {
  manifestStaticTree,
  validatePagesPublication,
  type PagesPublication,
} from '../../src/providers/github/pages-contract.ts';
import {
  copyPagesSource,
  pagesGit,
  pagesGitText,
  readPagesGitManifest,
  writePagesGitTree,
} from '../../src/providers/github/pages-git.ts';

export interface PagesPreparationInput {
  source_repo: string;
  scratch_root: string;
  source_plan: SourceTransactionPlan;
  source_proof: TrustedSourceProofWitness;
  source_ref: string;
  destination_ref: string;
  expected_head_sha: string | null;
  site_base_url: string;
  limits: PagesPublication['limits'];
  commit_metadata: { author_name: string; author_email: string; timestamp: string };
}
export interface PagesBuildContext {
  // Trusted acquisition injection for tests or an already confined executor.
  runBuild?: (workspace: string) => Promise<void>;
  confinement?: Omit<ConfinedWorkerLaunch, 'manifest'> & {
    program: string;
    runtime_read_only: string[];
    runtime_executable: string[];
  };
}
async function build(workspace: string, context: PagesBuildContext): Promise<void> {
  if (context.runBuild) {
    await context.runBuild(workspace);
    return;
  }
  const config = context.confinement;
  if (!config) throw new Error('PAGES_CONFINED_BUILD_REQUIRED');
  const identity = await stat(workspace, { bigint: true });
  const result = await runConfinedWorker({
    launcher: config.launcher,
    ...(config.launcher_args ? { launcher_args: config.launcher_args } : {}),
    cgroup_parent: config.cgroup_parent,
    manifest: {
      task_id: 'pages-build',
      workspace,
      workspace_dev: identity.dev.toString(),
      workspace_ino: identity.ino.toString(),
      program: config.program,
      args: ['--experimental-strip-types', 'examples/site/build.ts'],
      environment: {},
      timeout_ms: 60000,
      max_output_bytes: 65536,
      memory_max_bytes: '536870912',
      pids_max: '64',
      cpu_quota_us: '100000',
      cpu_period_us: '100000',
      runtime_read_only: config.runtime_read_only,
      runtime_executable: config.runtime_executable,
    },
  });
  if (result.exit_code !== 0 || result.signal) throw new Error('PAGES_CONFINED_BUILD_FAILED');
}
export async function prepareSitePublication(
  input: PagesPreparationInput,
  context: PagesBuildContext = {},
): Promise<PagesPublication> {
  const proof = trustedSourceProof(input.source_proof);
  const plan = input.source_plan;
  if (
    proof.plan_digest !== sourceTransactionPlanDigest(plan) ||
    proof.candidate_sha !== plan.candidate_sha ||
    proof.tree_sha !== plan.candidate_tree ||
    pagesGitText(input.source_repo, ['rev-parse', `${proof.candidate_sha}^{tree}`]) !==
      proof.tree_sha
  ) {
    throw new Error('PAGES_SOURCE_PROOF_BINDING_MISMATCH');
  }
  const meta = input.commit_metadata;
  if (
    ![meta.author_name, meta.author_email].every((value) => value && !/[\r\n<>\0]/.test(value)) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(meta.timestamp) ||
    !Number.isFinite(Date.parse(meta.timestamp))
  )
    throw new Error('PAGES_COMMIT_METADATA_INVALID');
  const temp = await mkdtemp(join(resolve(input.scratch_root), 'pages-build-'));
  try {
    const workspaces = [join(temp, 'first'), join(temp, 'second')];
    for (const workspace of workspaces) {
      await mkdir(workspace);
      await copyPagesSource(input.source_repo, proof.candidate_sha, workspace);
      await build(workspace, context);
    }
    const root = join(workspaces[0]!, '.overcenter-build/site');
    const manifest = await manifestStaticTree(root, input.limits);
    const repeated = await manifestStaticTree(
      join(workspaces[1]!, '.overcenter-build/site'),
      input.limits,
    );
    if (manifest.sha256 !== repeated.sha256) throw new Error('PAGES_BUILD_NOT_REPRODUCIBLE');
    const tree = await writePagesGitTree(input.source_repo, root, manifest, join(temp, 'index'));
    if (readPagesGitManifest(input.source_repo, tree, input.limits).sha256 !== manifest.sha256)
      throw new Error('PAGES_GIT_MANIFEST_MISMATCH');
    const env = {
      GIT_AUTHOR_NAME: meta.author_name,
      GIT_AUTHOR_EMAIL: meta.author_email,
      GIT_AUTHOR_DATE: meta.timestamp,
      GIT_COMMITTER_NAME: meta.author_name,
      GIT_COMMITTER_EMAIL: meta.author_email,
      GIT_COMMITTER_DATE: meta.timestamp,
    };
    const sha = pagesGit(
      input.source_repo,
      ['commit-tree', tree, ...(input.expected_head_sha ? ['-p', input.expected_head_sha] : [])],
      `Publish static projection of ${proof.candidate_sha}\nmanifest ${manifest.sha256}\n`,
      env,
    )
      .toString('utf8')
      .trim();
    const publication: PagesPublication = {
      provider: 'github',
      repository_id: plan.repository_id,
      repository_full_name: plan.repository_full_name,
      source_sha: proof.candidate_sha,
      source_tree_sha: proof.tree_sha,
      source_ref: input.source_ref,
      destination_ref: input.destination_ref,
      expected_head_sha: input.expected_head_sha,
      publication_sha: sha,
      publication_tree_sha: tree,
      site_base_url: input.site_base_url,
      pages_source_path: '/',
      manifest,
      limits: input.limits,
    };
    validatePagesPublication(publication);
    return publication;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
