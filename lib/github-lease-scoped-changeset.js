import { GitHubChangesetError, githubChangesetSemanticRequestHash } from 'lib/github-apply-changeset.js';
import {
  deriveProjectTransitionGithubWorkspace,
  projectTransitionGithubChangesetIdempotencyKey,
} from 'lib/project-transition-github-workspace.js';

const SHA40=/^[0-9a-f]{40}$/;
const ALLOWED_FIELDS=new Set(['lease_ref','changes','commit_message']);

function fail(code,message,details=null,httpStatus=422){
  const error=new Error(message);
  error.code=code;
  error.details=details;
  error.httpStatus=httpStatus;
  throw error;
}

function validateLeaseRef(value){
  const leaseRef=typeof value==='string'?value.trim():'';
  if(!leaseRef||leaseRef.length>128) return fail('INVALID_REQUEST','lease_ref must be a bounded non-empty string',{field:'lease_ref'});
  return leaseRef;
}

function validateInput(input){
  if(!input||typeof input!=='object'||Array.isArray(input)) return fail('INVALID_REQUEST','request must be an object');
  const unknown=Object.keys(input).filter(key=>!ALLOWED_FIELDS.has(key)).sort();
  if(unknown.length) return fail('INVALID_REQUEST','lease-scoped changeset cannot include caller-selected Git coordinates',{unknown});
  return {lease_ref:validateLeaseRef(input.lease_ref),changes:input.changes,commit_message:input.commit_message};
}

function observedHead(value){
  if(value===null||value===undefined) return null;
  const candidate=typeof value==='string'?value:(value&&typeof value==='object'?value.sha:null);
  const normalized=typeof candidate==='string'?candidate.trim().toLowerCase():'';
  if(!SHA40.test(normalized)) return fail('INVALID_SHA','managed workspace branch read returned an invalid head',{field:'workspace_head'});
  return normalized;
}

function guardManagedWorkspaceGithub(github,{repository,branch,observed_head:expectedHead}){
  if(!github||typeof github.getBranch!=='function') {
    return fail('EXECUTION_AUTHORITY_UNAVAILABLE','lease-scoped changeset requires a GitHub transaction adapter',null,503);
  }
  let preflightPending=true;
  return Object.freeze({
    ...github,
    async getBranch(repo,requestedBranch,readOptions={}){
      const current=await github.getBranch(repo,requestedBranch,readOptions);
      if(preflightPending&&repo===repository&&requestedBranch===branch){
        preflightPending=false;
        const actualHead=observedHead(current);
        if(actualHead!==expectedHead){
          throw new GitHubChangesetError(
            'HEAD_MISMATCH',
            'managed workspace head changed between lease-scope resolution and Git preflight',
            {
              expected_head:expectedHead,
              actual_head:actualHead,
              branch,
              phase:'lease_scope.preflight',
              may_have_mutated:false,
            },
            409,
          );
        }
      }
      return current;
    },
  });
}

function assertExpectedWorkspace(actual,expected){
  if(!expected) return;
  for(const field of ['workspace_digest','branch','authority_revision']){
    if(actual?.[field]!==expected?.[field]){
      return fail('EXECUTION_AUTHORITY_STALE','project-transition GitHub workspace authority changed after preparation',{
        field,
        expected:expected?.[field]??null,
        actual:actual?.[field]??null,
      },409);
    }
  }
  if(actual.observed_head!==expected.observed_head){
    throw new GitHubChangesetError(
      'HEAD_MISMATCH',
      'managed workspace head changed after lease-scoped preparation',
      {
        expected_head:expected.observed_head,
        actual_head:actual.observed_head,
        branch:actual.branch,
        phase:'lease_scope.prepared_read',
        may_have_mutated:false,
      },
      409,
    );
  }
}

