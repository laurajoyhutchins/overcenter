import {
  WORK_SURFACE_DISPOSITIONS,
  classifyWorkSurfaceProjection,
  canonicalExecutableSourceKey,
  frontierLimitForProject,
} from './work-surface-policy.js';

function assert(value, message) { if (!value) throw new Error(message); }

export async function runWorkSurfacePolicyTests() {
  const tests = [];
  async function test(name, fn) { try { await fn(); tests.push({ name, ok: true }); } catch (error) { tests.push({ name, ok: false, error: String(error?.message || error) }); } }

  await test('strict executable action is admitted', async () => {
    const result = classifyWorkSurfaceProjection({
      disposition: 'KEEP_EXECUTABLE', outcome: 'Ship bounded fix', next_action: 'Modify the parser and add regression coverage',
      actor: 'worker', changes_authority_or_produces_evidence: true,
    });
    assert(result.disposition === 'KEEP_EXECUTABLE' && result.visible === true && result.linear_state === 'Todo', 'executable work was not admitted');
  });

  await test('missing concrete next action is not admitted', async () => {
    const result = classifyWorkSurfaceProjection({
      disposition: 'KEEP_EXECUTABLE', outcome: 'Improve architecture', next_action: '', actor: 'worker', changes_authority_or_produces_evidence: true,
    });
    assert(result.disposition === 'NO_EXECUTABLE_ACTION' && result.visible === false, 'actionless work remained executable');
  });

  await test('deterministic bookkeeping becomes DERIVED_STATE', async () => {
    const result = classifyWorkSurfaceProjection({
      disposition: 'KEEP_EXECUTABLE', outcome: 'Observe three green cycles', next_action: 'Count completed scheduler cycles',
      actor: 'deterministic', changes_authority_or_produces_evidence: true,
    });
    assert(result.disposition === 'DERIVED_STATE' && result.visible === false, 'deterministic bookkeeping was admitted');
  });

  await test('human wait remains visible but not ordinary Todo', async () => {
    const result = classifyWorkSurfaceProjection({
      disposition: 'WAITING_HUMAN', outcome: 'Approve desktop smoke result', next_action: 'Run the desktop smoke and decide disposition',
      actor: 'human', changes_authority_or_produces_evidence: true, promotion_condition: 'Owner completes the desktop smoke.',
    });
    assert(result.disposition === 'WAITING_HUMAN' && result.visible === true && result.linear_state === 'Backlog', 'human wait projection incorrect');
  });

  await test('external blocker remains visible only with a concrete promotion condition', async () => {
    const result = classifyWorkSurfaceProjection({
      disposition: 'BLOCKED_EXTERNAL', outcome: 'Run host canary', next_action: 'Execute canary after host is online',
      actor: 'external', changes_authority_or_produces_evidence: true, promotion_condition: 'Persistent Linux host is online and reachable.',
    });
    assert(result.disposition === 'BLOCKED_EXTERNAL' && result.visible === true && result.linear_state === 'Backlog', 'external blocker projection incorrect');
  });

  await test('terminal dispositions never become visible', async () => {
    for (const disposition of ['HISTORICAL_REFERENCE','SUPERSEDED','DUPLICATE','DISPOSED_REPOSITORY','NO_EXECUTABLE_ACTION']) {
      const result = classifyWorkSurfaceProjection({ disposition, outcome: 'Historical', next_action: 'None', actor: 'none', changes_authority_or_produces_evidence: false });
      assert(result.visible === false, `${disposition} became visible`);
    }
  });

  await test('source unit gives a stable distinct identity under one roadmap issue', async () => {
    const a = canonicalExecutableSourceKey({ repo:'Owner/Repo', issue_number:46, unit_key:'US-GU' });
    const b = canonicalExecutableSourceKey({ repo:'owner/repo', issue_number:46, unit_key:'US-WY' });
    assert(a !== b && a.includes('unit:us-gu') && b.includes('unit:us-wy'), 'roadmap unit identity was not stable/distinct');
  });

  await test('canonical key deduplicates multiple source observations', async () => {
    const a = canonicalExecutableSourceKey({ repo:'owner/a', issue_number:1, canonical_key:'runtime.same-outcome' });
    const b = canonicalExecutableSourceKey({ repo:'owner/b', issue_number:2, canonical_key:'runtime.same-outcome' });
    assert(a === b && a === 'canonical:runtime.same-outcome', 'canonical executable key did not deduplicate');
  });

  await test('U.S. jurisdiction campaign has a bounded frontier of three', async () => {
    assert(frontierLimitForProject('U.S. Jurisdiction Coverage') === 3, 'jurisdiction frontier is not bounded to three');
  });

  await test('disposition enum stays intentionally small and complete', async () => {
    const expected = ['KEEP_EXECUTABLE','BLOCKED_EXTERNAL','WAITING_HUMAN','DERIVED_STATE','HISTORICAL_REFERENCE','SUPERSEDED','DUPLICATE','DISPOSED_REPOSITORY','NO_EXECUTABLE_ACTION'];
    assert(JSON.stringify([...WORK_SURFACE_DISPOSITIONS]) === JSON.stringify(expected), 'work-surface disposition contract drifted');
  });

  return { ok: tests.every(test => test.ok), passed: tests.filter(test => test.ok).length, failed: tests.filter(test => !test.ok).length, tests };
}