import { createHash } from 'node:crypto';
import { canonicalDigest } from '../digest.ts';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  AbsenceEvidenceCertificate,
  GitHubHostileMutationEvidencePostcondition,
  Observation,
  Postcondition,
  SourceIntegrationPostcondition,
} from '../model.ts';
import {
  localFileEnoentEvidence,
  localFileEnoentEvidenceMatches,
  validateAbsenceEvidenceEnvelope,
} from './evidence.ts';
import { SettlementObservationSchema } from '../generated/settlement-observation-schema.ts';
import { assertSupportedStructuralSchema, structurallyMatches } from '../structural-schema.ts';
import { isPositiveSafeInteger, isSha256Hex } from '../validation.ts';
import {
  observeCertifiedGitHubCommitStatus,
  type GitHubJsonGet,
} from '../providers/github/certified-status.ts';
import { observeCertifiedGitHubPullRequestIdentity } from '../providers/github/certified-pr.ts';
import { observeCertifiedGitHubSemanticRead } from '../providers/github/certified-read.ts';
import { canonicalGitHubRef } from '../providers/github/certified-ref.ts';
import { observeCertifiedGitHubCommitAncestry } from '../providers/github/certified-ancestry.ts';
import {
  githubGet,
  githubGetAsync,
  isGitHubObjectId,
  sameGitHubObjectId,
  runGitHubReadObserverAsync,
  type GitHubJsonGetAsync,
} from '../providers/github/rest.ts';
import {
  kubernetesConfigMapAbsenceEvidenceMatches,
  observeCertifiedKubernetesConfigMap,
  type KubernetesListConfigMaps,
} from '../providers/kubernetes/configmap.ts';

