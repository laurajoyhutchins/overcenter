import { readFileSync, writeFileSync } from 'node:fs';

import { runSourceWorktreeAdapter } from '../transport/source-worktree-adapter.ts';

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name}_REQUIRES_VALUE`);
  return value;
}

const separator = process.argv.indexOf('--');
if (separator < 0 || separator === process.argv.length - 1) {
  throw new Error('SOURCE_WORKER_COMMAND_REQUIRED');
}
const assignmentPath = option('--assignment');
const outputPath = option('--output');
const command = process.argv[separator + 1]!;
const args = process.argv.slice(separator + 2);
const assignment = JSON.parse(readFileSync(assignmentPath, 'utf8'));

const result = runSourceWorktreeAdapter(process.cwd(), assignment, { command, args });
writeFileSync(outputPath, `${JSON.stringify(result.proposal, null, 2)}\n`);
process.stderr.write(`${JSON.stringify(result.worker)}\n`);
