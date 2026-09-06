import { projectInspectFor } from './project-inspect-overcenter-host.js';
import { inspectOutcomeIntegrity } from './outcome-integrity-inspection.js';
import { projectInspectForGitHub } from './project-inspect-github-runtime.js';
import { runProjectAgentSessionBoundaryTests } from './project-agent-session-boundary-regression.js';

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}

async function testProjectsInspectThroughAuthoritativeGraphBoundary() {
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
  assertEqual(calls, ['github:laurajoyhutchins/overcenter'], 'project.inspect must read the requested GitHub project authority');
  assertEqual(occupancyCalls, [
    { project_ref:'github:laurajoyhutchins/overcenter', transition_id:'compact-agent-semantic-surface', observed_at:observedAt },
    { project_ref:'github:laurajoyhutchins/overcenter', transition_id:'other-ready-work', observed_at:observedAt },
  ], 'project.inspect must derive bounded occupancy for each READY transition');
  assertEqual(inspection, {
    ok:true,
    project_ref:'github:laurajoyhutchins/overcenter',
    authority_revision:'0123456789abcdef0123456789abcdef01234567',
    complete:false,
    frontier:['compact-agent-semantic-surface','other-ready-work'],
    frontier_details:[
      { id:'compact-agent-semantic-surface', availability:'occupied', occupied:true, expires_at:'2026-09-01T15:45:00.000Z' },
      { id:'other-ready-work', availability:'available', occupied:false, expires_at:null },
    ],
  }, 'project.inspect must return canonical frontier identity plus decision-relevant occupancy');
}

async function testProjectInspectBoundsOccupancyReads() {
  const occupancyCalls = [];
  const observedAt = '2026-09-01T15:20:00.000Z';
  const ids = Object.freeze(Array.from({ length:12 }, (_, index) => `ready-${index + 1}`));
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
      return Object.freeze({ occupied:false, expires_at:null });
    },
  });

  const inspection = await host.inspect({ project_ref:'github:laurajoyhutchins/overcenter' });
  assertEqual(
    occupancyCalls.map((call) => call.transition_id),
    ids.slice(0, 8),
    'project.inspect must cap occupancy reads instead of fanning out across an unbounded frontier',
  );
  assertEqual(inspection.frontier, ids, 'bounded occupancy must not truncate authoritative frontier identity');
  assertEqual(
    inspection.frontier_details.slice(0, 8).map((detail) => detail.availability),
    Array(8).fill('available'),
    'queried frontier occupancy must remain decision-relevant',
  );
  assertEqual(
    inspection.frontier_details.slice(8),
    ids.slice(8).map((id) => ({ id, availability:'unknown', occupied:null, expires_at:null })),
    'unqueried frontier occupancy must remain explicitly unknown rather than fabricated',
  );
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

async function testOutcomeIntegrityInspectionBindsExactAuthorityAndFindsDeterministicGaps() {
  const inspection = inspectOutcomeIntegrity({
    project_ref:'github:laurajoyhutchins/overcenter',
    authority:{ revision:'0123456789abcdef0123456789abcdef01234567', derivation:'overcenter-project-graph-v1', semantic_identity:'graph-semantic-1' },
    horizon:{ kind:'project', ref:'github:laurajoyhutchins/overcenter', root:'ship-intended-outcome' },
    obligations:[
      { id:'implement', establishes:['artifact-exists'], requires:[], evidence_bindings:['source-readback'] },
      { id:'verify', establishes:['verified-artifact'], requires:['artifact-exists'], evidence_bindings:[] },
      { id:'orphan-cleanup', establishes:['formatting-clean'], requires:[], evidence_bindings:['lint'] },
    ],
    assumptions:[{ id:'github-source-authority', owner:'github', establishes:['source-authoritative'] }],
    root_claim:{ id:'ship-intended-outcome', requires:['verified-artifact','production-reachable'] },
  });
  assertEqual(inspection.schema, 'outcome-integrity-inspection-v0', 'inspection must expose the v0 contract');
  assertEqual(inspection.binding, {
    project_ref:'github:laurajoyhutchins/overcenter',
    authority_revision:'0123456789abcdef0123456789abcdef01234567',
    authority_derivation:'overcenter-project-graph-v1',
    graph_semantic_identity:'graph-semantic-1',
    review_contract_version:'outcome-integrity-v0',
    horizon:{ kind:'project', ref:'github:laurajoyhutchins/overcenter', root:'ship-intended-outcome' },
  }, 'inspection must be exact-revision and horizon bound');
  const ids = inspection.findings.map((finding) => finding.finding_id).sort();
  assertEqual(ids, ['missing-evidence-binding:verify','missing-producer:production-reachable','orphan-work:orphan-cleanup'], 'deterministic structural gaps must be surfaced');
  if (typeof inspection.semantically_valid === 'boolean') throw new Error('reasoning review must not collapse to semantically_valid');
  if (!Array.isArray(inspection.argument_steps) || !Array.isArray(inspection.unresolved_proof_obligations)) throw new Error('inspection must expose structured reasoning boundary');
}

async function testOutcomeIntegrityInspectionInvalidatesStaleReviewAndFindsLeafSuccessCounterexample() {
  const input = {
    project_ref:'github:laurajoyhutchins/overcenter',
    authority:{ revision:'0123456789abcdef0123456789abcdef01234567', derivation:'overcenter-project-graph-v1' },
    horizon:{ kind:'project', ref:'github:laurajoyhutchins/overcenter', root:'packet-only-execution-is-sufficient' },
    obligations:[
      { id:'packet', establishes:['packet-returned'], requires:[], evidence_bindings:['packet-schema'] },
      { id:'agent', establishes:['agent-reported-success'], requires:['packet-returned'], evidence_bindings:['agent-report'] },
    ],
    assumptions:[],
    root_claim:{ id:'packet-only-execution-is-sufficient', requires:['authoritative-effect-observed'] },
    synthetic_outcome:{ all_leaf_acceptance:true, root_claim_true:false },
  };
  const inspection = inspectOutcomeIntegrity(input);
  if (!inspection.findings.some((finding) => finding.finding_id === 'all-leaves-pass-root-remains-false' && finding.kind === 'defeater')) {
    throw new Error('falsification must surface a coherent leaf-success/root-false counterexample');
  }
  let stale = null;
  try {
    inspectOutcomeIntegrity({ ...input, prior_review:{ ...inspection.binding, authority_revision:'f'.repeat(40) } });
  } catch (error) { stale = error; }
  if (stale?.code !== 'OUTCOME_INTEGRITY_REVIEW_STALE') throw new Error('revision change must invalidate prior review');
}

export async function runProjectInspectOvercenterHostTests() {
  await testProjectsInspectThroughAuthoritativeGraphBoundary();
  await testProjectInspectBoundsOccupancyReads();
  await testProjectInspectHostRequiresInjectedGraphReader();
  await testGitHubRuntimeOwnsProviderComposition();
  await testGitHubRuntimeRequiresExplicitProviderBinding();
  await testOutcomeIntegrityInspectionBindsExactAuthorityAndFindsDeterministicGaps();
  await testOutcomeIntegrityInspectionInvalidatesStaleReviewAndFindsLeafSuccessCounterexample();
  const agentSession = await runProjectAgentSessionBoundaryTests();
  return { ok:true, tests:7 + agentSession.tests };
}
