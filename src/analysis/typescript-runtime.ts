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

function staticModuleSpecifiers(
  source: SourceFile,
  includeTypeOnly: boolean,
): string[] {
  const specifiers = new Set<string>();
  for (const statement of source.statements) {
    if (isImportDeclaration(statement)) {
      if (!includeTypeOnly && statement.importClause?.phaseModifier === SyntaxKind.TypeKeyword) {
        continue;
      }
      if (isStringLiteral(statement.moduleSpecifier)) specifiers.add(statement.moduleSpecifier.text);
      continue;
    }
    if (isExportDeclaration(statement)) {
      if (!statement.moduleSpecifier) continue;
      if (!includeTypeOnly && statement.isTypeOnly) continue;
      if (isStringLiteral(statement.moduleSpecifier)) specifiers.add(statement.moduleSpecifier.text);
    }
  }
  return [...specifiers].sort();
}

export function staticLocalModuleReferences(
  root: string,
  path: string,
  source: SourceFile,
): string[] {
  return staticModuleSpecifiers(source, true)
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => resolveLocalRuntimeImport(root, path, specifier));
}

export function staticRuntimeImports(
  root: string,
  path: string,
  source: SourceFile,
): RuntimeImports {
  const local: string[] = [];
  const external: string[] = [];
  for (const specifier of staticModuleSpecifiers(source, false)) {
    if (specifier.startsWith('.')) {
      local.push(resolveLocalRuntimeImport(root, path, specifier));
    } else {
      external.push(specifier);
    }
  }
  return { local: local.sort(), external: external.sort() };
}

export function runtimeImports(root: string, path: string, source: SourceFile): RuntimeImports {
  const imports = staticRuntimeImports(root, path, source);
  const local = new Set(imports.local);
  const external = new Set(imports.external);

  const runtimeLoad = /\b(import|require)\s*\(/g;
  for (const match of source.text.matchAll(runtimeLoad)) {
    const tail = source.text.slice(match.index);
    const literal = /^(import|require)\s*\(\s*(['"])([^'"]+)\2\s*\)/.exec(tail);
    if (!literal) {
      throw new Error(
        `${match[1] === 'import' ? 'TYPESCRIPT_DYNAMIC_IMPORT_NONLITERAL' : 'TYPESCRIPT_REQUIRE_NONLITERAL'}:${path}`,
      );
    }
    const specifier = literal[3]!;
    if (specifier.startsWith('.')) {
      local.add(resolveLocalRuntimeImport(root, path, specifier));
    } else {
      external.add(specifier);
    }
  }

  return { local: [...local].sort(), external: [...external].sort() };
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
