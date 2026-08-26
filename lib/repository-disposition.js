import { api, db } from 'hatchable';
import { withGitHubAppApiClient } from './github-app-auth.js';
import { createLinearRepositoryCoordinateProjection, createPostgresRepositoryIdentityStore, normalizeGitHubRepositoryId } from './repository-identity.js';

export const REPOSITORY_DISPOSITIONS = Object.freeze(['ACTIVE','MAINTENANCE','DORMANT','ARCHIVED','SUPERSEDED']);
const DISPOSED = new Set(['ARCHIVED','SUPERSEDED']);
const ORDINARY_WORK = new Set(['ACTIVE','MAINTENANCE']);

function lifecycleError(code, message, details = null, status = 409) {
  const error = new Error(message); error.code = code; error.status = status; error.details = details; return error;
}

export function canonicalRepository(value) {
  const repository = String(value || '').trim().replace(/^`|`$/g, '').replace(/[.,;:]+$/g, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw lifecycleError('INVALID_REPOSITORY', 'repository must be owner/name', { repository:value || null }, 422);
  return repository;
}

function normalizedDisposition(value) {
  const disposition = String(value || '').trim().toUpperCase();
  if (!REPOSITORY_DISPOSITIONS.includes(disposition)) throw lifecycleError('INVALID_REPOSITORY_DISPOSITION', 'unknown repository disposition', { disposition:value || null }, 422);
  return disposition;
}

export function repositoryHealthProjection(lifecycle) {
  const disposition = normalizedDisposition(lifecycle?.disposition || 'ACTIVE');
  if (DISPOSED.has(disposition)) return { classification:'disposed_as_intended', include_in_active_health:false };
  if (disposition === 'DORMANT') return { classification:'dormant_as_intended', include_in_active_health:false };
  return { classification: disposition === 'MAINTENANCE' ? 'maintenance' : 'active', include_in_active_health:true };
}

export function repositoryControlsProjection(lifecycle) {
  const disposition = normalizedDisposition(lifecycle?.disposition || 'ACTIVE');
  const energized = ORDINARY_WORK.has(disposition);
  return { power_state:energized ? 'ENERGIZED' : 'DE_ENERGIZED', disconnect_position:energized ? 'CLOSED' : 'OPEN', permissives:{ ordinary_work:energized, issue_discovery:energized, linear_projection:energized, fast_forward:energized, scheduled_workers:energized } };
}

function project(row, changed = false) {
  const disposition = normalizedDisposition(row.disposition);
  const ordinaryWorkEnabled = ORDINARY_WORK.has(disposition);
  return { repository:canonicalRepository(row.repository), github_repository_id:row.github_repository_id == null ? null : normalizeGitHubRepositoryId(row.github_repository_id), disposition, successor_repository:row.successor_repository ? canonicalRepository(row.successor_repository) : null, github_archived:row.github_archived === true, github_observed_at:row.github_observed_at || null, ordinary_work_enabled:ordinaryWorkEnabled, issue_discovery_eligible:ordinaryWorkEnabled, linear_projection_enabled:ordinaryWorkEnabled, fast_forward_eligible:ordinaryWorkEnabled, scheduled_worker_target:ordinaryWorkEnabled, controls:repositoryControlsProjection({ disposition }), health:repositoryHealthProjection({ disposition }), transition_reason:row.transition_reason || null, transitioned_at:row.transitioned_at || null, updated_at:row.updated_at || null, changed };
}

export function createPostgresRepositoryDispositionStore(dbBinding = db) {
  const identity = createPostgresRepositoryIdentityStore(dbBinding);
  return { ...identity,
    async get(repository) { const canonical=canonicalRepository(repository); const result=await dbBinding.query('SELECT * FROM portfolio_repository_disposition WHERE lower(repository)=lower($1) LIMIT 1',[canonical]); return result.rows?.[0]||null; },
    async put(row) {
      const result=await dbBinding.query(`INSERT INTO portfolio_repository_disposition
        (repository, github_repository_id, disposition, compatibility_bound, compatibility_reference, successor_repository, github_archived, github_observed_at, transition_reason, transitioned_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (repository) DO UPDATE SET github_repository_id=COALESCE(portfolio_repository_disposition.github_repository_id, EXCLUDED.github_repository_id), disposition=EXCLUDED.disposition, compatibility_bound=false, compatibility_reference=NULL, successor_repository=EXCLUDED.successor_repository, github_archived=EXCLUDED.github_archived, github_observed_at=EXCLUDED.github_observed_at, transition_reason=EXCLUDED.transition_reason, transitioned_at=EXCLUDED.transitioned_at, updated_at=EXCLUDED.updated_at
        WHERE portfolio_repository_disposition.github_repository_id IS NULL OR EXCLUDED.github_repository_id IS NULL OR portfolio_repository_disposition.github_repository_id=EXCLUDED.github_repository_id RETURNING *`,[row.repository,row.github_repository_id||null,row.disposition,false,null,row.successor_repository||null,row.github_archived===true,row.github_observed_at||null,row.transition_reason||null,row.transitioned_at,row.updated_at]);
      if(!result.rows?.[0]) throw lifecycleError('REPOSITORY_IDENTITY_COORDINATE_CONFLICT','repository coordinate is already bound to a different GitHub repository id',{repository:row.repository,github_repository_id:row.github_repository_id||null},409); return result.rows[0];
    },
    async list(){const result=await dbBinding.query('SELECT * FROM portfolio_repository_disposition ORDER BY lower(repository)');return result.rows||[];},
  };
}

export function createGitHubRepositoryObserver(options={}) {
  const withApp=options.withGitHubAppApiClient||withGitHubAppApiClient;
  return {async getRepository(repositoryInput){const repository=canonicalRepository(repositoryInput);const [owner,repo]=repository.split('/');return withApp(repository,async(client)=>{const response=await client.call('github',{path:`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`});if(!response||response.status<200||response.status>=300) throw lifecycleError('GITHUB_REPOSITORY_OBSERVATION_FAILED',`GitHub returned HTTP ${response?.status??'unknown'}`,{repository,upstream_status:response?.status||null},response?.status===404?404:502);return response.body;},{permissionProfile:'portfolio_reconcile'});}};
}

function semanticEqual(existing,desired){if(!existing)return false;return Number(existing.github_repository_id||0)===Number(desired.github_repository_id||0)&&String(existing.disposition)===String(desired.disposition)&&existing.compatibility_bound!==true&&!existing.compatibility_reference&&String(existing.successor_repository||'').toLowerCase()===String(desired.successor_repository||'').toLowerCase()&&Boolean(existing.github_archived)===Boolean(desired.github_archived)&&String(existing.transition_reason||'')===String(desired.transition_reason||'');}

export function createRepositoryLifecycleService({store,github,coordinateProjection=null,now=()=>new Date().toISOString()}={}) {
  if(!store||!github) throw new TypeError('store and github are required');

  async function rebindKnownIdentity(byIdentity,repository,githubRepositoryId){
    const fromRepository=canonicalRepository(byIdentity.repository);
    if(fromRepository.toLowerCase()===repository.toLowerCase()) return byIdentity;
    const conflict=await store.get(repository);
    if(conflict&&Number(conflict.github_repository_id||0)!==githubRepositoryId) throw lifecycleError('REPOSITORY_IDENTITY_COORDINATE_CONFLICT','renamed repository coordinate is already owned by a different GitHub repository id',{repository,github_repository_id:githubRepositoryId,conflicting_github_repository_id:conflict.github_repository_id||null},409);
    const workIdentities=typeof store.listWorkIdentities==='function'?await store.listWorkIdentities(fromRepository):[];
    if(coordinateProjection?.rebind) await coordinateProjection.rebind(workIdentities,fromRepository,repository);
    if(typeof store.rebindRepositoryIdentity!=='function') throw lifecycleError('REPOSITORY_IDENTITY_REBIND_UNAVAILABLE','repository identity store cannot rebind renamed coordinates',{from_repository:fromRepository,to_repository:repository},500);
    const rebound=await store.rebindRepositoryIdentity({github_repository_id:githubRepositoryId,from_repository:fromRepository,to_repository:repository,updated_at:now()});
    if(!rebound) throw lifecycleError('REPOSITORY_IDENTITY_REBIND_FAILED','repository identity rebind did not persist',{from_repository:fromRepository,to_repository:repository},500);
    return rebound;
  }

  async function reconcileLegacyIdentities(targetId=null,targetRepository=null){
    if(typeof store.listUnbound!=='function'||typeof store.bindGitHubRepositoryId!=='function') return null;
    const rows=await store.listUnbound();
    let targetMatch=null;
    for(const row of rows){
      const oldRepository=canonicalRepository(row.repository);
      let observed;
      try{observed=await github.getRepository(oldRepository);}catch(error){if(error?.status===404)continue;throw error;}
      if(!observed?.id) throw lifecycleError('REPOSITORY_IDENTITY_AMBIGUOUS','GitHub observation did not provide immutable repository id',{repository:oldRepository},409);
      const observedId=normalizeGitHubRepositoryId(observed.id);
      const canonical=canonicalRepository(observed.full_name||oldRepository);
      const existingById=typeof store.getByGitHubRepositoryId==='function'?await store.getByGitHubRepositoryId(observedId):null;
      let bound=existingById||await store.bindGitHubRepositoryId(oldRepository,observedId)||row;
      if(canonical.toLowerCase()!==oldRepository.toLowerCase()) bound=await rebindKnownIdentity(bound,canonical,observedId);
      if(targetId!=null&&observedId===targetId&&(!targetRepository||canonical.toLowerCase()===targetRepository.toLowerCase())) targetMatch=bound;
    }
    return targetMatch;
  }

  async function resolveIdentity(repositoryInput){
    const requestedRepository=canonicalRepository(repositoryInput);const githubRepository=await github.getRepository(requestedRepository);if(!githubRepository)throw lifecycleError('REPOSITORY_NOT_FOUND','repository was not found',{repository:requestedRepository},404);const repository=canonicalRepository(githubRepository.full_name||requestedRepository);const githubRepositoryId=normalizeGitHubRepositoryId(githubRepository.id);
    let byIdentity=typeof store.getByGitHubRepositoryId==='function'?await store.getByGitHubRepositoryId(githubRepositoryId):null;let byCoordinate=await store.get(repository);
    if(!byIdentity&&!byCoordinate){byIdentity=await reconcileLegacyIdentities(githubRepositoryId,repository);byCoordinate=await store.get(repository);}
    if(byIdentity&&canonicalRepository(byIdentity.repository).toLowerCase()!==repository.toLowerCase()){byIdentity=await rebindKnownIdentity(byIdentity,repository,githubRepositoryId);byCoordinate=byIdentity;}
    else if(!byIdentity&&byCoordinate?.github_repository_id!=null&&Number(byCoordinate.github_repository_id)!==githubRepositoryId) throw lifecycleError('REPOSITORY_IDENTITY_COORDINATE_CONFLICT','repository coordinate belongs to a different GitHub repository id',{repository,github_repository_id:githubRepositoryId,conflicting_github_repository_id:byCoordinate.github_repository_id},409);
    else if(!byIdentity&&byCoordinate&&byCoordinate.github_repository_id==null&&typeof store.bindGitHubRepositoryId==='function'){byCoordinate=await store.bindGitHubRepositoryId(repository,githubRepositoryId)||byCoordinate;byIdentity=byCoordinate;}
    return {githubRepository,repository,githubRepositoryId,existing:byIdentity||byCoordinate||null};
  }

  async function observe(repositoryInput){const resolved=await resolveIdentity(repositoryInput);const {githubRepository,repository,githubRepositoryId}=resolved;const archived=githubRepository.archived===true;const existing=resolved.existing;const observedAt=now();let disposition=existing?.disposition?normalizedDisposition(existing.disposition):'ACTIVE';let reason=existing?.transition_reason||'github_observed_active';let transitionedAt=existing?.transitioned_at||observedAt;if(archived&&!DISPOSED.has(disposition)){disposition='ARCHIVED';reason='github_archived_observed';transitionedAt=observedAt;}const desired={repository,github_repository_id:githubRepositoryId,disposition,successor_repository:existing?.successor_repository||null,github_archived:archived,github_observed_at:observedAt,transition_reason:reason,transitioned_at:transitionedAt,updated_at:observedAt};const changed=!semanticEqual(existing,desired);return project(await store.put(desired),changed);}
  async function dispose(input={}){const disposition=normalizedDisposition(input.disposition||'ARCHIVED');if(!DISPOSED.has(disposition))throw lifecycleError('INVALID_DISPOSAL_TARGET','dispose accepts only ARCHIVED or SUPERSEDED',{disposition},422);const resolved=await resolveIdentity(input.repository);const canonical=resolved.repository;const githubArchived=resolved.githubRepository?.archived===true;const existing=resolved.existing;if(disposition==='ARCHIVED'&&!githubArchived)throw lifecycleError('GITHUB_REPOSITORY_NOT_ARCHIVED','ARCHIVED disposition requires authoritative GitHub archived state',{repository:canonical},409);const successor=input.successor_repository===undefined?(existing?.successor_repository||null):(input.successor_repository?canonicalRepository(input.successor_repository):null);if(successor&&successor.toLowerCase()===canonical.toLowerCase())throw lifecycleError('INVALID_SUCCESSOR_REPOSITORY','a repository cannot succeed itself',{repository:canonical},422);if(Object.prototype.hasOwnProperty.call(input,'compatibility_bound')||Object.prototype.hasOwnProperty.call(input,'compatibility_reference'))throw lifecycleError('LEGACY_CONTROL_PLANE_RETIRED','repository compatibility work was retired with the Agent Execution Control Plane; disposed repositories cannot retain a compatibility execution exception',{repository:canonical,replacement:'overcenter'},410);const timestamp=now();const reason=String(input.reason||existing?.transition_reason||'repository_disposed').slice(0,500);const desired={repository:canonical,github_repository_id:resolved.githubRepositoryId,disposition,successor_repository:successor,github_archived:githubArchived,github_observed_at:timestamp,transition_reason:reason,transitioned_at:existing&&semanticEqual(existing,{...existing,github_repository_id:resolved.githubRepositoryId,disposition,successor_repository:successor,github_archived:githubArchived,transition_reason:reason})?existing.transitioned_at:timestamp,updated_at:timestamp};const changed=!semanticEqual(existing,desired);return project(await store.put(desired),changed);}
  async function transition(input={}){const target=normalizedDisposition(input.disposition);const resolved=await resolveIdentity(input.repository);const repository=resolved.repository;const existing=resolved.existing;if(!existing)throw lifecycleError('REPOSITORY_DISPOSITION_NOT_FOUND','repository has no lifecycle record to transition',{repository},404);if(input.expected_disposition&&normalizedDisposition(input.expected_disposition)!==normalizedDisposition(existing.disposition))throw lifecycleError('REPOSITORY_DISPOSITION_CHANGED','repository disposition no longer matches expected_disposition',{repository,expected_disposition:normalizedDisposition(input.expected_disposition),actual_disposition:normalizedDisposition(existing.disposition)},409);const githubArchived=resolved.githubRepository?.archived===true;if(githubArchived&&!DISPOSED.has(target))throw lifecycleError('GITHUB_REPOSITORY_ARCHIVED','GitHub archived state prohibits transition to an active lifecycle',{repository,target},409);const timestamp=now();const saved=await store.put({repository,github_repository_id:resolved.githubRepositoryId,disposition:target,successor_repository:DISPOSED.has(target)?existing.successor_repository||null:null,github_archived:githubArchived,github_observed_at:timestamp,transition_reason:String(input.reason||'explicit_lifecycle_transition').slice(0,500),transitioned_at:timestamp,updated_at:timestamp});return {ok:true,...project(saved,true)};}
  async function verify(repositoryInput){const lifecycle=await observe(repositoryInput);return {ok:true,repository:lifecycle.repository,github_repository_id:lifecycle.github_repository_id,disposition:lifecycle.disposition,successor:lifecycle.successor_repository,ordinary_work_enabled:lifecycle.ordinary_work_enabled,linear_projection_enabled:lifecycle.linear_projection_enabled,scheduled_worker_target:lifecycle.scheduled_worker_target,fast_forward_eligible:lifecycle.fast_forward_eligible,controls:lifecycle.controls,health_classification:lifecycle.health.classification,checks:{github_archived:lifecycle.github_archived,executable_portfolio_work:lifecycle.ordinary_work_enabled?'eligible_by_lifecycle':'prohibited_by_lifecycle',linear_projection:lifecycle.linear_projection_enabled?'enabled':'disabled',scheduled_workers:lifecycle.scheduled_worker_target?'eligible':'none',fast_forward_eligible:lifecycle.fast_forward_eligible,issue_discovery_eligible:lifecycle.issue_discovery_eligible,successor_recorded:Boolean(lifecycle.successor_repository)}};}
  return {observe,dispose,transition,verify};
}

export function createPostgresRepositoryLifecycleService(options={}){return createRepositoryLifecycleService({store:createPostgresRepositoryDispositionStore(options.db||db),github:options.github||createGitHubRepositoryObserver(options),coordinateProjection:options.coordinateProjection||createLinearRepositoryCoordinateProjection({apiBinding:options.api||api}),now:options.now});}
export function statusForRepositoryDispositionError(error){if(Number.isInteger(error?.status))return error.status;if(/INVALID_|_CHANGED$|_ARCHIVED$|_DISPOSED$|_CONFLICT$|_AMBIGUOUS$/.test(String(error?.code||'')))return 409;return 500;}