import { semanticRequestHash } from 'lib/orchestration-journal.js';
import { withGitHubAppApiClient } from 'lib/github-app-auth.js';

const RELEASE_COMMAND = 'github.release.create';
const TEMPLATE_CREATE_COMMAND = 'github.repository_from_template.create';

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function mutationCertainty(invocation) {
  if (invocation?.may_have_mutated === false || invocation?.result_projection?.may_have_mutated === false) return false;
  if (invocation?.may_have_mutated === true || invocation?.result_projection?.may_have_mutated === true) return true;
  return null;
}

function templateCandidate(invocation) {
  const projection = object(invocation?.request_projection);
  if (typeof projection.template_repo !== 'string' || typeof projection.destination_repo !== 'string' || typeof projection.private !== 'boolean') return null;
  const idempotencyKey = typeof projection.idempotency_key === 'string' ? projection.idempotency_key : invocation?.idempotency_key;
  if (typeof idempotencyKey !== 'string' || !idempotencyKey) return null;
  const candidate = {
    template_repo: projection.template_repo,
    destination_repo: projection.destination_repo,
    private: projection.private,
    idempotency_key: idempotencyKey,
  };
  if (Object.prototype.hasOwnProperty.call(projection, 'description')) candidate.description = projection.description;
  return candidate;
}

function releaseEvidence(row) {
  const receipt = object(row?.receipt);
  return {
    source: 'github_release_receipt',
    repo: row?.repo || receipt.repo || null,
    tag_name: row?.tag_name || receipt.tag_name || null,
    target_sha: row?.target_sha || receipt.requested_commit_sha || null,
    release_id: row?.release_id ?? receipt.release_id ?? null,
    verified: receipt.verified === true,
  };
}

async function appendResolution(recordResolution, invocation, kind, evidence = {}) {
  await recordResolution(invocation.invocation_id, kind, {
    command: invocation.command,
    original_outcome: invocation.outcome,
    request_sha256: invocation.request_sha256 || null,
    ...evidence,
  });
  return { reconciled: true, command: invocation.command, resolution_kind: kind };
}

export function createSemanticJournalInvocationResolver({ lookupReleaseReceipt, recordResolution, reconcileRepositoryFromTemplate } = {}) {
  if (typeof lookupReleaseReceipt !== 'function' || typeof recordResolution !== 'function' || typeof reconcileRepositoryFromTemplate !== 'function') {
    throw new TypeError('semantic journal resolver dependencies are required');
  }

  return {
    async reconcile(invocation) {
      if (!invocation || ![RELEASE_COMMAND, TEMPLATE_CREATE_COMMAND].includes(invocation.command)) return null;

      if (mutationCertainty(invocation) === false) {
        return appendResolution(recordResolution, invocation, 'definitively_not_applied', {
          may_have_mutated: false,
          proof: 'command_result',
        });
      }

      if (invocation.command === RELEASE_COMMAND) {
        const projection = object(invocation.request_projection);
        const repo = typeof projection.repo === 'string' ? projection.repo : invocation.target_ref;
        const idempotencyKey = invocation.idempotency_key;
        if (typeof repo !== 'string' || typeof idempotencyKey !== 'string' || !invocation.request_sha256) return null;
        const row = await lookupReleaseReceipt(repo, idempotencyKey);
        if (!row?.request_json || row.state !== 'succeeded' || !row.receipt) return null;
        const receiptRequestHash = await semanticRequestHash(RELEASE_COMMAND, row.request_json);
        if (receiptRequestHash !== invocation.request_sha256) return null;
        return appendResolution(recordResolution, invocation, 'externally_confirmed', releaseEvidence(row));
      }

      const candidate = templateCandidate(invocation);
      if (!candidate || !invocation.request_sha256) return null;
      const candidateHash = await semanticRequestHash(TEMPLATE_CREATE_COMMAND, candidate);
      if (candidateHash !== invocation.request_sha256) return null;
      const observed = await reconcileRepositoryFromTemplate(candidate);
      if (observed?.kind === 'applied') {
        return appendResolution(recordResolution, invocation, 'externally_confirmed', {
          source: 'github_authoritative_read',
          evidence: object(observed.evidence),
        });
      }
      if (observed?.kind === 'not_applied') {
        return appendResolution(recordResolution, invocation, 'definitively_not_applied', {
          source: 'github_authoritative_read',
          evidence: object(observed.evidence),
        });
      }
      if (observed?.kind === 'conflict') {
        return appendResolution(recordResolution, invocation, 'externally_conflicted', {
          source: 'github_authoritative_read',
          evidence: object(observed.evidence),
        });
      }
      return null;
    },
  };
}

