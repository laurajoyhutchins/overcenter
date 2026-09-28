import type { Observation } from '../../model.ts';
import { canonicalDigest, sha256 } from '../../digest.ts';
import {
  readGitHubEvidenceFile,
  verifyGitHubRepositoryIdentity,
  verifyGitHubWorkflowArtifact,
} from './evidence-primitives.ts';
import { githubGet, type GitHubJsonGet } from './rest.ts';

export interface GitHubSourceBoundEvidenceCoordinates {
  verifier: Observation['verifier'];
  provider: 'github';
  repository_id: number;
  repository_full_name: string;
  ref: string;
  evidence_path: string;
  expected_sha256: string;
  source_blobs: Record<string, string>;
}

export interface GitHubSourceBoundEvidenceRun {
  workflow_run_id: number;
  revision: string;
  artifact_digest: string;
}

export interface GitHubSourceBoundEvidenceBinding {
  source_blobs: Record<string, string>;
  source_runs: GitHubSourceBoundEvidenceRun[];
}

export interface GitHubSourceBoundEvidenceAdapter {
  workflow_path: string;
  job_name: string;
  artifact_name: string;
  bindingFromEvidence(bytes: Buffer): GitHubSourceBoundEvidenceBinding;
}

export function observeGitHubSourceBoundEvidence(
  token: string,
  p: GitHubSourceBoundEvidenceCoordinates,
  adapter: GitHubSourceBoundEvidenceAdapter,
  get: GitHubJsonGet = githubGet,
): Observation {
  const base = {
    verifier: p.verifier,
    provider: 'github' as const,
    repository_id: p.repository_id,
    repository_full_name: p.repository_full_name,
    ref: p.ref,
    evidence_path: p.evidence_path,
    expected_sha256: p.expected_sha256,
    source_binding_sha256: canonicalDigest(p.source_blobs),
  };

  try {
    verifyGitHubRepositoryIdentity(token, {
      repositoryId: p.repository_id,
      repositoryFullName: p.repository_full_name,
      get,
    });

    const evidenceFile = readGitHubEvidenceFile(token, {
      repositoryFullName: p.repository_full_name,
      path: p.evidence_path,
      ref: p.ref,
      get,
    });
    const actualSha256 = sha256(evidenceFile.bytes);
    const binding = adapter.bindingFromEvidence(evidenceFile.bytes);

    const expectedPaths = Object.keys(p.source_blobs).sort();
    const declaredPaths = Object.keys(binding.source_blobs).sort();
    const sourceEvidence: Record<string, unknown> = {};
    let current =
      actualSha256 === p.expected_sha256 &&
      JSON.stringify(expectedPaths) === JSON.stringify(declaredPaths);

    for (const path of expectedPaths) {
      const expected = p.source_blobs[path]!.toLowerCase();
      const declared = binding.source_blobs[path]?.toLowerCase();
      const observed = readGitHubEvidenceFile(token, {
        repositoryFullName: p.repository_full_name,
        path,
        ref: p.ref,
        get,
      }).blob;
      sourceEvidence[path] = {
        expected_blob: expected,
        committed_evidence_blob: declared ?? null,
        observed_blob: observed,
      };
      if (declared !== expected || observed !== expected) current = false;
    }

    if (binding.source_runs.length === 0) {
      throw new Error('GITHUB_SOURCE_BOUND_EVIDENCE_RUNS_MISSING');
    }
    const sourceRuns = binding.source_runs.map((source) =>
      verifyGitHubWorkflowArtifact(token, {
        repositoryFullName: p.repository_full_name,
        workflowRunId: source.workflow_run_id,
        revision: source.revision,
        workflowPath: adapter.workflow_path,
        jobName: adapter.job_name,
        artifactName: adapter.artifact_name,
        artifactDigest: source.artifact_digest,
        get,
      }),
    );

    return {
      ...base,
      actual_sha256: actualSha256,
      actual_state: current ? 'current' : 'stale',
      mutation_certainty: 'present',
      provider_evidence: {
        evidence_blob: evidenceFile.blob,
        source_blobs: sourceEvidence,
        source_runs: sourceRuns,
      },
    };
  } catch (error: unknown) {
    return {
      ...base,
      mutation_certainty: 'uncertain',
      observation_error: error instanceof Error ? error.message : String(error),
    };
  }
}
