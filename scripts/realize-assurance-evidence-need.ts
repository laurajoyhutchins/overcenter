import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { canonicalJson } from '../src/digest.ts';
import {
  realizeExecutionEvidenceOnGcp,
} from '../src/providers/gcp/execution-evidence-receipt.ts';
import type { AssuranceEvidenceNeed } from '../src/source/assurance-evidence-needs.ts';

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error('ASSURANCE_EVIDENCE_NEED_PATH_REQUIRED');
  const need = JSON.parse(readFileSync(path, 'utf8')) as AssuranceEvidenceNeed;
  const realization = await realizeExecutionEvidenceOnGcp(need);
  process.stdout.write(`${canonicalJson(realization)}\n`);
  if (realization.state !== 'observed') process.exitCode = 2;
  else if (realization.receipt.observation.result !== 'satisfied') process.exitCode = 1;
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypoint) {
  main().catch((error) => {
    console.error(String(error instanceof Error ? (error.stack ?? error.message) : error));
    process.exit(2);
  });
}
