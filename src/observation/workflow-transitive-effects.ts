import { existsSync } from 'node:fs';

import type { RegisteredEffectImplementationContract } from '../analysis/effect-implementations.ts';

export type WorkflowReachableProductionEffect = RegisteredEffectImplementationContract;

export interface WorkflowEntrypointFact {
  kind: 'github-actions-typescript-entrypoint';
  source_revision: string;
  workflow_path: string;
  entrypoint: string;
  line_number: number;
}

export interface WorkflowFunctionEffectReachability {
  effect: WorkflowReachableProductionEffect;
  terminal_path: string;
  terminal_symbol: string;
  import_chain: string[];
  call_chain: string[];
  terminal_statement_sha256: string;
}

export interface WorkflowUnresolvedFunctionCall {
  call_site_path: string;
  call_site_line: number;
  call_expression_sha256: string;
  declaration_path: string;
  declaration_symbol: string;
  call_chain: string[];
  candidate_effects: WorkflowReachableProductionEffect[];
}

export interface WorkflowFunctionEffectAnalysis {
  effects: WorkflowFunctionEffectReachability[];
  unresolved_calls: WorkflowUnresolvedFunctionCall[];
}

export interface WorkflowFunctionEffectProbe {
  (entrypoint: string): WorkflowFunctionEffectAnalysis;
  dispose?: () => void;
}

export interface WorkflowTransitiveEffectFact {
  kind: 'github-actions-transitive-effect-reachability';
  source_revision: string;
  workflow_path: string;
  entrypoint: string;
  effect: WorkflowReachableProductionEffect;
  terminal_path: string;
  terminal_symbol?: string;
  import_chain: string[];
  call_chain?: string[];
  terminal_statement_sha256: string;
}

export interface WorkflowUnresolvedDynamicCallFact {
  kind: 'github-actions-unresolved-dynamic-call-target';
  source_revision: string;
  workflow_path: string;
  entrypoint: string;
  call_site_path: string;
  call_site_line: number;
  call_expression_sha256: string;
  declaration_path: string;
  declaration_symbol: string;
  call_chain: string[];
  candidate_effects: WorkflowReachableProductionEffect[];
}

export type WorkflowTransitiveEffectObservedFact =
  | WorkflowEntrypointFact
  | WorkflowTransitiveEffectFact
  | WorkflowUnresolvedDynamicCallFact;

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

export function observeWorkflowTransitiveEffects(
  workflowSources: Readonly<Record<string, string>>,
  sourceRevision: string,
  functionEffects: WorkflowFunctionEffectProbe,
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

      const analysis = functionEffects(entrypoint);
      for (const terminal of analysis.effects) {
        facts.push({
          kind: 'github-actions-transitive-effect-reachability',
          source_revision: sourceRevision,
          workflow_path: workflowPath,
          entrypoint,
          ...terminal,
        });
      }
      for (const unresolved of analysis.unresolved_calls) {
        facts.push({
          kind: 'github-actions-unresolved-dynamic-call-target',
          source_revision: sourceRevision,
          workflow_path: workflowPath,
          entrypoint,
          ...unresolved,
        });
      }
    }
  }

  return facts.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
