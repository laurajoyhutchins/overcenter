import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { API } from 'typescript/unstable/sync';
import { isExportDeclaration, isImportDeclaration, isStringLiteral } from 'typescript/unstable/ast';

import {
  type ArchitectureIntent,
  type ArchitectureObservedFact,
  validateArchitectureIntent,
} from '../src/authority/architecture-reconciliation.ts';
import { observeGitHubActionsSources } from '../src/observation/github-actions-capabilities.ts';
import { observeGitHubActionsProviderEffects } from '../src/observation/github-actions-effects.ts';
import { observeWorkflowTransitiveEffects } from '../src/observation/workflow-transitive-effects.ts';
import { createTypeScriptFunctionEffectProbe } from './typescript-effect-reachability.ts';

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
        claim.kind === 'authority-role' && claim.projections.length > 0
          ? [claim.authority, ...claim.projections]
          : [],
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
    if (claim.kind !== 'authority-role') continue;
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
    if (claim.kind !== 'authority-role' || !pathExists(claim.authority)) continue;
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

  if (
    intent.claims.some(
      (claim) =>
        claim.kind === 'github-actions-explicit-write-authority' ||
        claim.kind === 'github-actions-provider-effect-authority' ||
        claim.kind === 'workflow-transitive-effect-authority',
    )
  ) {
    const directory = resolve('.github/workflows');
    const sources: Record<string, string> = {};
    if (existsSync(directory)) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
        const path = join(directory, entry.name);
        sources[normalizedRepoPath(path)] = readFileSync(path, 'utf8');
      }
    }
    observations.push(...observeGitHubActionsSources(sources, sourceRevision));
    observations.push(...observeGitHubActionsProviderEffects(sources, sourceRevision));
    observations.push(
      ...observeWorkflowTransitiveEffects(
        sources,
        sourceRevision,
        createTypeScriptFunctionEffectProbe(process.cwd()),
      ),
    );
  }

  return sortFacts(observations);
}
