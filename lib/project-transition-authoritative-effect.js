const SHA40 = /^[0-9a-f]{40}$/;

function fail(code, message, details = null) {
  throw Object.assign(new Error(message), { code, details });
}

function exactCandidateRevision(executionResult) {
  const revisions = new Set();
  for (const entry of executionResult?.evidence || []) {
    const kind = String(entry?.kind || '').trim().toLowerCase();
    if (!['candidate_revision', 'candidate', 'verified_candidate'].includes(kind)) continue;
    const match = /@([0-9a-f]{40})$/i.exec(String(entry?.ref || '').trim());
    if (match) revisions.add(match[1].toLowerCase());
  }
  if (revisions.size !== 1) {
    fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_CANDIDATE_INVALID', 'completion requires one exact candidate revision', {
      candidate_revision_count:revisions.size,
      may_have_mutated:false,
    });
  }
  return [...revisions][0];
}

function ensureAuthority(authority, request) {
  if (!authority || authority.subject !== 'project_transition') {
    fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_AUTHORITY_INVALID', 'execution authority is not a project transition', { may_have_mutated:false });
  }
  const expectedTransition = request?.target?.horizon?.kind === 'transition' ? request.target.horizon.ref : null;
  if (authority.run_id !== request.run_id
      || authority.project_ref !== request?.target?.project_ref
      || (expectedTransition && authority.transition_id !== expectedTransition)) {
    fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_AUTHORITY_MISMATCH', 'execution authority does not match the settlement target', {
      may_have_mutated:false,
    });
  }
}

function mergedPullRequest(pr, candidate, workspaceBranch, developmentBranch) {
  return String(pr?.head?.sha || '').toLowerCase() === candidate
    && String(pr?.head?.ref || '') === workspaceBranch
    && String(pr?.base?.ref || '') === developmentBranch
    && Boolean(pr?.merged_at)
    && SHA40.test(String(pr?.merge_commit_sha || '').toLowerCase());
}

