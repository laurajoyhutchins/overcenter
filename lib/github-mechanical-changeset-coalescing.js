import { normalizeGithubChangesetRequest } from 'lib/github-apply-changeset.js';
import { deriveProjectTransitionGithubWorkspace } from 'lib/project-transition-github-workspace.js';

const SHA40=/^[0-9a-f]{40}$/;
const MECHANICAL_PREFIXES=['style:','format:','fmt:','lint:','chore(format):','chore(fmt):','chore(lint):','fix(format):','fix(fmt):','fix(lint):'];

function fail(code,message,details=null,httpStatus=422,mayHaveMutated=false){
  const error=new Error(message);error.code=code;error.details=details;error.httpStatus=httpStatus;error.may_have_mutated=mayHaveMutated;throw error;
}
function mechanical(message){const text=String(message||'').trim().toLowerCase();return MECHANICAL_PREFIXES.some(prefix=>text.startsWith(prefix));}
function requireLease(value){const text=typeof value==='string'?value.trim():'';if(!text||text.length>128)fail('INVALID_REQUEST','lease_ref must be a bounded non-empty string',{field:'lease_ref'});return text;}
function observedHead(value){const raw=typeof value==='string'?value:value?.sha;const head=String(raw||'').trim().toLowerCase();if(!SHA40.test(head))fail('GITHUB_INVALID_RESPONSE','managed workspace head is unavailable or invalid',{phase:'coalesce.workspace_head',may_have_mutated:false},502);return head;}
function validate(input,workspace){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('INVALID_REQUEST','request must be an object');
  const unknown=Object.keys(input).filter(key=>!['lease_ref','changes','commit_message'].includes(key)).sort();
  if(unknown.length)fail('INVALID_REQUEST','mechanical coalescing cannot include caller-selected Git coordinates',{unknown});
  const lease_ref=requireLease(input.lease_ref);
  if(!mechanical(input.commit_message))fail('MECHANICAL_CHANGESET_REQUIRED','coalescing accepts only mechanical cleanup changesets',{commit_message:input.commit_message});
  const normalized=normalizeGithubChangesetRequest({repo:workspace.repository,base_sha:workspace.authority_revision,branch:workspace.branch,changes:input.changes,commit_message:input.commit_message});
  return{lease_ref,changes:normalized.changes,commit_message:normalized.commit_message};
}
function sameLease(receipt,lease_ref,head){const authority=receipt?.execution_authority||{};return receipt?.commit_sha===head&&(authority.lease_id===lease_ref||authority.lease_ref===lease_ref);}
function entriesFor(changes,existing){return changes.map(change=>{const current=existing.get(change.path)||null;if(change.operation==='create'&&current)fail('CREATE_TARGET_EXISTS','create target already exists',{path:change.path},409);if(change.operation==='update'&&!current)fail('UPDATE_TARGET_MISSING','update target does not exist',{path:change.path},409);if(change.operation==='delete'&&!current)fail('DELETE_TARGET_MISSING','delete target does not exist',{path:change.path},409);if(current&&(change.operation==='update'||change.operation==='delete')&&(current.type!=='blob'||!['100644','100755'].includes(String(current.mode))))fail('UNSUPPORTED_TARGET_TYPE','coalescing supports regular files only',{path:change.path});if(change.operation==='delete')return{path:change.path,mode:current.mode,type:'blob',sha:null};return{path:change.path,mode:current?.mode||'100644',type:'blob',content:change.content};});}

