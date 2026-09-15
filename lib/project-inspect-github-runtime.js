import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { createProjectTransitionLeasePostgresStore } from './project-transition-lease-store.js';
import { createCompactProviderOperationPostgresStore } from './compact-provider-operation-store.js';
import { createPromotionAwareProjectTransitionLeaseService } from './project-transition-promotion-release.js';
import { projectInspectFor } from './project-inspect-overcenter-host.js';

function invalid(message){const error=new Error(message);error.code='PROJECT_INSPECT_RUNTIME_INVALID';throw error;}
function timestamp(value){if(!value)return null;if(value instanceof Date)return value.toISOString();return String(value);}
function revisionOf(graph){return String(graph?.authority?.definition?.revision||'').trim().toLowerCase();}
function snapshotLeaseStore(store,observedAt){
  return new Proxy(store,{
    get(target,property,receiver){
      if(property==='getLatestSettledLeaseForTransition'){
        return (projectRef,transitionId,requestedObservedAt=observedAt)=>target.getLatestSettledLeaseForTransition(projectRef,transitionId,requestedObservedAt);
      }
      const value=Reflect.get(target,property,receiver);
      return typeof value==='function'?value.bind(target):value;
    },
  });
}

export function projectInspectForGitHub(options={}){
  const db=options.db;
  const withGitHubAppApiClient=options.withGitHubAppApiClient;
  const createGitHubProjectGraphRuntime=options.createGitHubProjectGraphRuntime;
  const createProjectTransitionLeaseStore=options.createProjectTransitionLeaseStore||createProjectTransitionLeasePostgresStore;
  const createProviderOperationStore=options.createProviderOperationStore||createCompactProviderOperationPostgresStore;
  const now=typeof options.now==='function'?options.now:()=>new Date().toISOString();
  if(typeof createGitHubProjectGraphRuntime!=='function')invalid('project.inspect GitHub runtime factory is unavailable');
  if(typeof withGitHubAppApiClient!=='function')invalid('project.inspect GitHub auth provider is unavailable');
  return Object.freeze({
    async inspect(input){
      const observedAt=String(now());
      const graphRuntime=createGitHubProjectGraphRuntime({db,withGitHubAppApiClient});
      const authoritativeReader=createAuthoritativeProjectGraphReader(graphRuntime);
      let snapshotPromise=null;
      const readSnapshot=(request)=>{if(!snapshotPromise)snapshotPromise=authoritativeReader(request);return snapshotPromise;};
      const leaseStore=createProjectTransitionLeaseStore(db);
      const operationStore=createProviderOperationStore(db);
      const transitions=createPromotionAwareProjectTransitionLeaseService({store:snapshotLeaseStore(leaseStore,observedAt),operationStore,readProjectGraph:readSnapshot});
      const inspect=projectInspectFor({
        readProjectGraph:readSnapshot,
        now:()=>observedAt,
        readAuthoringOperations({project_ref}){return operationStore.listByScope({command:'project.authoring.recovery',scope:`project:${project_ref}`,limit:8});},
        async readTransitionOccupancy({project_ref,transition_id,authority_revision,observed_at}){
          const graph=await readSnapshot({project_ref});
          if(revisionOf(graph)!==authority_revision)invalid('project.inspect transition decision snapshot drifted from graph authority');
          const[active,suspension]=await Promise.all([leaseStore.getActiveLeasesForTransition(project_ref,transition_id,observed_at),transitions.suspensionFor({project_ref,transition_id})]);
          const lease=active[0]||null;const suspended=Boolean(suspension);
          return Object.freeze({occupied:Boolean(lease),expires_at:timestamp(lease?.expires_at),authority_revision,lease_ref:lease?.lease_ref||lease?.lease_id||null,suspended,suspension_reason:suspended?'blocked_settlement_promotion':null,suspension:suspension||null});
        },
      });
      return inspect.inspect(input);
    },
  });
}
