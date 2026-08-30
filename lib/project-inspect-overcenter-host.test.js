import assert from 'node:assert/strict';
import { projectInspectFor } from './project-inspect-overcenter-host.js';

async function testProjectsInspectThroughAuthoritativeGraphBoundary() {
  const calls = [];
  const host = projectInspectFor({
    readProjectGraph: async ({ project_ref }) => {
      calls.push(project_ref);
      return Object.freeze({ schema:'project-execution-graph-v1', project_ref, authority:Object.freeze({ kind:'github', repository:'laurajoyhutchins/overcenter', revision:'0123456789abcdef0123456789abcdef01234567', derivation:'overcenter-project-graph-v1' }), nodes:Object.freeze([]) });
    },
    evaluateProjectHorizon: () => Object.freeze({ complete:false, frontier:Object.freeze([{ id:'compact-agent-semantic-surface' }]) }),
  });

  const inspection = await host.inspect({ project_ref:'github:laurajoyhutchins/overcenter' });
  assert.deepEqual(calls, ['github:laurajoyhutchins/overcenter']);
  assert.deepEqual(inspection, {
    project_ref:'github:laurajoyhutchins/overcenter',
    authority_revision:'0123456789abcdef0123456789abcdef01234567',
    complete:false,
    frontier:['compact-agent-semantic-surface'],
  });
}

export async function runProjectInspectOvercenterHostTests() {
  await testProjectsInspectThroughAuthoritativeGraphBoundary();
  return { ok:true, tests:1 };
}