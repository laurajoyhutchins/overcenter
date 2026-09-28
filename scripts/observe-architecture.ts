import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { ObservedArchitecture } from '../src/architecture/reconciliation.ts';

import { API } from 'typescript/unstable/sync';
import {
  isClassDeclaration,
  isFunctionDeclaration,
  isVariableStatement,
  type Node,
  type SourceFile,
} from 'typescript/unstable/ast';

import { repositoryRelativePath as normalizedRepoPath } from '../src/analysis/typescript-runtime.ts';
import { observeGitHubActionsProviderEffects } from '../src/observation/github-actions-effects.ts';
import { observeWorkflowTransitiveEffects } from '../src/observation/workflow-transitive-effects.ts';
import { createTypeScriptFunctionEffectProbe } from './typescript-effect-reachability.ts';

interface SymbolBinding {
  symbol_id: string;
  artifact_id: string;
}

interface WorkflowJob {
  id: string;
  start_line: number;
  end_line: number;
  permissions: PermissionObservation;
}

interface PermissionObservation {
  explicit: boolean;
  writes: string[];
}

function indentation(line: string): number {
  return line.length - line.trimStart().length;
}

function withoutComment(line: string): string {
  const index = line.indexOf('#');
  return index === -1 ? line : line.slice(0, index);
}

function inlineWrites(value: string): string[] {
  if (value.trim() === 'write-all') return ['*'];
  return [...value.matchAll(/([a-z][a-z0-9-]*)\s*:\s*write\b/g)].map((match) => match[1]!);
}

function permissionsAt(lines: readonly string[], targetIndent: number): PermissionObservation {
  for (let index = 0; index < lines.length; index += 1) {
    const line = withoutComment(lines[index]!);
    const trimmed = line.trim();
    if (!trimmed || indentation(line) !== targetIndent) continue;
    const declaration = trimmed.match(/^permissions:\s*(.*)$/);
    if (!declaration) continue;

    const value = declaration[1]!.trim();
    if (value) return { explicit: true, writes: [...new Set(inlineWrites(value))].sort() };

    const writes: string[] = [];
    for (let child = index + 1; child < lines.length; child += 1) {
      const nested = withoutComment(lines[child]!);
      const nestedTrimmed = nested.trim();
      if (!nestedTrimmed) continue;
      if (indentation(nested) <= targetIndent) break;
      const write = nestedTrimmed.match(/^([a-z][a-z0-9-]*):\s*write\s*$/)?.[1];
      if (write) writes.push(write);
    }
    return { explicit: true, writes: [...new Set(writes)].sort() };
  }
  return { explicit: false, writes: [] };
}

function workflowJobs(source: string): WorkflowJob[] {
  const lines = source.split(/\r?\n/);
  const jobsLine = lines.findIndex((line) => /^jobs:\s*$/.test(withoutComment(line).trim()));
  if (jobsLine < 0) return [];

  const rootPermissions = permissionsAt(lines.slice(0, jobsLine), 0);
  const starts: Array<{ id: string; line: number }> = [];
  for (let index = jobsLine + 1; index < lines.length; index += 1) {
    const line = withoutComment(lines[index]!);
    if (!line.trim()) continue;
    const indent = indentation(line);
    if (indent === 0) break;
    const match = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (match) starts.push({ id: match[1]!, line: index + 1 });
  }

  return starts.map((job, index) => {
    const next = starts[index + 1];
    const endLine = next ? next.line - 1 : lines.length;
    const jobLines = lines.slice(job.line - 1, endLine);
    const jobPermissions = permissionsAt(jobLines, 4);
    return {
      id: job.id,
      start_line: job.line,
      end_line: endLine,
      permissions: jobPermissions.explicit ? jobPermissions : rootPermissions,
    };
  });
}

function principalForLine(workflowPath: string, jobs: readonly WorkflowJob[], line: number): string | null {
  const job = jobs.find((candidate) => line >= candidate.start_line && line <= candidate.end_line);
  return job ? `${workflowPath}#${job.id}` : null;
}

function nodeName(node: Node, source: SourceFile): string | null {
  const named = node as Node & { name?: Node };
  return named.name ? named.name.getText(source) : null;
}

function hasSymbol(source: SourceFile, symbolId: string): boolean {
  const dot = symbolId.indexOf('.');
  if (dot < 0) {
    return source.statements.some((statement) => {
      if (
        (isFunctionDeclaration(statement) || isClassDeclaration(statement)) &&
        nodeName(statement, source) === symbolId
      ) {
        return true;
      }
      if (isVariableStatement(statement)) {
        return statement.declarationList.declarations.some(
          (declaration) => declaration.name.getText(source) === symbolId,
        );
      }
      return false;
    });
  }

  const ownerName = symbolId.slice(0, dot);
  const memberName = symbolId.slice(dot + 1);
  const owner = source.statements.find(
    (statement) => isClassDeclaration(statement) && nodeName(statement, source) === ownerName,
  );
  return (
    owner !== undefined &&
    isClassDeclaration(owner) &&
    owner.members.some((member) => nodeName(member, source) === memberName)
  );
}

