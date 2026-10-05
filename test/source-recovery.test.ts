import assert from 'node:assert/strict';
import test from 'node:test';

import { integrateVerifiedSourceCandidate } from '../src/source/source-integration.ts';
import type { SourceClaimBinding } from '../src/source/source-obligation.ts';

test('retired direct-main integration fails closed before mutation', () => {
  const claim: SourceClaimBinding = {
    obligation_key: 'retired-source-integration',
    run_id: 'retired-run',
    claimed_revision: 'retired-revision',
    source_sha: '0000000000000000000000000000000000000000',
  };
  let mutationAttempted = false;

  const result = integrateVerifiedSourceCandidate(
    '',
    null,
    claim,
    'retired-obligation',
    '0000000000000000000000000000000000000000',
    null,
    {
      performReservedMutation: () => {
        mutationAttempted = true;
        return true;
      },
    },
  );

  assert.deepEqual(result, {
    state: 'REJECTED',
    reason: 'SOURCE_DIRECT_MAIN_INTEGRATION_RETIRED',
  });
  assert.equal(mutationAttempted, false);
});
