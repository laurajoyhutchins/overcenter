import { readFileSync } from 'node:fs';
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
  });

  const inspection = await host.inspect({ project_ref:'github:laurajoyhutchins/overcenter' });
  assertEqual(calls, ['github:laurajoyhutchins/overcenter'], 'project.inspect must read the requested GitHub project authority');
  assertEqual(inspection, {
    ok:true,
    project_ref:'github:laurajoyhutchins/overcenter',
    authority_revision:'0123456789abcdef0123456789abcdef01234567',
    complete:false,
    frontier:['compact-agent-semantic-surface'],
  }, 'project.inspect must return a canonical successful command result from authoritative graph state');
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
  const service = projectInspectForGitHub({ db:{ async query() { throw new Error('not called during composition'); } } });
  if (typeof service?.inspect !== 'function') {
    throw new Error('GitHub project.inspect runtime must compose the provider-neutral semantic host');
  }
}

async function testGitHubRuntimeUsesDeployCompatibleStaticComposition() {
  const source = readFileSync(new URL('./project-inspect-github-runtime.js', import.meta.url), 'utf8');
  if (source.includes('await import(')) {
    throw new Error('GitHub project.inspect runtime must not depend on dynamic module loading in the production isolate');
  }
}

export async function runProjectInspectOvercenterHostTests() {
  await testProjectsInspectThroughAuthoritativeGraphBoundary();
  await testProjectInspectHostRequiresInjectedGraphReader();
  await testGitHubRuntimeOwnsProviderComposition();
  await testGitHubRuntimeUsesDeployCompatibleStaticComposition();
  return { ok:true, tests:4 };
}