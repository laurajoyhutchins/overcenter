import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import {
  SyntaxKind,
  isExportDeclaration,
  isImportDeclaration,
  isStringLiteral,
  type SourceFile,
} from 'typescript/unstable/ast';

export interface RuntimeImports {
  local: string[];
  external: string[];
}

export interface RuntimeModuleClosure {
  files: string[];
  external_modules: string[];
}

export function repositoryRelativePath(path: string, root = process.cwd()): string {
  return relative(root, resolve(path)).replaceAll('\\', '/');
}

export function resolveLocalRuntimeImport(
  root: string,
  fromPath: string,
  specifier: string,
): string {
  const base = resolve(root, dirname(fromPath), specifier);
  const candidates = [
    base,
    base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : '',
    base.endsWith('.ts') ? base : `${base}.ts`,
    resolve(base, 'index.ts'),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`TYPESCRIPT_LOCAL_IMPORT_UNRESOLVED:${fromPath}:${specifier}`);
  }
  return repositoryRelativePath(found, root);
}

export function runtimeImports(
  root: string,
  path: string,
  source: SourceFile,
): RuntimeImports {
  const specifiers = new Set<string>();

  const addModuleSpecifier = (node: unknown, error: string): void => {
    if (!node || !isStringLiteral(node as never)) {
      throw new Error(`${error}:${path}`);
    }
    specifiers.add((node as { text: string }).text);
  };

  for (const statement of source.statements) {
    if (isImportDeclaration(statement)) {
      if (statement.importClause?.phaseModifier === SyntaxKind.TypeKeyword) continue;
      addModuleSpecifier(statement.moduleSpecifier, 'TYPESCRIPT_IMPORT_SPECIFIER_NONLITERAL');
      continue;
    }
    if (isExportDeclaration(statement)) {
      if (statement.isTypeOnly || !statement.moduleSpecifier) continue;
      addModuleSpecifier(statement.moduleSpecifier, 'TYPESCRIPT_EXPORT_SPECIFIER_NONLITERAL');
      continue;
    }
    if (statement.kind === SyntaxKind.ImportEqualsDeclaration) {
      throw new Error(`TYPESCRIPT_IMPORT_EQUALS_UNSUPPORTED:${path}`);
    }
  }

  const runtimeLoad = /\b(import|require)\s*\(/g;
  for (const match of source.text.matchAll(runtimeLoad)) {
    const tail = source.text.slice(match.index);
    const literal = /^(import|require)\s*\(\s*(['"])([^'"]+)\2\s*\)/.exec(tail);
    if (!literal) {
      throw new Error(
        `${match[1] === 'import' ? 'TYPESCRIPT_DYNAMIC_IMPORT_NONLITERAL' : 'TYPESCRIPT_REQUIRE_NONLITERAL'}:${path}`,
      );
    }
    specifiers.add(literal[3]!);
  }

  const local: string[] = [];
  const external: string[] = [];
  for (const specifier of specifiers) {
    if (specifier.startsWith('.')) {
      local.push(resolveLocalRuntimeImport(root, path, specifier));
    } else {
      external.push(specifier);
    }
  }
  return { local: local.sort(), external: external.sort() };
}

export function runtimeModuleClosure(
  root: string,
  rootPaths: readonly string[],
  sourceFor: (path: string) => SourceFile | null,
): RuntimeModuleClosure {
  const pending = [...new Set(rootPaths.map((path) => repositoryRelativePath(path, root)))];
  const visited = new Set<string>();
  const external = new Set<string>();

  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || visited.has(path)) continue;
    visited.add(path);

    const source = sourceFor(path);
    if (!source) throw new Error(`TYPESCRIPT_SOURCE_UNAVAILABLE:${path}`);
    const imports = runtimeImports(root, path, source);
    for (const module of imports.external) external.add(module);
    for (const dependency of imports.local) {
      if (!visited.has(dependency)) pending.push(dependency);
    }
  }

  return {
    files: [...visited].sort(),
    external_modules: [...external].sort(),
  };
}
