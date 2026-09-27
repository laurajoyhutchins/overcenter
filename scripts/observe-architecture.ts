import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { API } from 'typescript/unstable/sync';
import { isExportDeclaration, isImportDeclaration, isStringLiteral } from 'typescript/unstable/ast';

import {
  type ArchitectureIntent,
  type ArchitectureObservedFact,
  validateArchitectureIntent,
} from '../src/authority/architecture-reconciliation.ts';

export type ProductionReferenceProbe = (fromPath: string, toPath: string) => boolean;

function normalizedRepoPath(path: string): string {
  return relative(process.cwd(), resolve(path)).replaceAll('\\', '/');
}

function resolveLocalReference(fromPath: string, specifier: string): string | null {
  const base = resolve(dirname(resolve(fromPath)), specifier);
  const candidates = [
    base,
    base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : '',
    `${base}.ts`,
    resolve(base, 'index.ts'),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ? normalizedRepoPath(found) : null;
}

function productionReferenceProbe(intent: ArchitectureIntent): ProductionReferenceProbe {
  const paths = [
    ...new Set(
      intent.claims.flatMap((claim) =>
        claim.projections.length > 0 ? [claim.authority, ...claim.projections] : [],
      ),
    ),
  ].filter((path) => existsSync(path));
  const edges = new Set<string>();
  if (paths.length === 0) return () => false;

  const api = new API({ cwd: process.cwd() });
  const snapshot = api.updateSnapshot({ openFiles: paths.map((path) => resolve(path)) });
  try {
    for (const path of paths) {
      const absolute = resolve(path);
      const project = snapshot.getDefaultProjectForFile(absolute);
      const source = project?.program.getSourceFile(absolute);
      if (!source) continue;

      for (const statement of source.statements) {
        const moduleSpecifier = isImportDeclaration(statement)
          ? statement.moduleSpecifier
          : isExportDeclaration(statement)
            ? statement.moduleSpecifier
            : undefined;
        if (!moduleSpecifier || !isStringLiteral(moduleSpecifier)) continue;
        if (!moduleSpecifier.text.startsWith('.')) continue;

        const target = resolveLocalReference(path, moduleSpecifier.text);
        if (target) edges.add(`${path}\0${target}`);
      }
    }
  } finally {
    snapshot.dispose();
    api.close();
  }

  return (fromPath, toPath) => edges.has(`${fromPath}\0${toPath}`);
}

function sortFacts(facts: ArchitectureObservedFact[]): ArchitectureObservedFact[] {
  return facts.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function observeArchitectureIntent(
  rawIntent: ArchitectureIntent,
  sourceRevision: string,
  pathExists: (path: string) => boolean = existsSync,
  hasProductionReference?: ProductionReferenceProbe,
): ArchitectureObservedFact[] {
  const intent = validateArchitectureIntent(rawIntent);
  if (!sourceRevision) throw new Error('ARCHITECTURE_SOURCE_REVISION_INVALID');
  const observations: ArchitectureObservedFact[] = [];
  const paths = new Set<string>();
  for (const claim of intent.claims) {
    paths.add(claim.authority);
    for (const path of claim.projections) paths.add(path);
    for (const path of claim.verifiers) paths.add(path);
  }
  for (const path of [...paths].sort()) {
    observations.push({
      kind: 'path-state',
      source_revision: sourceRevision,
      path,
      present: pathExists(path),
    });
  }

  const references = hasProductionReference ?? productionReferenceProbe(intent);
  for (const claim of intent.claims) {
    if (!pathExists(claim.authority)) continue;
    for (const projection of [...claim.projections].sort()) {
      if (projection === claim.authority || !pathExists(projection)) continue;
      observations.push({
        kind: 'typescript-reference-state',
        source_revision: sourceRevision,
        from_path: claim.authority,
        to_path: projection,
        present: references(claim.authority, projection),
      });
      observations.push({
        kind: 'typescript-reference-state',
        source_revision: sourceRevision,
        from_path: projection,
        to_path: claim.authority,
        present: references(projection, claim.authority),
      });
    }
  }

  return sortFacts(observations);
}
