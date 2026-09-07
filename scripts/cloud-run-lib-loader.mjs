import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('lib/')) {
    return { url:pathToFileURL(resolvePath(root, specifier)).href, shortCircuit:true };
  }
  return nextResolve(specifier, context);
}