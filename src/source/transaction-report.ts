import { execFileSync, spawnSync } from 'node:child_process';

import { canonicalDigest } from '../digest.ts';
import {
  githubRepositoryPath,
  verifyGitHubRepositoryIdentity,
} from '../providers/github/evidence-primitives.ts';
import { githubGet, type GitHubJsonGet } from '../providers/github/rest.ts';
import { isData } from '../validation.ts';
import { GitOvercenterKernel } from '../storage/git-kernel.ts';
import { validateSourceIntegrationEvidence } from './source-integration.ts';
import {
  sourceTransactionContextFromEnvironment,
  type SourceTransactionContext,
} from './transaction-baseline.ts';
import {
  buildSourceTransactionPlan,
  sourceTransactionPlanDigest,
  sourceTransactionPlanRef,
} from './transaction.ts';

export function reportSourceTransaction(
  repo: string,
  runId: string,
  {
    remote = 'origin',
    authorityRef = 'refs/overcenter/state',
    sourceRef = 'refs/heads/main',
    githubToken = null,
    get = githubGet,
    requireSettled = false,
    transactionContext,
  }: {
    remote?: string;
    authorityRef?: string;
    sourceRef?: string;
    githubToken?: string | null;
    get?: GitHubJsonGet;
    requireSettled?: boolean;
    transactionContext?: SourceTransactionContext;
  } = {},
) {
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();

  const authorityHead = new GitOvercenterKernel(repo, { remote, ref: authorityRef }).head();
  if (!authorityHead) throw new Error('SOURCE_TRANSACTION_REPORT_AUTHORITY_MISSING');

  const kernel = new GitOvercenterKernel(repo, { ref: authorityHead });
  const assigned = kernel.claimedWork(runId);
  const claim = kernel.sourceClaimBinding(runId);
  const receipt = kernel.receipts(runId).at(-1);
  const integration =
    receipt?.kind === 'source-integration' && receipt.disposition === 'DONE'
      ? validateSourceIntegrationEvidence(receipt.diagnostic?.source_integration)
      : null;

  const candidateRef = `refs/heads/overcenter/candidate/${runId}`;
  const candidateObserved = git('ls-remote', remote, candidateRef).split(/\s+/)[0] ?? '';
  const candidateSha = integration?.candidate_sha ?? candidateObserved;
  if (!/^[0-9a-f]{40}$/.test(candidateSha)) {
    throw new Error('SOURCE_TRANSACTION_REPORT_CANDIDATE_UNAVAILABLE');
  }
  git('fetch', '--no-tags', remote, candidateSha);

  const context = transactionContext ?? sourceTransactionContextFromEnvironment();
  const plan = buildSourceTransactionPlan({
    repo,
    taskValue: assigned.packet,
    claim,
    candidateSha,
    context,
  });

  const observed = git('ls-remote', remote, sourceRef).split(/\s+/);
  if (
    observed.length !== 2 ||
    observed[1] !== sourceRef ||
    !/^[0-9a-f]{40}$/.test(observed[0] ?? '')
  ) {
    throw new Error('SOURCE_TRANSACTION_REPORT_SOURCE_UNAVAILABLE');
  }
  const observedSource = observed[0]!;
  git('fetch', '--no-tags', remote, observedSource);

  if (integration) {
    if (
      integration.run_id !== runId ||
      integration.source_sha !== plan.claim.source_sha ||
      integration.candidate_sha !== plan.candidate_sha ||
      integration.verification_base_sha !== plan.claim.source_sha ||
      integration.verified_tree_sha !== plan.candidate_tree ||
      integration.verified_tree_sha !==
        git('rev-parse', `${integration.integration_commit}^{tree}`) ||
      (spawnSync(
        'git',
        ['-C', repo, 'merge-base', '--is-ancestor', integration.integration_commit, observedSource],
        { stdio: 'ignore' },
      ).status ?? 1) !== 0
    ) {
      throw new Error('SOURCE_TRANSACTION_REPORT_INTEGRATION_UNOBSERVED');
    }
  }

  let repositoryIdentity: 'verified' | 'unverified' = 'unverified';

  if (githubToken) {
    verifyGitHubRepositoryIdentity(githubToken, {
      repositoryId: plan.repository_id,
      repositoryFullName: plan.repository_full_name,
      get,
    });
    for (const [ref, sha] of [
      [authorityRef, authorityHead],
      [sourceRef, observedSource],
    ] as const) {
      if (!ref.startsWith('refs/')) throw new Error('SOURCE_TRANSACTION_REPORT_REF_INVALID');
      const raw = get(
        githubToken,
        githubRepositoryPath(
          plan.repository_full_name,
          `/git/ref/${ref
            .slice(5)
            .split('/')
            .map((part) => encodeURIComponent(part))
            .join('/')}`,
        ),
      );
      if (!isData(raw) || raw.ref !== ref || !isData(raw.object) || raw.object.sha !== sha) {
        throw new Error('SOURCE_TRANSACTION_REPORT_REPOSITORY_REF_MISMATCH');
      }
    }

    repositoryIdentity = 'verified';
  }

  const state = kernel.inspect().find((work) => work.run_id === runId)?.status ?? 'HISTORICAL';
  const report = {
    schema: 'overcenter-source-transaction-evidence',
    schema_version: 2,
    repository_identity: repositoryIdentity,
    repository_id: plan.repository_id,
    repository_full_name: plan.repository_full_name,
    runtime_sha: plan.runtime_sha,
    run_id: runId,
    authority_head: authorityHead,
    plan_digest: sourceTransactionPlanDigest(plan),
    plan_ref: sourceTransactionPlanRef(plan),
    planned_write_set: plan.expected_write_set,
    observed_write_set: plan.observed_write_set,
    candidate_sha: plan.candidate_sha,
    candidate_tree: plan.candidate_tree,
    assurance: plan.assurance,
    source_integration: integration,
    independently_observed_source_sha: observedSource,
    reconstructed_state: state,
    authority_settled:
      receipt?.disposition === 'DONE' && receipt.verified === true && integration !== null,
    settled:
      repositoryIdentity === 'verified' &&
      receipt?.disposition === 'DONE' &&
      receipt.verified === true &&
      integration !== null,
    settlement_commit: receipt?.settlement_commit ?? null,
  };
  if (requireSettled && !report.settled) {
    throw new Error('SOURCE_TRANSACTION_REPORT_LIFECYCLE_INCOMPLETE');
  }
  return { ...report, report_digest: canonicalDigest(report) };
}
