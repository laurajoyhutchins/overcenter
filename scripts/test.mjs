import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

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

run(['scripts/verify-regression-suite-registry.mjs']);
run(['scripts/verify-orchestration-drive.mjs']);

const scriptTests = (await readdir(new URL('scripts/', root)))
  .filter(name => name.endsWith('.test.mjs') && name !== 'node-postgres-runtime.test.mjs')
  .sort()
  .map(name => `scripts/${name}`);
run(['--test', ...scriptTests]);

for (const directory of ['api', 'lib', 'mcp', 'pages']) {
  for (const file of await javascriptFiles(directory)) run(['--check', file]);
}