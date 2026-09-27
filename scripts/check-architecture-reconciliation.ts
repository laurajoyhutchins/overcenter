#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  reconcileArchitecture,
  validateArchitectureIntent,
} from '../src/authority/architecture-reconciliation.ts';
import { observeArchitectureIntent } from './observe-architecture.ts';

const sourceRevision =
  process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const intent = validateArchitectureIntent(
  JSON.parse(readFileSync('.overcenter/architecture-intent.json', 'utf8')),
);
const observations = observeArchitectureIntent(intent, sourceRevision);
const reconciliation = reconcileArchitecture({
  intent,
  source_revision: sourceRevision,
  observations,
});

console.log(JSON.stringify(reconciliation, null, 2));

if (reconciliation.resolutions.some((resolution) => resolution.state !== 'established')) {
  process.exitCode = 1;
}
