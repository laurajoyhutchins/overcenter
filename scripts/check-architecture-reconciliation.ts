#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

import { loadArchitectureDatabase } from '../src/architecture/sql-model.ts';
import { reconcileArchitecture } from '../src/authority/architecture-reconciliation.ts';
import { observeArchitecture } from './observe-architecture.ts';

const sourceRevision =
  process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

const db = loadArchitectureDatabase();
try {
  const observed = observeArchitecture(db, sourceRevision);
  const reconciliation = reconcileArchitecture(db, observed);
  console.log(JSON.stringify(reconciliation, null, 2));
  if (reconciliation.findings.length > 0) process.exitCode = 1;
} finally {
  db.close();
}
