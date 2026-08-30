import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectAuthoringWorkerBinding } from '../lib/project-authoring-host-runtime.js';

const initialRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('worker binding preserves explicit injection and otherwise composes bounded host capabilities', () => {
  const injected = { define() {}, amend() {} };
  const binding = createProjectAuthoringWorkerBinding({
    createGraphRuntime:({ db }) => ({ marker:db.marker }),
    readRepositoryDisposition:async (repository, { db }) => ({ repository, disposition:db.disposition }),
    applyGithubChangeset:async () => ({ ok:true, new_head:'b'.repeat(40) }),
    deriveProjectGraph:async ({ authority }) => ({ schema:'overcenter-project-graph-v1', revision:authority.revision }),
  });

  assert.equal(binding({ projectAuthoring:injected }), injected);
  const composed = binding({ db:{ marker:'host-db', disposition:'ACTIVE' } });
  assert.equal(typeof composed.define, 'function');
  assert.equal(typeof composed.amend, 'function');
});