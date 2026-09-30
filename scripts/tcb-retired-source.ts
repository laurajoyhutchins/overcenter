import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { API } from 'typescript/unstable/sync';
import {
  SyntaxKind,
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isNoSubstitutionTemplateLiteral,
  isImportDeclaration,
  isIdentifier,
  isStringLiteral,
  type Node,
} from 'typescript/unstable/ast';
import { resolveLocalRuntimeImport } from '../src/analysis/typescript-runtime.ts';

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

export function createRelativeReferences(root: string, paths: readonly string[]) {
  const api = new API({ cwd: root });
  const snapshot = api.updateSnapshot({ openFiles: paths.map((path) => resolve(root, path)) });
  const specifiers = new Map<string, string[]>();
  for (const path of paths) {
    const absolute = resolve(root, path);
    const source = snapshot.getDefaultProjectForFile(absolute)?.program.getSourceFile(absolute);
    if (!source) throw new Error(`TCB_SOURCE_UNAVAILABLE:${path}`);
    const refs: string[] = [];
    const visit = (node: Node): void => {
      if (
        (isImportDeclaration(node) || isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        isStringLiteral(node.moduleSpecifier)
      ) {
        refs.push(node.moduleSpecifier.text);
      }
      if (isExternalModuleReference(node) && node.expression && isStringLiteral(node.expression))
        refs.push(node.expression.text);
      if (
        isCallExpression(node) &&
        (node.expression.kind === SyntaxKind.ImportKeyword ||
          (isIdentifier(node.expression) && node.expression.text === 'require')) &&
        node.arguments[0] &&
        (isStringLiteral(node.arguments[0]) || isNoSubstitutionTemplateLiteral(node.arguments[0]))
      ) {
        refs.push(node.arguments[0].text);
      }
      node.forEachChild(visit);
    };
    visit(source);
    specifiers.set(
      path,
      refs.filter((specifier) => specifier.startsWith('.')),
    );
  }
  return (path: string): string[] =>
    specifiers
      .get(path)!
      .flatMap((specifier) => {
        const base = resolve(root, dirname(path), specifier);
        const substituted = base.replace(
          /\.(?:js|mjs|cjs)$/,
          (ext) => ({ '.js': '.ts', '.mjs': '.mts', '.cjs': '.cts' })[ext]!,
        );
        const found = [substituted, base, `${base}.ts`, join(base, 'index.ts')].find(
          (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
        );
        let measured: string;
        try {
          measured = resolveLocalRuntimeImport(root, path, specifier);
        } catch {
          measured = `unresolved:${specifier}`;
        }
        // Check both the analyzer's resolver and file-only resolution, so a
        // directory/index replacement cannot be hidden by a restored sibling.
        return [measured, found ? relative(root, found) : `unresolved:${specifier}`];
      })
      .sort();
}