export function projectTransitionAuthoritativeEffectConfirmationFor(options = {}) {
  const { readLeaseRef, executionAuthority, deriveWorkspace, resolveBranchRoles, readPullRequests, readBranchHead, compareCommits, integrateCandidate } = options;
  if (typeof readLeaseRef !== 'function'
      || !executionAuthority || typeof executionAuthority.require !== 'function'
      || typeof deriveWorkspace !== 'function'
      || typeof resolveBranchRoles !== 'function'
      || typeof readPullRequests !== 'function'
      || typeof readBranchHead !== 'function'
      || typeof compareCommits !== 'function') {
    fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_RUNTIME_INVALID', 'authoritative-effect confirmation dependencies are unavailable');
  }

  return Object.freeze({
    async confirm(request = {}) {
      const candidate = exactCandidateRevision(request.execution_result);
      const leaseRef = await readLeaseRef(request.run_id);
      if (!leaseRef) fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_LEASE_NOT_FOUND', 'active execution lease was not found', { may_have_mutated:false });
      const authority = await executionAuthority.require({ lease_ref:leaseRef });
      ensureAuthority(authority, request);
      const workspace = await deriveWorkspace(authority);
      const roles = await resolveBranchRoles(workspace.repository);
      const developmentBranch = String(roles?.development_branch || '').trim();
      if (!developmentBranch) fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_BRANCH_ROLE_UNAVAILABLE', 'development branch role is unavailable', { may_have_mutated:false });

      const pulls = await readPullRequests({
        repository:workspace.repository,
        head:workspace.branch,
        base:developmentBranch,
      });
      const matching = (Array.isArray(pulls) ? pulls : []).filter((pr) => {
        return String(pr?.head?.sha || '').toLowerCase() === candidate
          && String(pr?.head?.ref || '') === workspace.branch
          && String(pr?.base?.ref || '') === developmentBranch;
      });
      if (matching.length > 1) fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_AMBIGUOUS', 'multiple pull requests matched the exact candidate workspace', { may_have_mutated:false });
      let pull = matching[0] || null;
      if ((!pull || !mergedPullRequest(pull, candidate, workspace.branch, developmentBranch)) && typeof integrateCandidate === 'function') {
        const developmentHeadBeforeIntegration = String(await readBranchHead({ repository:workspace.repository, branch:developmentBranch }) || '').toLowerCase();
        if (!SHA40.test(developmentHeadBeforeIntegration)) fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_READBACK_INVALID', 'development authority readback did not return an exact revision before integration', { may_have_mutated:false });
        const verifiedBase = String(workspace.authority_revision || authority?.authority?.revision || '').toLowerCase();
        if (!SHA40.test(verifiedBase) || developmentHeadBeforeIntegration !== verifiedBase) {
          return Object.freeze({ confirmed:false, reason:'authoritative_base_moved', observed_development_head:developmentHeadBeforeIntegration, verified_base:verifiedBase || null });
        }
        const integration = await integrateCandidate({
          repository:workspace.repository,
          pull_request:pull ? Number(pull.number) : null,
          workspace_branch:workspace.branch,
          development_branch:developmentBranch,
          expected_base:developmentHeadBeforeIntegration,
          expected_head:candidate,
        });
        if (!integration?.ok) {
          fail(integration?.error || 'PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_INTEGRATION_FAILED', integration?.message || 'deterministic authoritative integration failed', {
            ...integration,
            may_have_mutated:Boolean(integration?.may_have_mutated),
          });
        }
        if (['merge_submitted', 'merge_pending', 'waiting', 'updated_for_recheck'].includes(String(integration.outcome || ''))) {
          return Object.freeze({
            confirmed:false,
            reason:'authoritative_effect_pending',
            recovery:Object.freeze({
              mechanism:'github_integration_reconcile',
              ...(integration.merge_request_uuid ? { merge_request_uuid:String(integration.merge_request_uuid) } : {}),
            }),
          });
        }
        const refreshed = await readPullRequests({ repository:workspace.repository, head:workspace.branch, base:developmentBranch });
        const refreshedMatching = (Array.isArray(refreshed) ? refreshed : []).filter((pr) => {
          return String(pr?.head?.sha || '').toLowerCase() === candidate
            && String(pr?.head?.ref || '') === workspace.branch
            && String(pr?.base?.ref || '') === developmentBranch;
        });
        if (refreshedMatching.length > 1) fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_AMBIGUOUS', 'multiple pull requests matched the exact candidate workspace after integration', { may_have_mutated:false });
        pull = refreshedMatching[0] || null;
      }
      if (!pull || !mergedPullRequest(pull, candidate, workspace.branch, developmentBranch)) {
        return Object.freeze({ confirmed:false, reason:'authoritative_effect_not_observed' });
      }

      const mergeCommit = String(pull.merge_commit_sha).toLowerCase();
      const developmentHead = String(await readBranchHead({ repository:workspace.repository, branch:developmentBranch }) || '').toLowerCase();
      if (!SHA40.test(developmentHead)) fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_READBACK_INVALID', 'development authority readback did not return an exact revision', { may_have_mutated:false });
      if (developmentHead !== mergeCommit) {
        const comparison = await compareCommits({ repository:workspace.repository, base:mergeCommit, head:developmentHead });
        const status = String(comparison?.status || '').toLowerCase();
        if (!['ahead', 'identical'].includes(status) || Number(comparison?.behind_by || 0) !== 0) {
          return Object.freeze({ confirmed:false, reason:'authoritative_effect_not_in_development' });
        }
      }

      return Object.freeze({
        confirmed:true,
        evidence:Object.freeze([
          Object.freeze({ kind:'authoritative_effect', ref:`github:${workspace.repository}#${Number(pull.number)}@${mergeCommit}` }),
          Object.freeze({ kind:'authority_readback', ref:`github:${workspace.repository}@${developmentHead}` }),
        ]),
      });
    },
  });
}