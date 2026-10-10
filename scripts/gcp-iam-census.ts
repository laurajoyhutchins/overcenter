import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { collectGcpIamCensus } from '../src/providers/gcp/iam-census.ts';

// This one-time owner/auditor operator does not install IAM or authenticate.
// It reads from the gcloud session already active in the invoking environment.
// IAM and WIF receipts can contain sensitive identities: keep the output local.
const destination = process.env.GCP_IAM_CENSUS_OUTPUT;
if (!destination || !isAbsolute(destination)) {
  throw new Error('GCP_IAM_CENSUS_ABSOLUTE_PRIVATE_OUTPUT_REQUIRED');
}

const result = collectGcpIamCensus((args) =>
  execFileSync('gcloud', [...args], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
);

writeFileSync(destination, JSON.stringify(result, null, 2) + '\n', {
  flag: 'wx',
  mode: 0o600,
});
const failures = result.observations.filter((entry) => entry.outcome.state === 'indeterminate');
process.stdout.write(
  JSON.stringify({
    purpose: result.purpose,
    project: result.project,
    stored_private_receipt: true,
    readbacks_attempted: result.observations.length,
    indeterminate_readbacks: failures.map((entry) => entry.id),
    effective_permissions_established: false,
    authority_granted: false,
    independently_verified: false,
  }) + '\n',
);
if (failures.length > 0) process.exitCode = 2;
