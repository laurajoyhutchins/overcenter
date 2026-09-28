#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

import { buildProvenCodeDeletionSourceProposal } from '../src/repository/code-deletion-handoff.ts';

function argValue(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(name + '_REQUIRES_VALUE');
  return value;
}

const assignment = JSON.parse(readFileSync(argValue('--assignment'), 'utf8'));
const handoff = JSON.parse(readFileSync(argValue('--handoff'), 'utf8'));
const proposal = buildProvenCodeDeletionSourceProposal(assignment, handoff);
const output = JSON.stringify(proposal, null, 2) + '\n';
const outputPath = process.argv.includes('--output') ? argValue('--output') : null;
if (outputPath) writeFileSync(outputPath, output);
else process.stdout.write(output);
