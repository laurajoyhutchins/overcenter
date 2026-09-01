import { semanticRequestHash } from 'lib/orchestration-journal.js';
import { projectOrchestrationStatus } from 'lib/orchestration-status.js';
import { createSemanticJournalInvocationResolver, reconcileRepositoryFromTemplateWithGitHubApp } from 'lib/orchestration-semantic-journal-resolution.js';

function assert(condition, message) { if (!condition) throw new Error(message); }

function emptyStatusSnapshot() {
  return {
    overdue_active_runs: [], expired_active_slots: [], leases_stuck_claiming: [], leases_stuck_settling: [],
    journal_stuck_running: [], journal_indeterminate: [], github_changesets_processing: [], github_changesets_prepared: [],
    portfolio_reconcile_processing: [], portfolio_reconcile_indeterminate: [], recent_command_outcomes: [], recent_error_codes: [], recent_expected_rejections: [],
  };
}

export async function runOrchestrationSemanticJournalResolutionTests() {
  const results = [];
  async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: String(error?.message || error) }); }
  }

  await test('production release probes resolve as definitively not applied without another GitHub mutation', async () => {
    const resolutions = [];
    const resolver = createSemanticJournalInvocationResolver({
      async lookupReleaseReceipt() { throw new Error('no receipt lookup should be required for a no-mutation result'); },
      async recordResolution(invocationId, kind, evidence) { resolutions.push({ invocationId, kind, evidence }); return { invocation_id: invocationId, resolution_kind: kind }; },
      async reconcileRepositoryFromTemplate() { throw new Error('template reconciliation should not run for release commands'); },
    });
    for (const invocationId of ['d68880d5-538e-4b82-b36e-be8342d4361e', '3700df8d-3a93-4dbf-870a-ee6145703f9c']) {
      const result = await resolver.reconcile({
        invocation_id: invocationId,
        command: 'github.release.create',
        request_sha256: 'a'.repeat(64),
        idempotency_key: `release-${invocationId}`,
        request_projection: { repo: 'laurajoyhutchins/overcenter' },
        result_projection: { may_have_mutated: false },
        outcome: 'indeterminate',
      });
      assert(result?.resolution_kind === 'definitively_not_applied', `${invocationId} was not deterministically resolved`);
    }
    assert(resolutions.length === 2, 'release no-mutation evidence did not append exactly two resolutions');
    assert(resolutions.every((entry) => entry.evidence?.may_have_mutated === false), 'resolution evidence lost the no-mutation proof');
  });

  await test('release receipt is attributed only through the exact orchestration semantic request hash', async () => {
    const request = {
      repo: 'laurajoyhutchins/overcenter',
      target_sha: '1'.repeat(40),
      tag_name: 'v-test',
      name: 'Test release',
      body: 'Evidence',
      draft: false,
      prerelease: false,
      idempotency_key: 'release-exact',
    };
    const requestSha256 = await semanticRequestHash('github.release.create', request);
    const resolutions = [];
    const resolver = createSemanticJournalInvocationResolver({
      async lookupReleaseReceipt() { return { repo: request.repo, idempotency_key: request.idempotency_key, request_json: request, state: 'succeeded', receipt: { release_id: 17, tag_name: request.tag_name } }; },
      async recordResolution(invocationId, kind, evidence) { resolutions.push({ invocationId, kind, evidence }); return { invocation_id: invocationId, resolution_kind: kind }; },
      async reconcileRepositoryFromTemplate() { return { kind: 'ambiguous' }; },
    });
    const invocation = {
      invocation_id: '00000000-0000-4000-8000-000000000131',
      command: 'github.release.create',
      request_sha256: requestSha256,
      idempotency_key: request.idempotency_key,
      request_projection: { repo: request.repo },
      result_projection: { may_have_mutated: true },
      outcome: 'indeterminate',
    };
    const resolved = await resolver.reconcile(invocation);
    assert(resolved?.resolution_kind === 'externally_confirmed', 'exact release receipt was not reconciled');
    assert(resolutions.length === 1, 'exact release receipt did not append one resolution');
    const mismatched = await resolver.reconcile({ ...invocation, invocation_id: '00000000-0000-4000-8000-000000000132', request_sha256: 'f'.repeat(64) });
    assert(mismatched === null, 'hash-mismatched release receipt was attributed');
    assert(resolutions.length === 1, 'hash mismatch appended a resolution');
  });

  await test('exact template request can use read-only authoritative reconciliation', async () => {
    const request = {
      template_repo: 'laurajoyhutchins/hugging-face-dataset-template',
      destination_repo: 'laurajoyhutchins/generated-dataset',
      description: 'Generated for verification',
      private: true,
      idempotency_key: 'template-exact',
    };
    const requestSha256 = await semanticRequestHash('github.repository_from_template.create', request);
    let calls = 0;
    const resolver = createSemanticJournalInvocationResolver({
      async lookupReleaseReceipt() { return null; },
      async recordResolution(invocationId, kind) { return { invocation_id: invocationId, resolution_kind: kind }; },
      async reconcileRepositoryFromTemplate(candidate) { calls += 1; assert(candidate.description === request.description, 'template description was not preserved'); return { kind: 'applied', evidence: { destination_repo: candidate.destination_repo } }; },
    });
    const result = await resolver.reconcile({
      invocation_id: '00000000-0000-4000-8000-000000000133',
      command: 'github.repository_from_template.create',
      request_sha256: requestSha256,
      idempotency_key: request.idempotency_key,
      request_projection: request,
      result_projection: { may_have_mutated: true },
      outcome: 'indeterminate',
    });
    assert(result?.resolution_kind === 'externally_confirmed' && calls === 1, 'exact template request did not use authoritative read-only reconciliation');
  });

  await test('historical production template row stays indeterminate when exact request identity is incomplete', async () => {
    const fullRequest = {
      template_repo: 'laurajoyhutchins/hugging-face-dataset-template',
      destination_repo: 'laurajoyhutchins/overcenter-template-verification-20260827',
      description: "Verification repo for Overcenter's selected-installation template creation path.",
      private: true,
      idempotency_key: 'template-ops-verification-20260827T0108Z',
    };
    const requestSha256 = await semanticRequestHash('github.repository_from_template.create', fullRequest);
    let reconcilerCalls = 0;
    const resolver = createSemanticJournalInvocationResolver({
      async lookupReleaseReceipt() { return null; },
      async recordResolution() { throw new Error('ambiguous historical invocation must not be resolved'); },
      async reconcileRepositoryFromTemplate() { reconcilerCalls += 1; return { kind: 'applied' }; },
    });
    const result = await resolver.reconcile({
      invocation_id: 'eaee4a07-5d68-4379-b481-a3985a8a129c',
      command: 'github.repository_from_template.create',
      request_sha256: requestSha256,
      idempotency_key: fullRequest.idempotency_key,
      request_projection: {
        template_repo: fullRequest.template_repo,
        destination_repo: fullRequest.destination_repo,
        private: true,
        idempotency_key: fullRequest.idempotency_key,
      },
      result_projection: { may_have_mutated: true },
      outcome: 'indeterminate',
    });
    assert(result === null, 'incomplete historical template identity was resolved');
    assert(reconcilerCalls === 0, 'authoritative reconciler ran before exact request identity was established');
  });

  await test('authoritative template ambiguity remains indeterminate and never retries creation', async () => {
    const request = {
      template_repo: 'laurajoyhutchins/hugging-face-dataset-template',
      destination_repo: 'laurajoyhutchins/generated-ambiguous',
      description: null,
      private: true,
      idempotency_key: 'template-ambiguous',
    };
    const requestSha256 = await semanticRequestHash('github.repository_from_template.create', request);
    let resolutions = 0;
    const resolver = createSemanticJournalInvocationResolver({
      async lookupReleaseReceipt() { return null; },
      async recordResolution() { resolutions += 1; return null; },
      async reconcileRepositoryFromTemplate() { return { kind: 'ambiguous', reason: 'DESTINATION_UNPROVEN' }; },
    });
    const result = await resolver.reconcile({
      invocation_id: '00000000-0000-4000-8000-000000000134',
      command: 'github.repository_from_template.create',
      request_sha256: requestSha256,
      idempotency_key: request.idempotency_key,
      request_projection: request,
      result_projection: { may_have_mutated: true },
      outcome: 'indeterminate',
    });
    assert(result === null && resolutions === 0, 'ambiguous template effect was incorrectly resolved');
  });

  await test('template recovery uses installation-wide GitHub App scope for destination readback', async () => {
    const candidate = {
      template_repo: 'laurajoyhutchins/hugging-face-dataset-template',
      destination_repo: 'laurajoyhutchins/generated-dataset',
      description: null,
      private: true,
      idempotency_key: 'template-scope',
    };
    let observed = null;
    const result = await reconcileRepositoryFromTemplateWithGitHubApp(candidate, {
      async withGitHubAppApiClientImpl(repository, handler, options) {
        observed = { repository, options };
        return handler({ async call() { return { status: 404, body: {} }; } });
      },
    });
    assert(observed?.repository === candidate.template_repo, 'template recovery changed the source installation anchor');
    assert(observed?.options?.permissionProfile === 'repository_from_template', 'template recovery changed the permission profile');
    assert(observed?.options?.repositoryScope === 'installation', 'template recovery remained scoped to the source repository');
    assert(result?.kind === 'ambiguous' && result?.reason === 'DESTINATION_ABSENT_NOW', 'scope test changed fail-closed destination absence semantics');
  });

  await test('historical terminal residue remains observable without poisoning live orchestration health', async () => {
    const stamp = '2026-08-27T01:10:38.391Z';
    const status = projectOrchestrationStatus({
      ...emptyStatusSnapshot(),
      historical_journal_stuck_running: [{ invocation_id: 'old-running', run_id: 'finished-run', command: 'orchestration.drive', started_at: stamp, observed_at: stamp }],
      historical_journal_indeterminate: [{ invocation_id: 'old-indeterminate', run_id: 'finished-run', command: 'github.apply_changeset', error_code: 'GITHUB_PERMISSION_DENIED', started_at: stamp, observed_at: stamp }],
      historical_github_changesets_prepared: [{ repo: 'owner/repo', idempotency_key: 'old-prepared', branch: 'old-work', commit_sha: 'a'.repeat(40), updated_at: stamp, observed_at: stamp }],
    });
    assert(status.healthy === true, 'terminal historical residue still poisoned live health');
    assert(status.historical_conditions?.journal_stuck_running?.count === 1, 'historical running invocation was hidden');
    assert(status.historical_conditions?.journal_indeterminate?.count === 1, 'historical indeterminate invocation was hidden');
    assert(status.historical_conditions?.github_changesets_prepared?.count === 1, 'historical prepared changeset was hidden');
  });

  await test('unresolved live residue remains health blocking', async () => {
    const stamp = '2026-09-01T14:00:00.000Z';
    const status = projectOrchestrationStatus({
      ...emptyStatusSnapshot(),
      journal_indeterminate: [{ invocation_id: 'live-indeterminate', run_id: 'active-run', command: 'github.apply_changeset', error_code: 'UPSTREAM_AMBIGUOUS', started_at: stamp, observed_at: stamp }],
    });
    assert(status.healthy === false, 'live unresolved residue stopped blocking health');
    assert(status.conditions?.journal_indeterminate?.count === 1, 'live unresolved residue was hidden');
  });

  return { ok: results.every((result) => result.ok), passed: results.filter((result) => result.ok).length, failed: results.filter((result) => !result.ok).length, total: results.length, results };
}