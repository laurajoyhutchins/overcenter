#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { reconcileArchitecture } from '../src/authority/architecture-reconciliation.ts';
import { loadArchitectureIntent } from '../src/architecture/sql-intent.ts';
import { observeArchitectureIntent } from './observe-architecture.ts';

const sourceRevision =
  process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const intent = loadArchitectureIntent();
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
