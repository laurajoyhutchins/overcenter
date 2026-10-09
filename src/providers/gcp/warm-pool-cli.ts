import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { observeGcpWarmPoolReadback } from './warm-pool-readback.ts';

const expectedSha = process.env.GITHUB_SHA ?? '';
const currentSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (
  process.env.GITHUB_REF !== 'refs/heads/main' ||
  process.env.GITHUB_REPOSITORY !== 'laurajoyhutchins/overcenter' ||
  !/^[0-9a-f]{40}$/.test(expectedSha) ||
  expectedSha !== currentSha
) {
  throw new Error('GCP_OBSERVER_UNTRUSTED_SOURCE_REVISION');
}

const token = process.env.GCP_OBSERVER_ACCESS_TOKEN ?? '';
const receipt = observeGcpWarmPoolReadback(token, {
  project: 'project-6b810532-a302-48dc-b56',
  zone: 'us-west1-a',
  mig: 'overcenter-gce-runners',
  autoscaler: 'overcenter-gce-runners-g2ow',
  subscription: 'overcenter-gce-runners',
  stabilization_seconds: 2700,
  source_sha: expectedSha,
});

const json = JSON.stringify(receipt, null, 2) + '\n';
if (process.env.GCP_OBSERVER_RECEIPT_PATH) {
  writeFileSync(process.env.GCP_OBSERVER_RECEIPT_PATH, json, { flag: 'wx', mode: 0o600 });
}
process.stdout.write(json);
if (receipt.observation !== 'observed' || receipt.policy !== 'matches') {
  process.exitCode = 2;
}