export async function reconcileRepositoryFromTemplateWithGitHubApp(candidate, options = {}) {
  const auth = options.withGitHubAppApiClientImpl || withGitHubAppApiClient;
  try {
    return await auth(candidate.template_repo, async (apiClient) => {
      const path = `/repos/${candidate.destination_repo.split('/').map(encodeURIComponent).join('/')}`;
      let response;
      try {
        response = await apiClient.call('github', { method: 'GET', path });
      } catch (error) {
        return { kind: 'ambiguous', reason: 'DESTINATION_READ_FAILED', evidence: { error: String(error?.code || error?.message || 'read_failed') } };
      }
      const status = Number(response?.status || 0);
      if (status === 404) return { kind: 'ambiguous', reason: 'DESTINATION_ABSENT_NOW' };
      if (status < 200 || status >= 300) return { kind: 'ambiguous', reason: 'DESTINATION_READ_FAILED', evidence: { upstream_status: status || null } };
      const body = object(response.body);
      const observed = {
        full_name: body.full_name ? String(body.full_name) : null,
        private: body.private === true,
        description: body.description == null || body.description === '' ? null : String(body.description),
        template_repository: body.template_repository?.full_name ? String(body.template_repository.full_name) : null,
        repository_id: Number(body.id || 0) || null,
      };
      if (!observed.template_repository) return { kind: 'ambiguous', reason: 'TEMPLATE_ORIGIN_UNAVAILABLE', evidence: observed };
      const exact = observed.full_name?.toLowerCase() === candidate.destination_repo.toLowerCase()
        && observed.private === candidate.private
        && (observed.description ?? null) === (candidate.description ?? null)
        && observed.template_repository.toLowerCase() === candidate.template_repo.toLowerCase();
      return exact
        ? { kind: 'applied', evidence: observed }
        : { kind: 'conflict', evidence: observed };
    }, { permissionProfile: 'repository_from_template', repositoryScope: 'installation' });
  } catch (error) {
    return { kind: 'ambiguous', reason: 'GITHUB_APP_READ_UNAVAILABLE', evidence: { error: String(error?.code || error?.message || 'auth_failed') } };
  }
}

export function createPostgresSemanticJournalInvocationResolver(dbBinding) {
  if (!dbBinding || typeof dbBinding.query !== 'function') throw new TypeError('dbBinding is required');
  return createSemanticJournalInvocationResolver({
    async lookupReleaseReceipt(repo, idempotencyKey) {
      return (await dbBinding.query('SELECT * FROM github_release_receipts WHERE repo=$1 AND idempotency_key=$2', [repo, idempotencyKey])).rows?.[0] || null;
    },
    async recordResolution(invocationId, kind, evidence) {
      const inserted = (await dbBinding.query(
        'INSERT INTO orchestration_invocation_resolutions (invocation_id,resolution_kind,evidence) VALUES ($1,$2,$3::jsonb) ON CONFLICT (invocation_id) DO NOTHING RETURNING *',
        [invocationId, kind, JSON.stringify(evidence || {})],
      )).rows?.[0] || null;
      if (inserted) return inserted;
      return (await dbBinding.query('SELECT * FROM orchestration_invocation_resolutions WHERE invocation_id=$1 ORDER BY created_at DESC LIMIT 1', [invocationId])).rows?.[0] || null;
    },
    reconcileRepositoryFromTemplate: reconcileRepositoryFromTemplateWithGitHubApp,
  });
}