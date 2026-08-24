import { executeSemanticWorkerCommand } from 'lib/worker-transport.js';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function testCustomSkillExecutionReceivesRuntimeDatabase() {
  const runId = 'worker-transport-runtime-test';
  const activationId = '00000000-0000-4000-8000-00000000babe';
  const queries = [];
  const db = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('SELECT run_id,worker,status,skill_policy FROM orchestration_runs')) {
        return {
          rows: [{
            run_id: runId,
            worker: 'Repository Implementation',
            status: 'active',
            skill_policy: {
              schema: 'worker-skill-policy-v1',
              source: 'server',
              catalog_revision: 'worker-skills-v1',
              worker: 'Repository Implementation',
              required: [],
              available: [{
                name: 'systematic-debugging',
                revision: 'superpowers-systematic-debugging-v1',
                reference: 'skills://plugins/superpowers/systematic-debugging/skill.md',
              }],
              forbidden: [],
            },
          }],
        };
      }
      if (sql.includes('SELECT * FROM orchestration_skill_activations WHERE run_id=$1 AND skill_name=$2')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO orchestration_skill_activations')) {
        return {
          rows: [{
            activation_id: activationId,
            run_id: runId,
            skill_name: 'systematic-debugging',
            skill_revision: 'superpowers-systematic-debugging-v1',
            skill_reference: 'skills://plugins/superpowers/systematic-debugging/skill.md',
            reason: 'reproduce runtime forwarding',
            status: 'active',
            evidence: [],
            created_at: '2026-08-24T00:00:00.000Z',
            completed_at: null,
          }],
        };
      }
      return { rows: [] };
    },
  };

  const response = await executeSemanticWorkerCommand('skill.activate', {
    run_id: runId,
    skill: 'systematic-debugging',
    reason: 'reproduce runtime forwarding',
  }, { db, logger: { error() {} } });

  check(response.status === 200, 'skill.activate should execute through the supplied runtime database');
  check(response.body?.ok === true, 'skill.activate should return a successful command envelope');
  check(response.body?.activation_id === activationId, 'skill.activate should return the created activation');
  check(
    queries.some((sql) => sql.includes('SELECT run_id,worker,status,skill_policy FROM orchestration_runs')),
    'skill.activate did not reach the supplied runtime database',
  );
}

async function testCustomSkillCompletionReceivesRuntimeDatabase() {
  const runId = 'worker-transport-runtime-complete-test';
  const activationId = '00000000-0000-4000-8000-00000000cafe';
  const evidence = [{ kind: 'test', ref: 'runtime-forwarding' }];
  const queries = [];
  const activation = {
    activation_id: activationId,
    run_id: runId,
    skill_name: 'systematic-debugging',
    skill_revision: 'superpowers-systematic-debugging-v1',
    skill_reference: 'skills://plugins/superpowers/systematic-debugging/skill.md',
    reason: 'reproduce runtime forwarding',
    status: 'active',
    evidence: [],
    created_at: '2026-08-24T00:00:00.000Z',
    completed_at: null,
  };
  const db = {
    async query(sql, values = []) {
      queries.push(sql);
      if (sql.includes('SELECT * FROM orchestration_skill_activations WHERE activation_id=$1')) {
        return { rows: [activation] };
      }
      if (sql.includes('UPDATE orchestration_skill_activations')) {
        return {
          rows: [{
            ...activation,
            status: 'completed',
            evidence,
            completion_sha256: values[3] || null,
            completed_at: '2026-08-24T00:01:00.000Z',
          }],
        };
      }
      return { rows: [] };
    },
  };

  const response = await executeSemanticWorkerCommand('skill.complete', {
    run_id: runId,
    activation_id: activationId,
    outcome: 'completed',
    evidence,
  }, { db, logger: { error() {} } });

  check(response.status === 200, 'skill.complete should execute through the supplied runtime database');
  check(response.body?.ok === true, 'skill.complete should return a successful command envelope');
  check(response.body?.activation_id === activationId, 'skill.complete should return the completed activation');
  check(response.body?.status === 'completed', 'skill.complete should return the terminal skill state');
  check(
    queries.filter((sql) => sql.includes('SELECT * FROM orchestration_skill_activations WHERE activation_id=$1')).length >= 2,
    'skill.complete should use the supplied runtime database during canonicalization and execution',
  );
  check(
    queries.some((sql) => sql.includes('UPDATE orchestration_skill_activations')),
    'skill.complete did not persist completion through the supplied runtime database',
  );
}

export async function runWorkerTransportRuntimeTests() {
  await testCustomSkillExecutionReceivesRuntimeDatabase();
  await testCustomSkillCompletionReceivesRuntimeDatabase();
}
