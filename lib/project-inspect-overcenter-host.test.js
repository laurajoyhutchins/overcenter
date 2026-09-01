import { projectInspectFor } from './project-inspect-overcenter-host.js';
import { projectInspectForGitHub } from './project-inspect-github-runtime.js';

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}

async function testProjectsInspectThroughAuthoritativeGraphBoundary() {
  const calls = [];
  const host = projectInspectFor({
    readProjectGraph: async ({ project_ref }) => {
      calls.push(project_ref);
      return Object.freeze({
        schema:'project-graph-authority-v1',
        project_ref,
        authority:Object.freeze({
          definition:Object.freeze({
            kind:'github',
            repository:'laurajoyhutchins/overcenter',
            revision:'0123456789abcdef0123456789abcdef01234567',
            derivation:'overcenter-project-graph-v1',
          }),
          observations:Object.freeze([]),
        }),
        nodes:Object.freeze([]),
        horizons:Object.freeze([]),
      });
    },
    evaluateProjectHorizon: () => Object.freeze({ complete:false, frontier:Object.freeze([{ id:'compact-agent-semantic-surface' }]) }),
    activeLeasesForTransition: async () => [],
    now:() => '2026-09-01T15:00:00.000Z',
  });

  const inspection = await host.inspect({ project_ref:'github:laurajoyhutchins/overcenter' });
  assertEqual(calls, ['github:laurajoyhutchins/overcenter'], 'project.inspect must read the requested GitHub project authority');
  assertEqual(inspection, {
    ok:true,
    project_ref:'github:laurajoyhutchins/overcenter',
    authority_revision:'0123456789abcdef0123456789abcdef01234567',
    complete:false,
    frontier:['compact-agent-semantic-surface'],
    frontier_status:[{
      transition_id:'compact-agent-semantic-surface',
      availability:'AVAILABLE',
      occupied:false,
      expires_at:null,
    }],
    frontier_status_truncated:false,
  }, 'project.inspect must return decision-relevant frontier occupancy with authoritative graph state');
}

async function testProjectInspectReportsOccupiedFrontierWithoutLeaseSecrets() {
  const host = projectInspectFor({
    readProjectGraph: async ({ project_ref }) => Object.freeze({
      schema:'project-graph-authority-v1',
      project_ref,
      authority:Object.freeze({ definition:Object.freeze({
        kind:'github', repository:'laurajoyhutchins/overcenter', revision:'0123456789abcdef0123456789abcdef01234567', derivation:'overcenter-project-graph-v1',
      }), observations:Object.freeze([]) }),
      nodes:Object.freeze([]),
      horizons:Object.freeze([]),
    }),
    evaluateProjectHorizon: () => Object.freeze({ complete:false, frontier:Object.freeze([{ id:'claimed-work' }]) }),
    activeLeasesForTransition: async () => [{ lease_id:'secret-ish-id', run_id:'internal-run', expires_at:'2026-09-01T16:00:00.000Z' }],
    now:() => '2026-09-01T15:00:00.000Z',
  });
  const inspection = await host.inspect({ project_ref:'github:laurajoyhutchins/overcenter' });
  assertEqual(inspection.frontier_status, [{ transition_id:'claimed-work', availability:'OCCUPIED', occupied:true, expires_at:'2026-09-01T16:00:00.000Z' }], 'occupied frontier state was not exposed');
  if (JSON.stringify(inspection).includes('secret-ish-id') || JSON.stringify(inspection).includes('internal-run')) {
    throw new Error('project.inspect leaked lease or run identity instead of bounded occupancy');
  }
}

async function testProjectInspectHostRequiresInjectedGraphReader() {
  let error = null;
  try {
    projectInspectFor({ evaluateProjectHorizon: () => Object.freeze({ complete:false, frontier:Object.freeze([]) }) });
  } catch (caught) {
    error = caught;
  }
  if (error?.code !== 'PROJECT_INSPECT_RUNTIME_INVALID') {
    throw new Error('project.inspect semantic host must reject missing injected graph authority instead of loading a provider runtime');
  }
}

async function testGitHubRuntimeOwnsProviderComposition() {
  const service = projectInspectForGitHub({
    db:{ async query() { throw new Error('not called during composition'); } },
    createGitHubProjectGraphRuntime: () => Object.freeze({}),
  });
  if (typeof service?.inspect !== 'function') {
    throw new Error('GitHub project.inspect runtime must compose the provider-neutral semantic host');
  }
}

async function testGitHubRuntimeRequiresExplicitProviderBinding() {
  let error = null;
  try {
    projectInspectForGitHub({ db:{} });
  } catch (caught) {
    error = caught;
  }
  if (error?.code !== 'PROJECT_INSPECT_RUNTIME_INVALID') {
    throw new Error('GitHub project.inspect runtime must require provider composition from the host boundary');
  }
}

export async function runProjectInspectOvercenterHostTests() {
  await testProjectsInspectThroughAuthoritativeGraphBoundary();
  await testProjectInspectReportsOccupiedFrontierWithoutLeaseSecrets();
  await testProjectInspectHostRequiresInjectedGraphReader();
  await testGitHubRuntimeOwnsProviderComposition();
  await testGitHubRuntimeRequiresExplicitProviderBinding();
  return { ok:true, tests:5 };
}