// Runtime adapter behavior is exercised directly below.
import { projectInspectFor } from './project-inspect-overcenter-host.js';

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

async function testWorkerOwnsProviderGraphRuntimeBinding() {
  const { executeSemanticWorkerCommand } = await import('./worker-transport.js');
  const calls = [];
  const response = await executeSemanticWorkerCommand('project.inspect', { project_ref:'github:laurajoyhutchins/overcenter' }, {
    projectInspect:{
      async inspect(input) {
        calls.push(input);
        return { ok:true, project_ref:input.project_ref, authority_revision:'0123456789abcdef0123456789abcdef01234567', complete:false, frontier:['compact-agent-semantic-surface'] };
      },
    },
    logger:{ error() {} },
  });
  if (response.status !== 200 || response.body?.ok !== true || calls.length !== 1) {
    throw new Error('project.inspect worker transport must delegate to the runtime-owned semantic adapter');
  }
}

export async function runProjectInspectOvercenterHostTests() {
  await testProjectsInspectThroughAuthoritativeGraphBoundary();
  await testWorkerOwnsProviderGraphRuntimeBinding();
  return { ok:true, tests:2 };
}