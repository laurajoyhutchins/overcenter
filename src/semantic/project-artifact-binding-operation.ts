import { createProjectArtifactBinding, type ProjectArtifactBinding } from './project-artifact-binding.js';

type BindingInput=Readonly<{project_ref:string;transition_id:string;expected_revision:string;provider:Readonly<{repository:string;kind:'issue'|'pull_request';id:number}>;relationship:'full-coverage-equivalence';satisfaction:Readonly<{kind:'provider-closed';requires_exact_binding:true}>}>;
type Dependencies=Readonly<{inspectProject:(input:{project_ref:string})=>Promise<any>;readProviderArtifact:(provider:{repository:string;kind:'issue'|'pull_request';id:number})=>Promise<any>;persistBinding:(binding:ProjectArtifactBinding)=>Promise<any>}>;
function fail(code:string,message:string,details:any=null):never{const error=new Error(message) as Error&{code:string;details:any};error.code=code;error.details=details;throw error;}
function exactRevision(value:unknown):string{const revision=typeof value==='string'?value.trim().toLowerCase():'';if(!/^[0-9a-f]{40}$/.test(revision))fail('PROJECT_ARTIFACT_BINDING_INVALID','expected_revision must be an exact Git revision');return revision;}
function providerRequest(input:any){const repository=typeof input?.repository==='string'?input.repository.trim():'';const kind=input?.kind;const id=Number(input?.id);if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)||!['issue','pull_request'].includes(kind)||!Number.isInteger(id)||id<1)fail('PROJECT_ARTIFACT_BINDING_INVALID','provider identity is invalid');return {repository,kind,id} as {repository:string;kind:'issue'|'pull_request';id:number};}
export function createProjectArtifactBindingOperation(dependencies:Dependencies){
 if(typeof dependencies?.inspectProject!=='function'||typeof dependencies?.readProviderArtifact!=='function'||typeof dependencies?.persistBinding!=='function')fail('PROJECT_ARTIFACT_BINDING_UNAVAILABLE','project artifact binding dependencies are unavailable');
 return Object.freeze({async bind(input:BindingInput){
  const expected=exactRevision(input?.expected_revision);
  const first=await dependencies.inspectProject({project_ref:input?.project_ref});
  if(String(first?.authority_revision||'').toLowerCase()!==expected)fail('PROJECT_ARTIFACT_BINDING_AUTHORITY_STALE','project authority moved before provider observation',{expected_revision:expected,actual_revision:first?.authority_revision||null});
  const provider=providerRequest(input?.provider);
  const observed=await dependencies.readProviderArtifact(provider);
  if(!observed||observed.repository!==provider.repository||observed.kind!==provider.kind||Number(observed.id)!==provider.id)fail('PROJECT_ARTIFACT_BINDING_PROVIDER_MISMATCH','provider readback did not match requested identity');
  const second=await dependencies.inspectProject({project_ref:input?.project_ref});
  if(String(second?.authority_revision||'').toLowerCase()!==expected)fail('PROJECT_ARTIFACT_BINDING_AUTHORITY_STALE','project authority moved before binding persistence',{expected_revision:expected,actual_revision:second?.authority_revision||null});
  const binding=createProjectArtifactBinding({project_ref:input.project_ref,transition_id:input.transition_id,authority_revision:expected,relationship:input.relationship,provider:observed,satisfaction:input.satisfaction});
  const persisted=await dependencies.persistBinding(binding);
  if(!persisted?.binding||JSON.stringify(persisted.binding)!==JSON.stringify(binding))fail('PROJECT_ARTIFACT_BINDING_PERSISTENCE_INDETERMINATE','durable binding readback did not match intended binding');
  return Object.freeze({ok:true,outcome:persisted.created?'bound':'already_bound',binding_id:persisted.binding_id,binding:persisted.binding});
 }});
}