export interface ObservationContext {
  githubToken: string | null;
  githubGet?: GitHubJsonGet;
  githubGetAsync?: GitHubJsonGetAsync;
  observeGitHubHostileMutationEvidence?: (
    postcondition: GitHubHostileMutationEvidencePostcondition,
  ) => Observation;
  kubernetesListConfigMaps?: KubernetesListConfigMaps;
  kubernetesListLimit?: number;
  // Optional trusted confinement root for local-file observations. In confined
  // mode the observed file must be a direct child of this root and the final
  // component must not be a symlink. This deliberately avoids traversing
  // task-writable parent directories without an openat-style directory handle.
  localFileRoot?: string;
  clock?: () => string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function data(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const repositoryRelativePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.startsWith('/') &&
  !value.split('/').some((part) => part === '' || part === '.' || part === '..');

type GitHubSourceIntegrationPostcondition = SourceIntegrationPostcondition & {
  provider: 'github';
  repository_id: number;
  repository_full_name: string;
  ref: string;
  commit_sha: string;
  base_ref: string;
  expected_base_sha: string;
};

function githubSourceIntegrationPostcondition(
  value: SourceIntegrationPostcondition,
): value is GitHubSourceIntegrationPostcondition {
  return (
    value.provider === 'github' &&
    isPositiveSafeInteger(value.repository_id) &&
    typeof value.repository_full_name === 'string' &&
    /^[^/]+\/[^/]+$/.test(value.repository_full_name) &&
    typeof value.ref === 'string' &&
    value.ref.startsWith('refs/heads/') &&
    value.ref.length > 'refs/heads/'.length &&
    isGitHubObjectId(value.commit_sha) &&
    typeof value.base_ref === 'string' &&
    value.base_ref.length > 0 &&
    !value.base_ref.startsWith('refs/') &&
    isGitHubObjectId(value.expected_base_sha)
  );
}

function legacySourceIntegrationPostcondition(value: SourceIntegrationPostcondition): boolean {
  return Object.keys(value).length === 1;
}

assertSupportedStructuralSchema(SettlementObservationSchema);

const observationExternalRef = (ref: string, value: unknown): boolean => {
  if (ref !== '#/$defs/AbsenceEvidenceEnvelope') return false;
  validateAbsenceEvidenceEnvelope(value);
  return true;
};

export function validateObservationEnvelope(value: unknown): asserts value is Observation {
  if (
    data(value) &&
    Object.hasOwn(value, 'verifier') &&
    !structurallyMatches(SettlementObservationSchema.properties.verifier, value.verifier)
  )
    throw new Error('OBSERVATION_VERIFIER_INVALID');

  if (!structurallyMatches(SettlementObservationSchema, value, observationExternalRef))
    throw new Error('OBSERVATION_INVALID');
}

function readLocalFile(path: string, context: ObservationContext): string {
  const target = resolve(path);
  if (context.localFileRoot) {
    let root: string;
    try {
      root = realpathSync(context.localFileRoot);
    } catch {
      throw new Error('LOCAL_FILE_CONFINEMENT_ROOT_UNAVAILABLE');
    }
    if (dirname(target) !== root) {
      throw new Error('LOCAL_FILE_OUTSIDE_CONFINED_ROOT');
    }
  }

  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error('LOCAL_FILE_NOT_REGULAR');
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

export function validatePostcondition(p: Postcondition): void {
  if (p?.verifier === 'operator-judgment/v1' && data(p.subject)) return;
  if (p?.verifier === 'source-integration/v1') {
    if (legacySourceIntegrationPostcondition(p) || githubSourceIntegrationPostcondition(p)) return;
    throw new Error('SOURCE_INTEGRATION_POSTCONDITION_INVALID');
  }
  if (
    p?.verifier === 'file-content-equals/v1' &&
    typeof p.path === 'string' &&
    typeof p.content === 'string'
  )
    return;
  if (
    p?.verifier === 'eventually-consistent-file-content-equals/v1' &&
    typeof p.path === 'string' &&
    typeof p.content === 'string'
  )
    return;
  if (
    p?.verifier === 'github-commit-status/v2' &&
    p.provider === 'github' &&
    Number.isSafeInteger(p.repository_id) &&
    p.repository_id > 0 &&
    typeof p.repository_full_name === 'string' &&
    /^[^/]+\/[^/]+$/.test(p.repository_full_name) &&
    isGitHubObjectId(p.commit_sha) &&
    typeof p.context === 'string' &&
    p.context.length > 0 &&
    ['error', 'failure', 'pending', 'success'].includes(p.expected_state)
  )
    return;
  if (
    p?.verifier === 'github-pull-request-branch-updated/v1' &&
    p.provider === 'github' &&
    Number.isSafeInteger(p.repository_id) &&
    p.repository_id > 0 &&
    typeof p.repository_full_name === 'string' &&
    /^[^/]+\/[^/]+$/.test(p.repository_full_name) &&
    Number.isSafeInteger(p.pull_number) &&
    p.pull_number > 0 &&
    typeof p.pull_node_id === 'string' &&
    p.pull_node_id.length > 0 &&
    isGitHubObjectId(p.expected_previous_head_sha) &&
    typeof p.base_ref === 'string' &&
    p.base_ref.length > 0 &&
    isGitHubObjectId(p.expected_base_sha)
  )
    return;
  if (
    p?.verifier === 'github-hostile-mutation-evidence/v1' &&
    p.provider === 'github' &&
    isPositiveSafeInteger(p.repository_id) &&
    typeof p.repository_full_name === 'string' &&
    /^[^/]+\/[^/]+$/.test(p.repository_full_name) &&
    typeof p.ref === 'string' &&
    p.ref.length > 0 &&
    repositoryRelativePath(p.evidence_path) &&
    isSha256Hex(p.expected_sha256) &&
    data(p.source_blobs) &&
    Object.keys(p.source_blobs).length > 0 &&
    Object.entries(p.source_blobs).every(
      ([path, blob]) => repositoryRelativePath(path) && isGitHubObjectId(blob),
    )
  )
    return;
  if (
    p?.verifier === 'kubernetes-configmap-exists/v1' &&
    p.provider === 'kubernetes' &&
    typeof p.authority_id === 'string' &&
    p.authority_id.length > 0 &&
    p.api_group === '' &&
    p.resource === 'configmaps' &&
    typeof p.namespace === 'string' &&
    p.namespace.length > 0 &&
    typeof p.name === 'string' &&
    p.name.length > 0
  )
    return;
  throw new Error('UNSUPPORTED_POSTCONDITION');
}

const githubStatusCommon = (
  p: Extract<Postcondition, { verifier: 'github-commit-status/v2' }>,
) => ({
  verifier: p.verifier,
  provider: 'github' as const,
  repository_id: p.repository_id,
  repository_full_name: p.repository_full_name,
  commit_sha: p.commit_sha,
  context: p.context,
  expected_state: p.expected_state,
});

function githubStatusObservation(
  p: Extract<Postcondition, { verifier: 'github-commit-status/v2' }>,
  status: ReturnType<typeof observeCertifiedGitHubCommitStatus>,
): Observation {
  const common = githubStatusCommon(p);
  return status.state === 'indeterminate'
    ? {
        ...common,
        mutation_certainty: 'uncertain',
        observation_error: status.reason,
        provider_evidence: status.evidence,
      }
    : {
        ...common,
        actual_state: status.actual_state!,
        mutation_certainty: 'present',
        provider_evidence: status.evidence,
      };
}

const githubStatusError = (
  p: Extract<Postcondition, { verifier: 'github-commit-status/v2' }>,
  error: string,
): Observation => ({
  ...githubStatusCommon(p),
  mutation_certainty: 'uncertain',
  observation_error: error,
});

const githubHostileMutationEvidenceError = (
  p: GitHubHostileMutationEvidencePostcondition,
  error: string,
): Observation => ({
  verifier: p.verifier,
  provider: 'github',
  repository_id: p.repository_id,
  repository_full_name: p.repository_full_name,
  ref: p.ref,
  evidence_path: p.evidence_path,
  expected_sha256: p.expected_sha256,
  source_binding_sha256: canonicalDigest(p.source_blobs),
  mutation_certainty: 'uncertain',
  observation_error: error,
});

type GitHubPullRequestBranchUpdatedPostcondition = Extract<
  Postcondition,
  { verifier: 'github-pull-request-branch-updated/v1' }
>;

const githubPullRequestBranchUpdatedCommon = (p: GitHubPullRequestBranchUpdatedPostcondition) => ({
  verifier: p.verifier,
  provider: 'github' as const,
  repository_id: p.repository_id,
  repository_full_name: p.repository_full_name,
  pull_number: p.pull_number,
  pull_node_id: p.pull_node_id,
  expected_previous_head_sha: p.expected_previous_head_sha,
  base_ref: p.base_ref,
  expected_base_sha: p.expected_base_sha,
});

const githubPullRequestBranchUpdatedError = (
  p: GitHubPullRequestBranchUpdatedPostcondition,
  error: string,
): Observation => ({
  ...githubPullRequestBranchUpdatedCommon(p),
  mutation_certainty: 'uncertain',
  observation_error: error,
});

function observeGitHubPullRequestBranchUpdated(
  token: string,
  p: GitHubPullRequestBranchUpdatedPostcondition,
  get: GitHubJsonGet,
  clock?: () => string,
): Observation {
  const common = githubPullRequestBranchUpdatedCommon(p);
  const result = observeCertifiedGitHubPullRequestIdentity(token, {
    repositoryId: p.repository_id,
    repositoryFullName: p.repository_full_name,
    pullNumber: p.pull_number,
    expected: {
      node_id: p.pull_node_id,
      state: 'open',
      head_sha: p.expected_previous_head_sha,
      base_ref: p.base_ref,
      base_sha: p.expected_base_sha,
    },
    get,
    ...(clock ? { clock } : {}),
  });
  if (result.state === 'INDETERMINATE') {
    return {
      ...common,
      mutation_certainty: 'uncertain',
      observation_error: result.observation_error ?? result.reason,
    };
  }
  if (!result.actual || !result.repository_full_name || !result.evidence) {
    return githubPullRequestBranchUpdatedError(p, 'GITHUB_PR_BRANCH_UPDATE_OBSERVATION_INCOMPLETE');
  }
  const actual = result.actual;
  const stable =
    result.repository_full_name.toLowerCase() === p.repository_full_name.toLowerCase() &&
    actual.node_id === p.pull_node_id &&
    actual.base_ref === p.base_ref;
  if (!stable) {
    return {
      ...common,
      actual_head_sha: actual.head_sha,
      mutation_certainty: 'uncertain',
      observation_error: 'GITHUB_PR_BRANCH_UPDATE_COORDINATE_DRIFT',
      provider_evidence: { pull_request: result.evidence },
    };
  }
  if (sameGitHubObjectId(actual.head_sha, p.expected_previous_head_sha)) {
    return {
      ...common,
      actual_head_sha: actual.head_sha,
      mutation_certainty: 'absent',
      provider_evidence: { pull_request: result.evidence },
    };
  }

  const previousHeadAncestry = observeCertifiedGitHubCommitAncestry(token, {
    repositoryFullName: result.repository_full_name,
    ancestorSha: p.expected_previous_head_sha,
    descendantSha: actual.head_sha,
    get,
    ...(clock ? { clock } : {}),
  });
  const baseAncestry = observeCertifiedGitHubCommitAncestry(token, {
    repositoryFullName: result.repository_full_name,
    ancestorSha: p.expected_base_sha,
    descendantSha: actual.head_sha,
    get,
    ...(clock ? { clock } : {}),
  });
  const providerEvidence = {
    pull_request: result.evidence,
    previous_head_ancestry: previousHeadAncestry.evidence,
    base_ancestry: baseAncestry.evidence,
  };
  if (previousHeadAncestry.state !== 'ancestor' || baseAncestry.state !== 'ancestor') {
    return {
      ...common,
      actual_head_sha: actual.head_sha,
      mutation_certainty: 'uncertain',
      observation_error: 'GITHUB_PR_BRANCH_UPDATE_ANCESTRY_NOT_ESTABLISHED',
      provider_evidence: providerEvidence,
    };
  }
  return {
    ...common,
    actual_head_sha: actual.head_sha,
    mutation_certainty: 'present',
    provider_evidence: providerEvidence,
  };
}

function githubCommitAncestryEvidenceMatches(
  value: unknown,
  ancestorSha: string,
  descendantSha: string,
): boolean {
  return (
    data(value) &&
    value.operation_id === 'repos/compare-commits' &&
    value.relation === 'ancestor' &&
    typeof value.ancestor_sha === 'string' &&
    typeof value.descendant_sha === 'string' &&
    isGitHubObjectId(value.ancestor_sha) &&
    isGitHubObjectId(value.descendant_sha) &&
    sameGitHubObjectId(value.ancestor_sha, ancestorSha) &&
    sameGitHubObjectId(value.descendant_sha, descendantSha)
  );
}

function githubPullRequestBranchUpdatedEvidenceMatches(
  p: GitHubPullRequestBranchUpdatedPostcondition,
  observed: Observation,
): boolean {
  if (
    typeof observed.actual_head_sha !== 'string' ||
    !isGitHubObjectId(observed.actual_head_sha) ||
    sameGitHubObjectId(observed.actual_head_sha, p.expected_previous_head_sha) ||
    !data(observed.provider_evidence)
  )
    return false;
  const pull = data(observed.provider_evidence.pull_request)
    ? observed.provider_evidence.pull_request
    : null;
  if (
    !pull ||
    pull.provider !== 'github' ||
    pull.repository_id !== p.repository_id ||
    pull.pull_number !== p.pull_number ||
    pull.node_id !== p.pull_node_id ||
    typeof pull.requested_repository_full_name !== 'string' ||
    pull.requested_repository_full_name.toLowerCase() !== p.repository_full_name.toLowerCase() ||
    typeof pull.head_sha !== 'string' ||
    !isGitHubObjectId(pull.head_sha) ||
    !sameGitHubObjectId(pull.head_sha, observed.actual_head_sha) ||
    pull.base_ref !== p.base_ref
  )
    return false;
  return (
    githubCommitAncestryEvidenceMatches(
      observed.provider_evidence.previous_head_ancestry,
      p.expected_previous_head_sha,
      observed.actual_head_sha,
    ) &&
    githubCommitAncestryEvidenceMatches(
      observed.provider_evidence.base_ancestry,
      p.expected_base_sha,
      observed.actual_head_sha,
    )
  );
}

const sourceIntegrationCommon = (p: GitHubSourceIntegrationPostcondition) => ({
  verifier: p.verifier,
  provider: 'github' as const,
  repository_id: p.repository_id,
  repository_full_name: p.repository_full_name,
  ref: p.ref,
  commit_sha: p.commit_sha,
  base_ref: p.base_ref,
  expected_base_sha: p.expected_base_sha,
});

const sourceIntegrationError = (
  p: GitHubSourceIntegrationPostcondition,
  error: string,
): Observation => ({
  ...sourceIntegrationCommon(p),
  mutation_certainty: 'uncertain',
  observation_error: error,
});

function observeSourceIntegrationPullRequest(
  token: string,
  p: GitHubSourceIntegrationPostcondition,
  get: GitHubJsonGet,
  clock?: () => string,
): Observation {
  const headRef = canonicalGitHubRef(p.ref);
  const head = `${p.repository_full_name.split('/')[0]!}:${headRef.slice('refs/heads/'.length)}`;
  const read = observeCertifiedGitHubSemanticRead(token, {
    repositoryId: p.repository_id,
    repositoryFullName: p.repository_full_name,
    operation: 'pull_requests',
    parameters: { base: p.base_ref, head, page: 1, per_page: 100, state: 'open' },
    grantedPermissions: ['pull_requests:read'],
    get,
    ...(clock ? { clock } : {}),
  });
  if (read.state === 'indeterminate' || !Array.isArray(read.value) || read.value.length >= 100) {
    return sourceIntegrationError(
      p,
      read.state === 'indeterminate'
        ? read.observation_error
        : 'SOURCE_PR_PUBLICATION_COLLECTION_INCOMPLETE',
    );
  }

  const matches = read.value.filter(
    (value) =>
      data(value) &&
      value.state === 'open' &&
      isPositiveSafeInteger(value.number) &&
      typeof value.node_id === 'string' &&
      value.node_id.length > 0 &&
      data(value.head) &&
      isGitHubObjectId(value.head.sha) &&
      sameGitHubObjectId(value.head.sha, p.commit_sha) &&
      data(value.base) &&
      value.base.ref === p.base_ref &&
      isGitHubObjectId(value.base.sha) &&
      sameGitHubObjectId(value.base.sha, p.expected_base_sha),
  );
  if (matches.length !== 1) {
    return sourceIntegrationError(
      p,
      matches.length === 0
        ? 'SOURCE_PR_PUBLICATION_NOT_OBSERVED'
        : 'SOURCE_PR_PUBLICATION_OBSERVATION_AMBIGUOUS',
    );
  }

  const pull = matches[0]!;
  return {
    ...sourceIntegrationCommon(p),
    pull_number: pull.number as number,
    pull_node_id: pull.node_id as string,
    actual_head_sha: (pull.head as Record<string, unknown>).sha as string,
    mutation_certainty: 'present',
    provider_evidence: {
      pull_request: read.evidence,
      matched_base_sha: (pull.base as Record<string, unknown>).sha,
      member_count: read.value.length,
    },
  };
}

function sourceIntegrationPullRequestEvidenceMatches(
  p: GitHubSourceIntegrationPostcondition,
  observed: Observation,
): boolean {
  if (
    !isPositiveSafeInteger(observed.pull_number) ||
    typeof observed.pull_node_id !== 'string' ||
    observed.pull_node_id.length === 0 ||
    typeof observed.actual_head_sha !== 'string' ||
    !isGitHubObjectId(observed.actual_head_sha) ||
    !sameGitHubObjectId(observed.actual_head_sha, p.commit_sha) ||
    !data(observed.provider_evidence) ||
    !data(observed.provider_evidence.pull_request)
  )
    return false;

  const evidence = observed.provider_evidence;
  const read = evidence.pull_request as Record<string, unknown>;
  const parameters = data(read.parameters) ? read.parameters : null;
  return (
    read.provider === 'github' &&
    read.operation_id === 'pulls/list' &&
    read.repository_id === p.repository_id &&
    typeof read.requested_repository_full_name === 'string' &&
    read.requested_repository_full_name.toLowerCase() ===
      p.repository_full_name.toLowerCase() &&
    !!parameters &&
    parameters.head ===
      `${p.repository_full_name.split('/')[0]!}:${p.ref.slice('refs/heads/'.length)}` &&
    parameters.base === p.base_ref &&
    parameters.state === 'open' &&
    parameters.page === 1 &&
    parameters.per_page === 100 &&
    typeof evidence.member_count === 'number' &&
    evidence.member_count >= 1 &&
    evidence.member_count < 100 &&
    typeof evidence.matched_base_sha === 'string' &&
    isGitHubObjectId(evidence.matched_base_sha) &&
    sameGitHubObjectId(evidence.matched_base_sha, p.expected_base_sha)
  );
}

export function observePostcondition(p: Postcondition, context: ObservationContext): Observation {
  validatePostcondition(p);
  if (p.verifier === 'source-integration/v1') {
    if (!githubSourceIntegrationPostcondition(p)) {
      throw new Error('SOURCE_INTEGRATION_REQUIRES_TRUSTED_SETTLEMENT');
    }
    if (!context.githubToken) return sourceIntegrationError(p, 'GITHUB_TOKEN_UNAVAILABLE');
    try {
      return observeSourceIntegrationPullRequest(
        context.githubToken,
        p,
        context.githubGet ?? githubGet,
        context.clock,
      );
    } catch (e: unknown) {
      return sourceIntegrationError(p, errorMessage(e));
    }
  }

  if (p.verifier === 'operator-judgment/v1') {
    throw new Error('OPERATOR_JUDGMENT_NOT_AUTOMATICALLY_OBSERVABLE');
  }

  if (p.verifier === 'github-pull-request-branch-updated/v1') {
    if (!context.githubToken) {
      return githubPullRequestBranchUpdatedError(p, 'GITHUB_TOKEN_UNAVAILABLE');
    }
    try {
      return observeGitHubPullRequestBranchUpdated(
        context.githubToken,
        p,
        context.githubGet ?? githubGet,
        context.clock,
      );
    } catch (e: unknown) {
      return githubPullRequestBranchUpdatedError(p, errorMessage(e));
    }
  }

  if (p.verifier === 'github-hostile-mutation-evidence/v1') {
    if (!context.observeGitHubHostileMutationEvidence) {
      return githubHostileMutationEvidenceError(
        p,
        'GITHUB_HOSTILE_MUTATION_EVIDENCE_OBSERVER_UNAVAILABLE',
      );
    }
    try {
      return context.observeGitHubHostileMutationEvidence(p);
    } catch (e: unknown) {
      return githubHostileMutationEvidenceError(p, errorMessage(e));
    }
  }

  if (p.verifier === 'github-commit-status/v2') {
    if (!context.githubToken) return githubStatusError(p, 'GITHUB_TOKEN_UNAVAILABLE');
    try {
      return githubStatusObservation(
        p,
        observeCertifiedGitHubCommitStatus(context.githubToken, {
          repositoryId: p.repository_id,
          repositoryFullName: p.repository_full_name,
          commitSha: p.commit_sha,
          context: p.context,
          get: context.githubGet ?? githubGet,
          ...(context.clock ? { clock: context.clock } : {}),
        }),
      );
    } catch (e: unknown) {
      return githubStatusError(p, errorMessage(e));
    }
  }

  if (p.verifier === 'kubernetes-configmap-exists/v1') {
    const common = {
      verifier: p.verifier,
      provider: 'kubernetes' as const,
      authority_id: p.authority_id,
      api_group: p.api_group,
      resource: p.resource,
      namespace: p.namespace,
      name: p.name,
    };
    if (!context.kubernetesListConfigMaps) {
      return {
        ...common,
        mutation_certainty: 'uncertain',
        observation_error: 'KUBERNETES_LIST_TRANSPORT_UNAVAILABLE',
      };
    }
    const result = observeCertifiedKubernetesConfigMap(p, {
      list: context.kubernetesListConfigMaps,
      ...(context.kubernetesListLimit === undefined ? {} : { limit: context.kubernetesListLimit }),
    });
    if (result.state === 'present') {
      return {
        ...common,
        mutation_certainty: 'present',
        observed_uid: result.uid!,
        observed_resource_version: result.resource_version!,
        snapshot_resource_version: result.snapshot_resource_version!,
        provider_evidence: result.provider_evidence,
      };
    }
    if (result.state === 'absent') {
      return {
        ...common,
        mutation_certainty: 'absent',
        snapshot_resource_version: result.snapshot_resource_version!,
        absence_evidence: result.absence_evidence!,
        provider_evidence: result.provider_evidence,
      };
    }
    return {
      ...common,
      mutation_certainty: 'uncertain',
      observation_error: result.reason,
      provider_evidence: result.provider_evidence,
    };
  }

  if (p.verifier === 'eventually-consistent-file-content-equals/v1') {
    const expected = sha256(p.content);
    try {
      const actual = readLocalFile(p.path, context);
      const actualSha = sha256(actual);
      if (actual === p.content) {
        return {
          verifier: p.verifier,
          path: p.path,
          expected_sha256: expected,
          actual_sha256: actualSha,
          mutation_certainty: 'present',
        };
      }
      return {
        verifier: p.verifier,
        path: p.path,
        expected_sha256: expected,
        actual_sha256: actualSha,
        mutation_certainty: 'uncertain',
        observation_error: 'NON_MATCHING_READ_NOT_AUTHORITATIVE',
      };
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code === 'ENOENT') {
        return {
          verifier: p.verifier,
          path: p.path,
          expected_sha256: expected,
          mutation_certainty: 'uncertain',
          observation_error: 'NEGATIVE_READ_NOT_AUTHORITATIVE',
        };
      }
      return {
        verifier: p.verifier,
        path: p.path,
        expected_sha256: expected,
        mutation_certainty: 'uncertain',
        observation_error: errorMessage(e),
      };
    }
  }

  const expected = sha256(p.content);
  try {
    const actual = readLocalFile(p.path, context);
    const actualSha = sha256(actual);
    return {
      verifier: p.verifier,
      path: p.path,
      expected_sha256: expected,
      actual_sha256: actualSha,
      mutation_certainty: 'present',
    };
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT') {
      return {
        verifier: p.verifier,
        path: p.path,
        expected_sha256: expected,
        mutation_certainty: 'absent',
        absence_evidence: localFileEnoentEvidence(p.path),
      };
    }
    return {
      verifier: p.verifier,
      path: p.path,
      expected_sha256: expected,
      mutation_certainty: 'uncertain',
      observation_error: errorMessage(e),
    };
  }
}

export async function observePostconditionAsync(
  p: Postcondition,
  context: ObservationContext,
): Promise<Observation> {
  validatePostcondition(p);
  if (p.verifier === 'source-integration/v1' && githubSourceIntegrationPostcondition(p)) {
    if (!context.githubToken) return sourceIntegrationError(p, 'GITHUB_TOKEN_UNAVAILABLE');
    const getAsync =
      context.githubGetAsync ??
      (context.githubGet
        ? async (token: string, path: string) => context.githubGet!(token, path)
        : githubGetAsync);
    try {
      return await runGitHubReadObserverAsync(
        context.githubToken,
        (get) => observeSourceIntegrationPullRequest(context.githubToken!, p, get, context.clock),
        getAsync,
      );
    } catch (e: unknown) {
      return sourceIntegrationError(p, errorMessage(e));
    }
  }
  if (p.verifier === 'github-pull-request-branch-updated/v1') {
    if (!context.githubToken) {
      return githubPullRequestBranchUpdatedError(p, 'GITHUB_TOKEN_UNAVAILABLE');
    }
    const getAsync =
      context.githubGetAsync ??
      (context.githubGet
        ? async (token: string, path: string) => context.githubGet!(token, path)
        : githubGetAsync);
    try {
      return await runGitHubReadObserverAsync(
        context.githubToken,
        (get) => observeGitHubPullRequestBranchUpdated(context.githubToken!, p, get, context.clock),
        getAsync,
      );
    } catch (e: unknown) {
      return githubPullRequestBranchUpdatedError(p, errorMessage(e));
    }
  }
  if (p.verifier !== 'github-commit-status/v2') return observePostcondition(p, context);
  if (!context.githubToken) return githubStatusError(p, 'GITHUB_TOKEN_UNAVAILABLE');
  const getAsync =
    context.githubGetAsync ??
    (context.githubGet
      ? async (token: string, path: string) => context.githubGet!(token, path)
      : githubGetAsync);
  try {
    return githubStatusObservation(
      p,
      await runGitHubReadObserverAsync(
        context.githubToken,
        (get) =>
          observeCertifiedGitHubCommitStatus(context.githubToken!, {
            repositoryId: p.repository_id,
            repositoryFullName: p.repository_full_name,
            commitSha: p.commit_sha,
            context: p.context,
            get,
            ...(context.clock ? { clock: context.clock } : {}),
          }),
        getAsync,
      ),
    );
  } catch (e: unknown) {
    return githubStatusError(p, errorMessage(e));
  }
}

function assertObservationCoordinate(postcondition: Postcondition, observed: Observation): void {
  if (postcondition.verifier === 'operator-judgment/v1') {
    throw new Error('OPERATOR_JUDGMENT_NOT_AUTOMATICALLY_OBSERVABLE');
  }
  if (
    postcondition.verifier === 'source-integration/v1' &&
    !githubSourceIntegrationPostcondition(postcondition)
  ) {
    throw new Error('SOURCE_INTEGRATION_REQUIRES_TRUSTED_SETTLEMENT');
  }
  validateObservationEnvelope(observed);
  if (observed.verifier !== postcondition.verifier) {
    throw new Error('OBSERVATION_VERIFIER_MISMATCH');
  }

  if (
    postcondition.verifier === 'source-integration/v1' &&
    githubSourceIntegrationPostcondition(postcondition)
  ) {
    if (
      observed.provider !== 'github' ||
      observed.repository_id !== postcondition.repository_id ||
      typeof observed.repository_full_name !== 'string' ||
      observed.repository_full_name.toLowerCase() !==
        postcondition.repository_full_name.toLowerCase() ||
      observed.ref !== postcondition.ref ||
      observed.commit_sha !== postcondition.commit_sha ||
      observed.base_ref !== postcondition.base_ref ||
      observed.expected_base_sha !== postcondition.expected_base_sha
    ) {
      throw new Error('OBSERVATION_COORDINATE_MISMATCH');
    }
    return;
  }

  if (
    postcondition.verifier === 'file-content-equals/v1' ||
    postcondition.verifier === 'eventually-consistent-file-content-equals/v1'
  ) {
    if (observed.path !== postcondition.path) {
      throw new Error('OBSERVATION_COORDINATE_MISMATCH');
    }
    return;
  }

  if (postcondition.verifier === 'kubernetes-configmap-exists/v1') {
    if (
      observed.provider !== 'kubernetes' ||
      observed.authority_id !== postcondition.authority_id ||
      observed.api_group !== postcondition.api_group ||
      observed.resource !== postcondition.resource ||
      observed.namespace !== postcondition.namespace ||
      observed.name !== postcondition.name
    ) {
      throw new Error('OBSERVATION_COORDINATE_MISMATCH');
    }
    return;
  }

  if (postcondition.verifier === 'github-hostile-mutation-evidence/v1') {
    if (
      observed.provider !== 'github' ||
      observed.repository_id !== postcondition.repository_id ||
      typeof observed.repository_full_name !== 'string' ||
      observed.repository_full_name.toLowerCase() !==
        postcondition.repository_full_name.toLowerCase() ||
      observed.ref !== postcondition.ref ||
      observed.evidence_path !== postcondition.evidence_path ||
      observed.expected_sha256 !== postcondition.expected_sha256 ||
      observed.source_binding_sha256 !== canonicalDigest(postcondition.source_blobs)
    ) {
      throw new Error('OBSERVATION_COORDINATE_MISMATCH');
    }
    return;
  }

  if (postcondition.verifier === 'github-pull-request-branch-updated/v1') {
    if (
      observed.provider !== 'github' ||
      observed.repository_id !== postcondition.repository_id ||
      typeof observed.repository_full_name !== 'string' ||
      observed.repository_full_name.toLowerCase() !==
        postcondition.repository_full_name.toLowerCase() ||
      observed.pull_number !== postcondition.pull_number ||
      observed.pull_node_id !== postcondition.pull_node_id ||
      observed.expected_previous_head_sha !== postcondition.expected_previous_head_sha ||
      observed.base_ref !== postcondition.base_ref ||
      observed.expected_base_sha !== postcondition.expected_base_sha
    )
      throw new Error('OBSERVATION_COORDINATE_MISMATCH');
    return;
  }

  if (
    observed.provider !== 'github' ||
    observed.repository_id !== postcondition.repository_id ||
    typeof observed.repository_full_name !== 'string' ||
    observed.repository_full_name.toLowerCase() !==
      postcondition.repository_full_name.toLowerCase() ||
    observed.commit_sha !== postcondition.commit_sha ||
    observed.context !== postcondition.context
  ) {
    throw new Error('OBSERVATION_COORDINATE_MISMATCH');
  }
}

export function authoritativeAbsenceEvidence(
  postcondition: Postcondition,
  observed: Observation,
): AbsenceEvidenceCertificate | null {
  assertObservationCoordinate(postcondition, observed);
  if (observed.mutation_certainty !== 'absent') return null;

  switch (postcondition.verifier) {
    case 'file-content-equals/v1':
      return localFileEnoentEvidenceMatches(observed.absence_evidence, postcondition.path)
        ? observed.absence_evidence
        : null;
    case 'kubernetes-configmap-exists/v1':
      return kubernetesConfigMapAbsenceEvidenceMatches(observed.absence_evidence, postcondition)
        ? observed.absence_evidence
        : null;
    default:
      return null;
  }
}

export function observationAuthoritativelyAbsent(
  postcondition: Postcondition,
  observed: Observation,
): boolean {
  return authoritativeAbsenceEvidence(postcondition, observed) !== null;
}

export function observationVerified(postcondition: Postcondition, observed: Observation): boolean {
  if (postcondition.verifier === 'operator-judgment/v1') {
    throw new Error('OPERATOR_JUDGMENT_NOT_AUTOMATICALLY_OBSERVABLE');
  }
  assertObservationCoordinate(postcondition, observed);
  if (postcondition.verifier === 'source-integration/v1') {
    if (!githubSourceIntegrationPostcondition(postcondition)) {
      throw new Error('SOURCE_INTEGRATION_REQUIRES_TRUSTED_SETTLEMENT');
    }
    if (observed.mutation_certainty !== 'present') return false;
    return sourceIntegrationPullRequestEvidenceMatches(postcondition, observed);
  }
  if (observed.mutation_certainty !== 'present') return false;

  if (
    postcondition.verifier === 'file-content-equals/v1' ||
    postcondition.verifier === 'eventually-consistent-file-content-equals/v1'
  ) {
    return observed.actual_sha256 === sha256(postcondition.content);
  }

  if (postcondition.verifier === 'kubernetes-configmap-exists/v1') {
    return (
      typeof observed.observed_uid === 'string' &&
      observed.observed_uid.length > 0 &&
      typeof observed.observed_resource_version === 'string' &&
      observed.observed_resource_version.length > 0
    );
  }

  if (postcondition.verifier === 'github-hostile-mutation-evidence/v1') {
    return (
      observed.actual_state === 'current' &&
      observed.actual_sha256 === postcondition.expected_sha256 &&
      observed.source_binding_sha256 === canonicalDigest(postcondition.source_blobs)
    );
  }

  if (postcondition.verifier === 'github-pull-request-branch-updated/v1') {
    return githubPullRequestBranchUpdatedEvidenceMatches(postcondition, observed);
  }
  return observed.actual_state === postcondition.expected_state;
}
