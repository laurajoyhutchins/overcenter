import test from 'node:test';
import assert from 'node:assert/strict';
import { projectArtifactBindingFor } from '../lib/project-artifact-binding-github-runtime.js';

const SHA = '40e902e1eec442fb76d4a23e7c2469f4a5207f15';

test('runtime persists content-addressed binding evidence idempotently through the injected database', async () => {
  let storedSha = null;
  const queries = [];
  const db = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.startsWith('INSERT INTO portfolio_observations')) {
        storedSha = params[5];
        return { rows:[] };
      }
      if (sql.startsWith('SELECT observation_id,payload_sha256')) {
        return { rows:[{ observation_id:42, payload_sha256:storedSha }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const binding = projectArtifactBindingFor({
    db,
    readProjectGraph:async () => ({
      authority:{ definition:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:SHA, derivation:'overcenter-project-graph-v1' } },
      nodes:[{ id:'add-project-artifact-binding' }],
    }),
    readProviderArtifact:async () => ({ repository:'laurajoyhutchins/overcenter', kind:'issue', number:732, state:'closed' }),
  });

  const result = await binding.bind({
    project_ref:'github:laurajoyhutchins/overcenter',
    expected_revision:SHA,
    transition_id:'add-project-artifact-binding',
    provider:{ kind:'issue', number:732 },
    relationship:'full_coverage_equivalence',
    satisfaction_condition:'closed',
  });

  assert.equal(result.ok, true);
  assert.equal(result.observation_ref, 'portfolio_observation:42');
  assert.match(result.binding.binding_ref, /^sha256:[0-9a-f]{64}$/);
  assert.equal(queries.length, 2);
  assert.match(queries[0].params[0], /^project-artifact-binding-v1:sha256:/);
  assert.equal(queries[0].params[2], SHA);
});
