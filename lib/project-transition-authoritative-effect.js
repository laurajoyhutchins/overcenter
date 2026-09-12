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
    && Boolean(pr?.merged_at);
}

export function projectTransitionAuthoritativeEffectConfirmationFor(options = {}) {
  const { readLeaseRef, readHistoricalAuthorities, executionAuthority, deriveWorkspace, resolveBranchRoles, readPullRequests, readBranchHead, compareCommits, integrateCandidate } = options;
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
    async confirm(request = {}, behavior = {}) {
      const allowIntegration = behavior?.allowIntegration !== false;
      const candidate = exactCandidateRevision(request.execution_result);
      const leaseRef = await readLeaseRef(request.run_id);
      if (!leaseRef) fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_LEASE_NOT_FOUND', 'active execution lease was not found', { may_have_mutated:false });
      const authority = await executionAuthority.require({ lease_ref:leaseRef });
      ensureAuthority(authority, request);
      const transitionFingerprint = String(authority.transition_definition_fingerprint || '').trim();
      if (!transitionFingerprint) fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_AUTHORITY_INVALID', 'current execution authority lacks a transition definition fingerprint', { may_have_mutated:false });
      const historical = typeof readHistoricalAuthorities === 'function'
        ? await readHistoricalAuthorities({
          project_ref:authority.project_ref,
          transition_id:authority.transition_id,
          transition_definition_fingerprint:transitionFingerprint,
        })
        : [];
      const authorities = [authority, ...(Array.isArray(historical) ? historical : [])].filter((entry) => {
        const git = entry?.authority;
        return entry?.subject === 'project_transition'
          && entry.project_ref === authority.project_ref
          && entry.transition_id === authority.transition_id
          && entry.repository === authority.repository
          && entry.transition_definition_fingerprint === transitionFingerprint
          && git?.kind === 'github'
          && git.repository === authority.repository
          && SHA40.test(String(git.revision || '').toLowerCase());
      });
      const workspaceEntries = [];
      const seenBranches = new Set();
      for (const candidateAuthority of authorities) {
        const candidateWorkspace = await deriveWorkspace(candidateAuthority);
        if (candidateWorkspace.repository !== authority.repository || seenBranches.has(candidateWorkspace.branch)) continue;
        seenBranches.add(candidateWorkspace.branch);
        workspaceEntries.push({ authority:candidateAuthority, workspace:candidateWorkspace });
      }
      const currentEntry = workspaceEntries[0];
      if (!currentEntry) fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_AUTHORITY_INVALID', 'current execution authority did not derive a usable workspace', { may_have_mutated:false });
      const roles = await resolveBranchRoles(currentEntry.workspace.repository);
      const developmentBranch = String(roles?.development_branch || '').trim();
      if (!developmentBranch) fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_BRANCH_ROLE_UNAVAILABLE', 'development branch role is unavailable', { may_have_mutated:false });

      const exactMatches = [];
      for (const entry of workspaceEntries) {
        const pulls = await readPullRequests({
          repository:entry.workspace.repository,
          head:entry.workspace.branch,
          base:developmentBranch,
        });
        const matching = (Array.isArray(pulls) ? pulls : []).filter((pr) => {
          return String(pr?.head?.sha || '').toLowerCase() === candidate
            && String(pr?.head?.ref || '') === entry.workspace.branch
            && String(pr?.base?.ref || '') === developmentBranch;
        });
        if (matching.length > 1) fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_AMBIGUOUS', 'multiple pull requests matched one exact candidate workspace', { may_have_mutated:false });
        if (matching[0]) exactMatches.push({ ...entry, pull:matching[0] });
      }
      if (exactMatches.length > 1) fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_AMBIGUOUS', 'multiple lease-derived workspaces matched the exact candidate revision', { may_have_mutated:false });

      let workspace = exactMatches[0]?.workspace || currentEntry.workspace;
      let pull = exactMatches[0]?.pull || null;
      const matchedHistoricalWorkspace = Boolean(pull && workspace.branch !== currentEntry.workspace.branch);
      if (matchedHistoricalWorkspace && !mergedPullRequest(pull, candidate, workspace.branch, developmentBranch)) {
        return Object.freeze({ confirmed:false, reason:'authoritative_effect_not_observed' });
      }
      if ((!pull || !mergedPullRequest(pull, candidate, workspace.branch, developmentBranch)) && allowIntegration && typeof integrateCandidate === 'function') {
        workspace = currentEntry.workspace;
        pull = exactMatches.find((entry) => entry.workspace.branch === workspace.branch)?.pull || null;
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

      const reportedMergeCommit = String(pull.merge_commit_sha || '').toLowerCase();
      const developmentHead = String(await readBranchHead({ repository:workspace.repository, branch:developmentBranch }) || '').toLowerCase();
      if (!SHA40.test(developmentHead)) fail('PROJECT_TRANSITION_AUTHORITATIVE_EFFECT_READBACK_INVALID', 'development authority readback did not return an exact revision', { may_have_mutated:false });
      let authoritativeEffectRevision = reportedMergeCommit;
      if (SHA40.test(reportedMergeCommit)) {
        if (developmentHead !== reportedMergeCommit) {
          const comparison = await compareCommits({ repository:workspace.repository, base:reportedMergeCommit, head:developmentHead });
          const status = String(comparison?.status || '').toLowerCase();
          if (!['ahead', 'identical'].includes(status) || Number(comparison?.behind_by || 0) !== 0) {
            return Object.freeze({ confirmed:false, reason:'authoritative_effect_not_in_development' });
          }
        }
      } else {
        const comparison = await compareCommits({ repository:workspace.repository, base:candidate, head:developmentHead });
        const status = String(comparison?.status || '').toLowerCase();
        const ancestryProvesCandidate = ['ahead', 'identical'].includes(status) && Number(comparison?.behind_by || 0) === 0;
        const candidateTree = String(comparison?.base_commit?.commit?.tree?.sha || '').toLowerCase();
        const developmentTree = String((comparison?.commits || []).find((commit) => String(commit?.sha || '').toLowerCase() === developmentHead)?.commit?.tree?.sha || '').toLowerCase();
        const squashTreeProvesCandidate = SHA40.test(candidateTree) && candidateTree === developmentTree;
        if (!ancestryProvesCandidate && !squashTreeProvesCandidate) {
          return Object.freeze({ confirmed:false, reason:'authoritative_effect_not_in_development' });
        }
        authoritativeEffectRevision = developmentHead;
      }

      return Object.freeze({
        confirmed:true,
        evidence:Object.freeze([
          Object.freeze({ kind:'authoritative_effect', ref:`github:${workspace.repository}#${Number(pull.number)}@${authoritativeEffectRevision}` }),
          Object.freeze({ kind:'authority_readback', ref:`github:${workspace.repository}@${developmentHead}` }),
        ]),
      });
    },
  });
}