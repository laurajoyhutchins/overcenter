import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// Retired implementations remain conservatively counted under accepted bindings.
// Restoring them must never change the candidate's own dependency resolution.
export function restoreRetiredSources(
  root: string,
  acceptedPaths: readonly string[],
  candidatePaths: readonly string[],
  readAccepted: (path: string) => Uint8Array,
  references: (path: string) => readonly string[],
): void {
  const before = new Map(candidatePaths.map((path) => [path, [...references(path)].sort()]));
  for (const path of acceptedPaths) {
    if (!path.endsWith('.ts') || existsSync(join(root, path))) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), readAccepted(path));
  }
  for (const path of candidatePaths) {
    if (JSON.stringify([...references(path)].sort()) !== JSON.stringify(before.get(path))) {
      throw new Error(`TCB_RETIRED_SOURCE_SHADOWS_CANDIDATE:${path}`);
    }
  }
}

export function relativeReferences(root: string, path: string): string[] {
  const text = readFileSync(join(root, path), 'utf8');
  const refs: string[] = [];
  for (const match of text.matchAll(
    /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'](\.[^"']+)["']/g,
  )) {
    const base = resolve(root, dirname(path), match[1]!);
    const substituted = base.replace(
      /\.(?:js|mjs|cjs)$/,
      (ext) => ({ '.js': '.ts', '.mjs': '.mts', '.cjs': '.cts' })[ext]!,
    );
    const found = [substituted, base, `${base}.ts`, join(base, 'index.ts')].find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    );
    refs.push(found ? relative(root, found) : `unresolved:${match[1]}`);
  }
  return refs.sort();
}
