import { commandSuccess } from '../lib/command-response.js';

const commands = [
  'portfolio.repository.branch_roles.ensure',
  'github.production_branch_policy.reconcile',
  'github.production.promote',
];

for (const command of commands) {
  const result = commandSuccess(command, { ok: true }, { observed_at: '2026-08-27T00:00:00.000Z' });
  if (result.command !== command || result.schema_version !== 'command-response-v1') {
    throw new Error(`canonical command envelope mismatch: ${command}`);
  }
}

console.log(`registered ${commands.length} branch-role commands`);
