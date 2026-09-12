import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

async function filesUnder(root, directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

export async function discoverScriptTests(root) {
  return (await filesUnder(root, 'scripts'))
    .filter((file) => file.endsWith('.test.mjs'))
    .sort();
}

export async function discoverNativeLibTests(root) {
  const candidates = (await filesUnder(root, 'lib'))
    .filter((file) => file.endsWith('.test.js'))
    .sort();
  const native = [];
  for (const file of candidates) {
    const source = await readFile(path.join(root, file), 'utf8');
    if (/from\s+['"]node:test['"]/.test(source)) native.push(file);
  }
  return native;
}