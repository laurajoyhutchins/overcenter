#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { CodeWitnessReport } from '../src/repository/code-witness.ts';
import { planCodeDeletions } from './lib/code-deletion-plan.ts';

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error('CODE_DELETION_PLAN_ARGUMENT_REQUIRED:' + name);
  return value;
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const expected = process.env.SOURCE_SHA;
if (expected && expected !== head) {
  throw new Error('CODE_DELETION_PLAN_SOURCE_REVISION_MISMATCH:' + expected + ':' + head);
}
const limitText = argValue('--limit');
const limit = limitText === null ? undefined : Number(limitText);
const output = argValue('--output');
const temporary = mkdtempSync(join(tmpdir(), 'overcenter-code-deletion-plan-'));
const reportPath = join(temporary, 'witness-report.json');

try {
  execFileSync(
    process.execPath,
    ['--experimental-strip-types', 'scripts/report-code-witnesses.ts', '--output', reportPath],
    { env: { ...process.env, SOURCE_SHA: head }, stdio: 'inherit' },
  );
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as CodeWitnessReport;
  const plan = planCodeDeletions(report, limit);
  const serialized = JSON.stringify(plan, null, 2) + '\n';
  if (output) writeFileSync(resolve(output), serialized);
  else process.stdout.write(serialized);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