function observeSymbols(root: string, bindings: readonly SymbolBinding[]): ObservedArchitecture['symbols'] {
  const TypeScriptBindings = bindings.filter((binding) => binding.artifact_id.endsWith('.ts'));
  if (TypeScriptBindings.length === 0) return [];

  const api = new API({ cwd: root });
  const openFiles = [...new Set(TypeScriptBindings.map((binding) => resolve(root, binding.artifact_id)))];
  const snapshot = api.updateSnapshot({ openFiles });
  try {
    return TypeScriptBindings.filter((binding) => {
      const absolute = resolve(root, binding.artifact_id);
      const project = snapshot.getDefaultProjectForFile(absolute);
      const source = project?.program.getSourceFile(absolute);
      return source ? hasSymbol(source, binding.symbol_id) : false;
    }).map(({ symbol_id, artifact_id }) => ({ symbol_id, artifact_id }));
  } finally {
    snapshot.dispose();
    api.close();
  }
}

function workflowSources(root: string): Record<string, string> {
  const directory = resolve(root, '.github/workflows');
  const sources: Record<string, string> = {};
  if (!existsSync(directory)) return sources;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const path = join(directory, entry.name);
    sources[normalizedRepoPath(path, root)] = readFileSync(path, 'utf8');
  }
  return sources;
}

export function observeArchitecture(
  db: DatabaseSync,
  sourceRevision: string,
  root = process.cwd(),
): ObservedArchitecture {
  if (!sourceRevision) throw new Error('ARCHITECTURE_SOURCE_REVISION_INVALID');

  const artifactIds = (
    db.prepare('SELECT artifact_id FROM artifact ORDER BY artifact_id').all() as unknown as Array<{
      artifact_id: string;
    }>
  ).map((row) => row.artifact_id);
  const bindings = db
    .prepare('SELECT symbol_id, artifact_id FROM symbol ORDER BY symbol_id')
    .all() as unknown as SymbolBinding[];

  const sources = workflowSources(root);
  const jobsByWorkflow = new Map<string, WorkflowJob[]>();
  const principals: ObservedArchitecture['principals'] = [];
  const principalCapabilities: ObservedArchitecture['principal_capabilities'] = [];

  for (const [workflowPath, source] of Object.entries(sources).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const jobs = workflowJobs(source);
    jobsByWorkflow.set(workflowPath, jobs);
    for (const job of jobs) {
      const principalId = `${workflowPath}#${job.id}`;
      principals.push({ principal_id: principalId });
      for (const permission of job.permissions.writes) {
        principalCapabilities.push({
          principal_id: principalId,
          capability_id: `github-actions/permission/${permission}/write`,
        });
      }
    }
  }

  const principalInvocations: ObservedArchitecture['principal_invocations'] = [];
  for (const fact of observeGitHubActionsProviderEffects(sources, sourceRevision)) {
    const principalId = principalForLine(
      fact.workflow_path,
      jobsByWorkflow.get(fact.workflow_path) ?? [],
      fact.line_number,
    );
    if (principalId) principalInvocations.push({ principal_id: principalId, effect_id: fact.effect });
  }

  const principalReachability: ObservedArchitecture['principal_reachability'] = [];
  const unresolvedEffectCalls: ObservedArchitecture['unresolved_effect_calls'] = [];
  const functionEffects = createTypeScriptFunctionEffectProbe(root);
  try {
    for (const fact of observeWorkflowTransitiveEffects(sources, sourceRevision, functionEffects)) {
      if (fact.kind === 'github-actions-transitive-effect-reachability') {
        const principalId = principalForLine(
          fact.workflow_path,
          jobsByWorkflow.get(fact.workflow_path) ?? [],
          sources[fact.workflow_path]!
            .split(/\r?\n/)
            .findIndex((line) => line.includes(fact.entrypoint)) + 1,
        );
        if (principalId) {
          principalReachability.push({ principal_id: principalId, effect_id: fact.effect });
        }
      } else if (fact.kind === 'github-actions-unresolved-dynamic-call-target') {
        const entrypointLine =
          sources[fact.workflow_path]!
            .split(/\r?\n/)
            .findIndex((line) => line.includes(fact.entrypoint)) + 1;
        const principalId = principalForLine(
          fact.workflow_path,
          jobsByWorkflow.get(fact.workflow_path) ?? [],
          entrypointLine,
        );
        if (principalId && fact.candidate_effects.length > 0) {
          unresolvedEffectCalls.push({
            principal_id: principalId,
            call_site_path: fact.call_site_path,
            call_site_line: fact.call_site_line,
            call_expression_sha256: fact.call_expression_sha256,
            candidate_effects: [...fact.candidate_effects].sort(),
          });
        }
      }
    }
  } finally {
    functionEffects.dispose?.();
  }

  const unique = <T>(rows: T[]): T[] => [
    ...new Map(rows.map((row) => [JSON.stringify(row), row])).values(),
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

  return {
    source_revision: sourceRevision,
    artifacts: artifactIds
      .filter((artifactId) => existsSync(resolve(root, artifactId)))
      .map((artifact_id) => ({ artifact_id })),
    symbols: observeSymbols(root, bindings),
    principals: unique(principals),
    principal_capabilities: unique(principalCapabilities),
    principal_invocations: unique(principalInvocations),
    principal_reachability: unique(principalReachability),
    unresolved_effect_calls: unique(unresolvedEffectCalls),
  };
}
