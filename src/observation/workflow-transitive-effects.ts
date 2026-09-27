import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

export type WorkflowReachableProductionEffect =
  | 'git-remote-ref/mutate'
  | 'github-commit-status/create'
  | 'github-pull-request/update-branch';

export interface WorkflowEntrypointFact {
  kind: 'github-actions-typescript-entrypoint';
  source_revision: string;
  workflow_path: string;
  entrypoint: string;
  line_number: number;
}

export interface WorkflowTransitiveEffectFact {
  kind: 'github-actions-transitive-effect-reachability';
  source_revision: string;
  workflow_path: string;
  entrypoint: string;
  effect: WorkflowReachableProductionEffect;
  terminal_path: string;
  import_chain: string[];
  terminal_statement_sha256: string;
}

export type WorkflowTransitiveEffectObservedFact =
  | WorkflowEntrypointFact
  | WorkflowTransitiveEffectFact;

interface ProductionEffectTerminal {
  effect: WorkflowReachableProductionEffect;
  statement: string;
}

function normalized(path: string): string {
  return relative(process.cwd(), resolve(path)).replaceAll('\\', '/');
}

function resolveLocalModule(fromPath: string, specifier: string): string | null {
  const base = resolve(dirname(resolve(fromPath)), specifier);
  const candidates = [
    base,
    base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : '',
    base.endsWith('.ts') ? base : `${base}.ts`,
    resolve(base, 'index.ts'),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ? normalized(found) : null;
}

function localImports(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const imports = new Set<string>();
  const pattern = /(?:from\s*|import\s*)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1]!;
    if (!specifier.startsWith('.')) continue;
    const target = resolveLocalModule(path, specifier);
    if (target) imports.add(target);
  }
  return [...imports].sort();
}

function statementDigest(statement: string): string {
  return createHash('sha256').update(statement.trim()).digest('hex');
}

function productionEffectTerminals(path: string): ProductionEffectTerminal[] {
  if (!path.startsWith('src/')) return [];
  const source = readFileSync(path, 'utf8');
  const terminals: ProductionEffectTerminal[] = [];

  for (const line of source.split(/\r?\n/)) {
    if (/\[\s*['"]push['"]/.test(line)) {
      terminals.push({ effect: 'git-remote-ref/mutate', statement: line });
    }
  }

  if (source.includes('GITHUB_STATUS_PROVIDER_ORIGIN') && /method:\s*['"]POST['"]/.test(source)) {
    const statement =
      source.split(/\r?\n/).find((line) => /method:\s*['"]POST['"]/.test(line)) ?? "method: 'POST'";
    terminals.push({ effect: 'github-commit-status/create', statement });
  }

  if (
    source.includes('/update-branch') &&
    /method:\s*['"]PUT['"]/.test(source) &&
    source.includes('api.github.com')
  ) {
    const statement =
      source.split(/\r?\n/).find((line) => line.includes('/update-branch')) ?? '/update-branch';
    terminals.push({ effect: 'github-pull-request/update-branch', statement });
  }

  return terminals;
}

export function workflowTypeScriptEntrypoints(source: string): Array<{
  entrypoint: string;
  line_number: number;
}> {
  const entrypoints: Array<{ entrypoint: string; line_number: number }> = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const matches = line.matchAll(/\bnode\b[^\n]*?\b((?:src|scripts)\/[A-Za-z0-9_./-]+\.ts)\b/g);
    for (const match of matches) {
      entrypoints.push({ entrypoint: match[1]!, line_number: index + 1 });
    }
  }
  return entrypoints;
}

function shortestReachability(entrypoint: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entrypoint, [entrypoint]]]);
  const pending = [entrypoint];

  while (pending.length > 0) {
    const current = pending.shift()!;
    if (!existsSync(current)) continue;
    for (const next of localImports(current)) {
      if (seen.has(next)) continue;
      const chain = [...seen.get(current)!, next];
      seen.set(next, chain);
      pending.push(next);
    }
  }

  return seen;
}

export function observeWorkflowTransitiveEffects(
  workflowSources: Readonly<Record<string, string>>,
  sourceRevision: string,
): WorkflowTransitiveEffectObservedFact[] {
  if (!sourceRevision) throw new Error('ARCHITECTURE_SOURCE_REVISION_INVALID');
  const facts: WorkflowTransitiveEffectObservedFact[] = [];

  for (const workflowPath of Object.keys(workflowSources).sort()) {
    const source = workflowSources[workflowPath]!;
    for (const { entrypoint, line_number } of workflowTypeScriptEntrypoints(source)) {
      facts.push({
        kind: 'github-actions-typescript-entrypoint',
        source_revision: sourceRevision,
        workflow_path: workflowPath,
        entrypoint,
        line_number,
      });
      if (!existsSync(entrypoint)) continue;

      const reachability = shortestReachability(entrypoint);
      for (const [terminalPath, chain] of reachability) {
        for (const terminal of productionEffectTerminals(terminalPath)) {
          facts.push({
            kind: 'github-actions-transitive-effect-reachability',
            source_revision: sourceRevision,
            workflow_path: workflowPath,
            entrypoint,
            effect: terminal.effect,
            terminal_path: terminalPath,
            import_chain: chain,
            terminal_statement_sha256: statementDigest(terminal.statement),
          });
        }
      }
    }
  }

  return facts.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