export async function resolveGithubLeaseScopedWorkspace(input,{executionAuthority,readBranch}={}){
  const leaseRef=validateLeaseRef(input?.lease_ref);
  if(!executionAuthority||typeof executionAuthority.require!=='function') return fail('EXECUTION_AUTHORITY_UNAVAILABLE','lease-scoped changeset requires the execution-authority service',null,503);
  if(typeof readBranch!=='function') return fail('EXECUTION_AUTHORITY_UNAVAILABLE','lease-scoped changeset requires managed workspace readback',null,503);

  const authority=await executionAuthority.require({lease_ref:leaseRef});
  if(!authority||authority.subject!=='project_transition') {
    return fail('LEASE_SCOPED_CHANGESET_PROJECT_TRANSITION_REQUIRED','lease-scoped changesets require graph-native project-transition authority',null,409);
  }
  const workspace=await deriveProjectTransitionGithubWorkspace(authority);
  const head=observedHead(await readBranch({repo:workspace.repository,branch:workspace.branch,changes:input?.changes}));
  const githubWorkspace=Object.freeze({
    schema:'project-transition-github-workspace-v1',
    workspace_digest:workspace.workspace_digest,
    branch:workspace.branch,
    authority_revision:workspace.authority_revision,
    observed_head:head,
  });
  return Object.freeze({
    workspace:Object.freeze({...workspace,observed_head:head}),
    execution_authority:Object.freeze({...authority,github_workspace:githubWorkspace}),
  });
}

export async function resolveGithubLeaseScopedChangeset(input,{executionAuthority,readBranch}={}){
  const request=validateInput(input);
  const prepared=await resolveGithubLeaseScopedWorkspace({lease_ref:request.lease_ref,changes:request.changes},{executionAuthority,readBranch});
  const workspace=prepared.workspace;
  const explicit={
    repo:workspace.repository,
    base_sha:workspace.authority_revision,
    branch:workspace.branch,
    expected_head:workspace.observed_head,
    changes:request.changes,
    commit_message:request.commit_message,
  };
  const changesetSha256=await githubChangesetSemanticRequestHash(explicit);
  const idempotencyKey=await projectTransitionGithubChangesetIdempotencyKey({
    lease_ref:request.lease_ref,
    workspace_digest:workspace.workspace_digest,
    observed_head:workspace.observed_head,
    changeset_sha256:changesetSha256,
  });
  return Object.freeze({
    request:Object.freeze({...explicit,idempotency_key:idempotencyKey}),
    execution_authority:prepared.execution_authority,
  });
}

export async function applyGithubLeaseScopedChangeset(input,options={}){
  const {executionAuthority,readBranch,withGithub,applyChangeset,expectedWorkspace=null,...applyOptions}=options;
  if(typeof applyChangeset!=='function') return fail('EXECUTION_AUTHORITY_UNAVAILABLE','lease-scoped changeset requires the existing Git changeset boundary',null,503);
  if(typeof withGithub!=='function') return fail('EXECUTION_AUTHORITY_UNAVAILABLE','lease-scoped changeset requires a GitHub transaction scope',null,503);
  const request=validateInput(input);
  const resolved=await resolveGithubLeaseScopedChangeset(request,{executionAuthority,readBranch});
  const workspaceEvidence=resolved.execution_authority.github_workspace;
  assertExpectedWorkspace(workspaceEvidence,expectedWorkspace);
  const revalidatingAuthority=Object.freeze({
    async require(lowLevelRequest={}){
      const requestedRepository=typeof lowLevelRequest.repository==='string'?lowLevelRequest.repository:resolved.request.repo;
      const current=await executionAuthority.require({lease_ref:request.lease_ref,repository:requestedRepository});
      if(!current||current.subject!=='project_transition') {
        return fail('LEASE_SCOPED_CHANGESET_PROJECT_TRANSITION_REQUIRED','lease-scoped changesets require graph-native project-transition authority',null,409);
      }
      const currentWorkspace=await deriveProjectTransitionGithubWorkspace(current);
      if(currentWorkspace.workspace_digest!==workspaceEvidence.workspace_digest) {
        return fail('EXECUTION_AUTHORITY_STALE','project-transition GitHub workspace authority changed before mutation',{
          lease_ref:request.lease_ref,
          expected_workspace_digest:workspaceEvidence.workspace_digest,
          current_workspace_digest:currentWorkspace.workspace_digest,
        },409);
      }
      return Object.freeze({...current,github_workspace:workspaceEvidence});
    },
  });
  return withGithub({repo:resolved.request.repo,branch:resolved.request.branch,changes:resolved.request.changes},async(github)=>{
    const guardedGithub=guardManagedWorkspaceGithub(github,{
      repository:resolved.request.repo,
      branch:resolved.request.branch,
      observed_head:workspaceEvidence.observed_head,
    });
    return applyChangeset(resolved.request,{...applyOptions,executionAuthority:revalidatingAuthority,github:guardedGithub});
  });
}