export async function coalesceGithubLeaseScopedMechanicalChangeset(input,options={}){
  const executionAuthority=options.executionAuthority;const readBranch=options.readBranch;const withGithub=options.withGithub;const priorReader=options.readPriorChangeset;
  if(!executionAuthority||typeof executionAuthority.require!=='function'||typeof readBranch!=='function'||typeof withGithub!=='function'||typeof priorReader!=='function')fail('EXECUTION_AUTHORITY_UNAVAILABLE','mechanical coalescing runtime is incomplete',null,503);
  const lease_ref=requireLease(input?.lease_ref);
  const authority=await executionAuthority.require({lease_ref});
  if(authority?.subject!=='project_transition')fail('LEASE_SCOPED_CHANGESET_PROJECT_TRANSITION_REQUIRED','mechanical coalescing requires project-transition authority',null,409);
  const workspace=await deriveProjectTransitionGithubWorkspace(authority);const request=validate(input,workspace);
  const head=observedHead(await readBranch({repo:workspace.repository,branch:workspace.branch,changes:request.changes}));
  const current=await executionAuthority.require({lease_ref,repository:workspace.repository});const currentWorkspace=await deriveProjectTransitionGithubWorkspace(current);
  if(currentWorkspace.workspace_digest!==workspace.workspace_digest)fail('EXECUTION_AUTHORITY_STALE','workspace authority changed before coalescing',null,409);
  const prior=await priorReader({repo:workspace.repository,branch:workspace.branch,commit_sha:head});
  if(!sameLease(prior,lease_ref,head))fail('MECHANICAL_COALESCE_AUTHORITY_MISMATCH','current head was not produced by this lease',{branch:workspace.branch,head},409);
  return withGithub({repo:workspace.repository,branch:workspace.branch,changes:request.changes},async github=>{
    const preflight=observedHead(await github.getBranch(workspace.repository,workspace.branch,{phase:'coalesce.preflight'}));if(preflight!==head)fail('HEAD_MISMATCH','workspace changed before coalescing',{expected_head:head,actual_head:preflight,may_have_mutated:false},409);
    const mechanicalHead=await github.getCommit(workspace.repository,head);if(!mechanical(mechanicalHead.message)||mechanicalHead.parents?.length!==1||!SHA40.test(String(mechanicalHead.parents[0]||'')))fail('MECHANICAL_COALESCE_PARENT_INVALID','current head is not a single-parent mechanical commit',{head},409);
    const parent=String(mechanicalHead.parents[0]).toLowerCase();const existing=await github.getPathEntries(workspace.repository,mechanicalHead.tree_sha,request.changes.map(change=>change.path));const treeEntries=entriesFor(request.changes,existing);
    const beforeObjects=observedHead(await github.getBranch(workspace.repository,workspace.branch,{phase:'coalesce.before_objects'}));if(beforeObjects!==head)fail('HEAD_MISMATCH','workspace changed before replacement object creation',{expected_head:head,actual_head:beforeObjects,may_have_mutated:false},409);
    const tree=await github.createTree(workspace.repository,mechanicalHead.tree_sha,treeEntries);const replacement=await github.createCommit(workspace.repository,{message:request.commit_message,treeSha:tree,parentSha:parent});
    const beforeRef=observedHead(await github.getBranch(workspace.repository,workspace.branch,{phase:'coalesce.before_ref'}));if(beforeRef!==head)fail('HEAD_MISMATCH','workspace changed before replacement ref mutation',{expected_head:head,actual_head:beforeRef,may_have_mutated:true},409,true);
    await github.replaceBranch(workspace.repository,workspace.branch,head,replacement);
    const after=observedHead(await github.getBranch(workspace.repository,workspace.branch,{phase:'coalesce.readback'}));if(after!==replacement)fail('MECHANICAL_COALESCE_REF_INDETERMINATE','authoritative readback did not prove the replacement ref',{expected_head:replacement,actual_head:after,may_have_mutated:true},409,true);
    return{ok:true,coalesced:true,repo:workspace.repository,branch:workspace.branch,old_head:head,new_head:replacement,commit_sha:replacement,parent_sha:parent,tree_sha:tree,changed_paths:request.changes.map(({path,operation})=>({path,operation})),execution_authority:{lease_id:lease_ref,run_id:authority.run_id||null,authority_revision:workspace.authority_revision},mutation_certainty:'confirmed',may_have_mutated:true};
  });
}