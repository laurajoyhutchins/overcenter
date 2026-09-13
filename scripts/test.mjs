import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { auditRepository } from './test-audit.mjs';

const root = new URL('../', import.meta.url);
const cwd = fileURLToPath(root);

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function javascriptFiles(directory) {
  const entries = await readdir(new URL(`${directory}/`, root), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await javascriptFiles(relative));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(relative);
  }
  return files;
}

run(['scripts/verify-orchestration-drive.mjs']);

const audit = await auditRepository({ root: cwd });
if (audit.unresolved_count !== 0) {
  process.stderr.write(`${JSON.stringify(audit, null, 2)}\n`);
  process.exit(1);
}

// The revision-bound audit is the single source of truth for canonical test execution.
run(['--test', ...audit.files]);

for (const directory of ['api', 'lib', 'mcp', 'pages']) {
  for (const file of await javascriptFiles(directory)) run(['--check', file]);
}
