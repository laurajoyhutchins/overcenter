import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { createGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { withGitHubAppApiClient } from './github-app-auth.js';
import { createProjectArtifactBindingService } from './project-artifact-binding.js';
import { createPostgresProjectArtifactBindingStore } from './project-artifact-binding-store.js';
function repoPath(repository){return repository.split('/').map(encodeURIComponent).join('/');}
function artifactPath(artifact){const base=`/repos/${repoPath(artifact.repository)}`; return artifact.kind==='pull_request'?`${base}/pulls/${artifact.number}`:`${base}/issues/${artifact.number}`;}
export function projectArtifactBindingFor(options={}) {
  const db=options.db; const graphRuntimeFactory=options.createGitHubProjectGraphRuntime||createGitHubProjectGraphRuntime; const withApp=options.withGitHubAppApiClient||withGitHubAppApiClient; const store=options.store||createPostgresProjectArtifactBindingStore(db); const readProjectGraph=createAuthoritativeProjectGraphReader(graphRuntimeFactory({db}));
  return createProjectArtifactBindingService({
    async readProjectAuthority({project_ref}) { const graph=await readProjectGraph({project_ref}); const definition=graph.authority.definition; return {kind:definition.kind,repository:definition.repository,revision:definition.revision,derivation:definition.derivation,transition_ids:graph.nodes.map((node)=>node.id)}; },
    async readArtifact(artifact) { return withApp(artifact.repository,async(apiClient)=>{ const response=await apiClient.call('github',{method:'GET',path:artifactPath(artifact),headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'Overcenter/1.0'}}); if(Number(response?.status||0)!==200||!response?.body?.node_id){const error=new Error('GitHub artifact readback failed'); error.code='PROJECT_ARTIFACT_BINDING_PROVIDER_READ_FAILED'; error.status=response?.status||null; throw error;} if(artifact.kind==='issue'&&response.body.pull_request){const error=new Error('requested issue identity resolves to a pull request'); error.code='PROJECT_ARTIFACT_BINDING_ARTIFACT_MISMATCH'; throw error;} return {...artifact,node_id:String(response.body.node_id),state:String(response.body.state||'').toLowerCase()}; },{permissionProfile:'artifact_binding'}); },
    appendEvent:store.appendEvent,readCurrentBinding:store.readCurrentBinding,
  });
}
