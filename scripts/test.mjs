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

async function nativeTestFiles(directory) {
  const entries = await readdir(new URL(`${directory}/`, root), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await nativeTestFiles(relative));
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(relative);
  }
  return files;
}

const nativeTests = await nativeTestFiles('scripts');

// Keep the legacy lib/ registry verified until those suites have all moved to node:test.
run(['scripts/verify-regression-suite-registry.mjs']);
run(['scripts/verify-orchestration-drive.mjs']);
run(['--test', ...nativeTests.sort()]);

for (const directory of ['api', 'lib', 'mcp', 'pages']) {
  for (const file of await javascriptFiles(directory)) run(['--check', file]);
}
