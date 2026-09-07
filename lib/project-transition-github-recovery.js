export const PROJECT_TRANSITION_RECOVERY_SEED_PATH = '.overcenter/recovery/hatchable-cutover-v1.json';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const API_HEADERS = Object.freeze({
  Accept:'application/vnd.github+json',
  'X-GitHub-Api-Version':'2026-03-10',
  'User-Agent':'Overcenter/1.0',
});

function fail(code, message, details = null) {
  throw Object.assign(new Error(message), { code, details });
}

function encodeRepository(repository) {
  return repository.split('/').map(encodeURIComponent).join('/');
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function decodeFileText(body) {
  if (!body || body.type !== 'file' || body.truncated === true || String(body.encoding || '').toLowerCase() !== 'base64' || typeof body.content !== 'string') {
    fail('PROJECT_RECOVERY_SEED_INVALID', 'GitHub recovery seed content is incomplete');
  }
  const binary = atob(body.content.replace(/\s+/g, ''));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  try { return new TextDecoder('utf-8', { fatal:true }).decode(bytes); }
  catch { fail('PROJECT_RECOVERY_SEED_INVALID', 'GitHub recovery seed must be UTF-8'); }
}

export function parseProjectTransitionRecoverySeed(text, expected = {}) {
  let seed;
  try { seed = JSON.parse(String(text || '')); }
  catch { fail('PROJECT_RECOVERY_SEED_INVALID', 'GitHub recovery seed is not valid JSON'); }
  if (!seed || seed.schema !== 'overcenter-github-recovery-seed-v1') fail('PROJECT_RECOVERY_SEED_INVALID', 'GitHub recovery seed schema is unsupported');
  if (seed.project_ref !== expected.project_ref || seed.repository !== expected.repository) {
    fail('PROJECT_RECOVERY_SEED_MISMATCH', 'GitHub recovery seed belongs to a different project', {
      expected_project_ref:expected.project_ref,
      observed_project_ref:seed.project_ref || null,
      expected_repository:expected.repository,
      observed_repository:seed.repository || null,
    });
  }
  if (!Array.isArray(seed.transition_confirmations)) fail('PROJECT_RECOVERY_SEED_INVALID', 'GitHub recovery seed transition_confirmations must be an array');
  return Object.freeze(seed.transition_confirmations.map((entry, index) => {
    const transitionId = String(entry?.transition_id || '').trim();
    const fingerprint = String(entry?.transition_definition_fingerprint || '').trim().toLowerCase();
    const revision = String(entry?.source_authority_revision || '').trim().toLowerCase();
    const settledAt = String(entry?.settled_at || '').trim();
    if (!transitionId || !SHA256.test(fingerprint) || !SHA40.test(revision) || !Number.isFinite(Date.parse(settledAt))) {
      fail('PROJECT_RECOVERY_SEED_INVALID', 'GitHub recovery seed contains an invalid transition confirmation', { index });
    }
    return Object.freeze({
      schema:'project-transition-observation-v1',
      kind:'project_transition_confirmation',
      project_ref:seed.project_ref,
      transition_id:transitionId,
      transition_definition_fingerprint:fingerprint,
      disposition:'completed',
      authority:Object.freeze({
        kind:'github',
        repository:seed.repository,
        revision,
        derivation:'overcenter-project-graph-v1',
      }),
      provenance:Object.freeze({
        kind:'github_recovery_seed',
        ref:PROJECT_TRANSITION_RECOVERY_SEED_PATH,
        settled_at:settledAt,
      }),
    });
  }));
}

export async function readProjectTransitionRecoverySeedWithGitHubApp(input = {}, options = {}) {
  const repository = String(input.repository || '').trim();
  const revision = String(input.revision || '').trim().toLowerCase();
  const projectRef = String(input.project_ref || '').trim();
  const withApp = options.withGitHubAppApiClient;
  if (!repository || !SHA40.test(revision) || !projectRef || typeof withApp !== 'function') {
    fail('PROJECT_RECOVERY_SEED_RUNTIME_INVALID', 'exact GitHub recovery seed authority is required');
  }
  return withApp(repository, async (apiClient) => {
    const response = await apiClient.call('github', {
      method:'GET',
      path:`/repos/${encodeRepository(repository)}/contents/${encodePath(PROJECT_TRANSITION_RECOVERY_SEED_PATH)}`,
      query:{ ref:revision },
      headers:API_HEADERS,
    });
    if (Number(response?.status || 0) === 404) return Object.freeze([]);
    if (Number(response?.status || 0) !== 200) fail('PROJECT_RECOVERY_SEED_READ_FAILED', 'GitHub recovery seed read failed', { upstream_status:Number(response?.status || 0) || null });
    return parseProjectTransitionRecoverySeed(decodeFileText(response.body), { project_ref:projectRef, repository });
  }, { permissionProfile:'project_facts' });
}

export function mergeProjectTransitionObservations(...groups) {
  const byConfirmation = new Map();
  for (const observation of groups.flat()) {
    if (!observation || observation.kind !== 'project_transition_confirmation') continue;
    const key = `${observation.project_ref}\n${observation.transition_id}\n${observation.transition_definition_fingerprint}`;
    const previous = byConfirmation.get(key);
    const previousTime = Date.parse(String(previous?.provenance?.settled_at || ''));
    const nextTime = Date.parse(String(observation?.provenance?.settled_at || ''));
    if (!previous || !Number.isFinite(previousTime) || (Number.isFinite(nextTime) && nextTime >= previousTime)) byConfirmation.set(key, observation);
  }
  return Object.freeze([...byConfirmation.values()].sort((a, b) => String(a.transition_id).localeCompare(String(b.transition_id))));
}