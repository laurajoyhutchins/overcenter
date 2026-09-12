import assert from 'node:assert/strict';
import test from 'node:test';

import { projectInspectFor } from './project-inspect-overcenter-host.js';
import { projectInspectForGitHub } from './project-inspect-github-runtime.js';
import { runProjectAgentSessionBoundaryTests } from './project-agent-session-boundary-regression.js';

test('projects inspect through authoritative graph boundary', async () => {
  const calls = [];
  const occupancyCalls = [];
  const observedAt = '2026-09-01T15:20:00.000Z';
  const host = projectInspectFor({
    now:() => observedAt,
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
    evaluateProjectHorizon: () => Object.freeze({
      complete:false,
      frontier:Object.freeze([
        { id:'compact-agent-semantic-surface' },
        { id:'other-ready-work' },
      ]),
    }),
    readTransitionOccupancy:async(input) => {
      occupancyCalls.push(input);
      return input.transition_id === 'compact-agent-semantic-surface'
        ? Object.freeze({ occupied:true, expires_at:'2026-09-01T15:45:00.000Z' })
        : Object.freeze({ occupied:false, expires_at:null });
    },
  });

  const inspection = await host.inspect({ project_ref:'github:laurajoyhutchins/overcenter' });
  assert.deepEqual(calls, ['github:laurajoyhutchins/overcenter']);
  assert.deepEqual(occupancyCalls, [
    { project_ref:'github:laurajoyhutchins/overcenter', transition_id:'compact-agent-semantic-surface', authority_revision:'0123456789abcdef0123456789abcdef01234567', observed_at:observedAt, transition:{ id:'compact-agent-semantic-surface' } },
    { project_ref:'github:laurajoyhutchins/overcenter', transition_id:'other-ready-work', authority_revision:'0123456789abcdef0123456789abcdef01234567', observed_at:observedAt, transition:{ id:'other-ready-work' } },
  ]);
  assert.deepEqual(inspection, {
    ok:true,
    project_ref:'github:laurajoyhutchins/overcenter',
    authority_revision:'0123456789abcdef0123456789abcdef01234567',
    complete:false,
    frontier:['compact-agent-semantic-surface','other-ready-work'],
    frontier_details:[
      { id:'compact-agent-semantic-surface', availability:'occupied', occupied:true, expires_at:'2026-09-01T15:45:00.000Z' },
      { id:'other-ready-work', availability:'available', occupied:false, expires_at:null },
    ],
    authoring_operations:[],
  });
});

test('project inspect bounds occupancy concurrency without truncating frontier', async () => {
  const occupancyCalls = [];
  const observedAt = '2026-09-01T15:20:00.000Z';
  const ids = Object.freeze(Array.from({ length:12 }, (_, index) => `ready-${index + 1}`));
  let inFlight = 0;
  let maxInFlight = 0;
  const host = projectInspectFor({
    now:() => observedAt,
    readProjectGraph:async({ project_ref }) => Object.freeze({
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
    }),
    evaluateProjectHorizon:() => Object.freeze({
      complete:false,
      frontier:Object.freeze(ids.map((id) => Object.freeze({ id }))),
    }),
    readTransitionOccupancy:async(input) => {
      occupancyCalls.push(input);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return Object.freeze({ occupied:false, expires_at:null });
    },
  });

  const inspection = await host.inspect({ project_ref:'github:laurajoyhutchins/overcenter' });
  assert.deepEqual(occupancyCalls.map((call) => call.transition_id), ids);
  assert.ok(maxInFlight <= 8, 'project.inspect must bound occupancy read concurrency without truncating the frontier');
  assert.deepEqual(inspection.frontier, ids);
  assert.deepEqual(inspection.frontier_details.map((detail) => detail.availability), Array(ids.length).fill('available'));
});

test('project inspect does not present blocked settlement as available', async () => {
  const observedAt = '2026-09-06T08:00:00.000Z';
  const host = projectInspectFor({
    now:() => observedAt,
    readProjectGraph:async({ project_ref }) => Object.freeze({
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
    }),
    evaluateProjectHorizon:() => Object.freeze({ complete:false, frontier:Object.freeze([{ id:'blocked-ready-work' }]) }),
    readTransitionOccupancy:async() => Object.freeze({ occupied:false, expires_at:null, suspended:true, suspension_reason:'blocked_settlement_promotion' }),
  });

  const inspection = await host.inspect({ project_ref:'github:laurajoyhutchins/overcenter' });
  assert.deepEqual(inspection.frontier_details, [{
    id:'blocked-ready-work', availability:'waiting', occupied:false, expires_at:null, suspended:true, wait_reason:'blocked_settlement_promotion',
  }]);
});

test('project inspect host requires injected graph reader', () => {
  assert.throws(
    () => projectInspectFor({ evaluateProjectHorizon: () => Object.freeze({ complete:false, frontier:Object.freeze([]) }) }),
    (error) => error?.code === 'PROJECT_INSPECT_RUNTIME_INVALID',
  );
});

test('GitHub runtime owns provider composition', () => {
  const service = projectInspectForGitHub({
    db:{ async query() { throw new Error('not called during composition'); } },
    withGitHubAppApiClient:async () => {},
    createGitHubProjectGraphRuntime: () => Object.freeze({}),
  });
  assert.equal(typeof service?.inspect, 'function');
});

test('GitHub runtime requires explicit provider binding', () => {
  assert.throws(
    () => projectInspectForGitHub({ db:{} }),
    (error) => error?.code === 'PROJECT_INSPECT_RUNTIME_INVALID',
  );
});

test('project agent session boundary regressions remain covered during migration', async () => {
  const result = await runProjectAgentSessionBoundaryTests();
  assert.equal(result.ok, true);
  assert.ok(result.tests > 0);
});
