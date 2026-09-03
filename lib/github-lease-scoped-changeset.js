import { githubChangesetSemanticRequestHash } from 'lib/github-apply-changeset.js';
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

function validateInput(input){
  if(!input||typeof input!=='object'||Array.isArray(input)) return fail('INVALID_REQUEST','request must be an object');
  const unknown=Object.keys(input).filter(key=>!ALLOWED_FIELDS.has(key)).sort();
  if(unknown.length) return fail('INVALID_REQUEST','lease-scoped changeset cannot include caller-selected Git coordinates',{unknown});
  const leaseRef=typeof input.lease_ref==='string'?input.lease_ref.trim():'';
  if(!leaseRef||leaseRef.length>128) return fail('INVALID_REQUEST','lease_ref must be a bounded non-empty string',{field:'lease_ref'});
  return {lease_ref:leaseRef,changes:input.changes,commit_message:input.commit_message};
}

function observedHead(value){
  if(value===null||value===undefined) return null;
  const candidate=typeof value==='string'?value:(value&&typeof value==='object'?value.sha:null);
  const normalized=typeof candidate==='string'?candidate.trim().toLowerCase():'';
  if(!SHA40.test(normalized)) return fail('INVALID_SHA','managed workspace branch read returned an invalid head',{field:'workspace_head'});
  return normalized;
}

export async function resolveGithubLeaseScopedChangeset(input,{executionAuthority,readBranch}={}){
  const request=validateInput(input);
  if(!executionAuthority||typeof executionAuthority.require!=='function') return fail('EXECUTION_AUTHORITY_UNAVAILABLE','lease-scoped changeset requires the execution-authority service',null,503);
  if(typeof readBranch!=='function') return fail('EXECUTION_AUTHORITY_UNAVAILABLE','lease-scoped changeset requires managed workspace readback',null,503);

  const authority=await executionAuthority.require({lease_ref:request.lease_ref});
  if(!authority||authority.subject!=='project_transition') {
    return fail('LEASE_SCOPED_CHANGESET_PROJECT_TRANSITION_REQUIRED','lease-scoped changesets require graph-native project-transition authority',null,409);
  }
  const workspace=await deriveProjectTransitionGithubWorkspace(authority);
  const head=observedHead(await readBranch({repo:workspace.repository,branch:workspace.branch,changes:request.changes}));
  const explicit={
    repo:workspace.repository,
    base_sha:workspace.authority_revision,
    branch:workspace.branch,
    expected_head:head,
    changes:request.changes,
    commit_message:request.commit_message,
  };
  const changesetSha256=await githubChangesetSemanticRequestHash(explicit);
  const idempotencyKey=await projectTransitionGithubChangesetIdempotencyKey({
    lease_ref:request.lease_ref,
    workspace_digest:workspace.workspace_digest,
    observed_head:head,
    changeset_sha256:changesetSha256,
  });
  const githubWorkspace=Object.freeze({
    schema:'project-transition-github-workspace-v1',
    workspace_digest:workspace.workspace_digest,
    branch:workspace.branch,
    authority_revision:workspace.authority_revision,
    observed_head:head,
  });
  return Object.freeze({
    request:Object.freeze({...explicit,idempotency_key:idempotencyKey}),
    execution_authority:Object.freeze({...authority,github_workspace:githubWorkspace}),
  });
}

export async function applyGithubLeaseScopedChangeset(input,options={}){
  const {executionAuthority,readBranch,applyChangeset,...applyOptions}=options;
  if(typeof applyChangeset!=='function') return fail('EXECUTION_AUTHORITY_UNAVAILABLE','lease-scoped changeset requires the existing Git changeset boundary',null,503);
  const request=validateInput(input);
  const resolved=await resolveGithubLeaseScopedChangeset(request,{executionAuthority,readBranch});
  const workspaceEvidence=resolved.execution_authority.github_workspace;
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
  return applyChangeset(resolved.request,{...applyOptions,executionAuthority:revalidatingAuthority});
}
