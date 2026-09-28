export const CODE_WITNESS_REPORT_SCHEMA = 'overcenter-code-witness-report/v1' as const;

export type ProductionSymbolKind = 'function' | 'class' | 'callable-variable';

export type ExplicitCodeWitnessKind = 'architecture-intent' | 'tcb-whole-file' | 'tcb-symbol';

export interface ExplicitCodeWitness {
  kind: ExplicitCodeWitnessKind;
  detail: string;
}

export interface ProductionSymbolObservation {
  source_revision: string;
  path: string;
  symbol: string;
  start_line: number;
  kind: ProductionSymbolKind;
  exported: boolean;
  top_level_reference: boolean;
  explicit_witnesses: ExplicitCodeWitness[];
  transparent_call_target?: string;
}

export interface CodeReferenceObservation {
  source_revision: string;
  from: {
    path: string;
    symbol: string;
  };
  to: {
    path: string;
    symbol: string;
  };
}

export type CodeWitnessFindingCode =
  | 'UNWITNESSED_PRIVATE_SYMBOL'
  | 'SINGLE_CALLER_TRANSPARENT_WRAPPER';

export interface CodeWitnessFinding {
  code: CodeWitnessFindingCode;
  path: string;
  symbol: string;
  start_line: number;
  evidence: string[];
}

export interface CodeWitnessReport {
  schema: typeof CODE_WITNESS_REPORT_SCHEMA;
  source_revision: string;
  summary: {
    observed_symbols: number;
    root_symbols: number;
    reachable_symbols: number;
    unwitnessed_symbols: number;
    simplification_candidates: number;
  };
  findings: CodeWitnessFinding[];
}

function symbolId(path: string, symbol: string): string {
  return path + '#' + symbol;
}

function validateObservation(
  sourceRevision: string,
  observation: ProductionSymbolObservation,
): void {
  if (observation.source_revision !== sourceRevision) {
    throw new Error('CODE_WITNESS_OBSERVATION_REVISION_MISMATCH');
  }
  if (
    observation.path.length === 0 ||
    observation.symbol.length === 0 ||
    !Number.isSafeInteger(observation.start_line) ||
    observation.start_line <= 0
  ) {
    throw new Error('CODE_WITNESS_OBSERVATION_INVALID');
  }
}

function validateReference(sourceRevision: string, reference: CodeReferenceObservation): void {
  if (reference.source_revision !== sourceRevision) {
    throw new Error('CODE_WITNESS_REFERENCE_REVISION_MISMATCH');
  }
  if (
    reference.from.path.length === 0 ||
    reference.from.symbol.length === 0 ||
    reference.to.path.length === 0 ||
    reference.to.symbol.length === 0
  ) {
    throw new Error('CODE_WITNESS_REFERENCE_INVALID');
  }
}

function compareFindings(left: CodeWitnessFinding, right: CodeWitnessFinding): number {
  const path = left.path.localeCompare(right.path);
  if (path !== 0) return path;
  if (left.start_line !== right.start_line) return left.start_line - right.start_line;
  const symbol = left.symbol.localeCompare(right.symbol);
  if (symbol !== 0) return symbol;
  return left.code.localeCompare(right.code);
}

export function analyzeCodeWitnesses(input: {
  source_revision: string;
  symbols: ProductionSymbolObservation[];
  references: CodeReferenceObservation[];
}): CodeWitnessReport {
  if (input.source_revision.length === 0) throw new Error('CODE_WITNESS_SOURCE_REVISION_INVALID');

  const symbols = [...input.symbols];
  const byId = new Map<string, ProductionSymbolObservation>();
  for (const observation of symbols) {
    validateObservation(input.source_revision, observation);
    const id = symbolId(observation.path, observation.symbol);
    if (byId.has(id)) throw new Error('CODE_WITNESS_SYMBOL_DUPLICATE:' + id);
    byId.set(id, observation);
  }

  const edges = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const reference of input.references) {
    validateReference(input.source_revision, reference);
    const from = symbolId(reference.from.path, reference.from.symbol);
    const to = symbolId(reference.to.path, reference.to.symbol);
    if (!byId.has(from) || !byId.has(to)) {
      throw new Error('CODE_WITNESS_REFERENCE_TARGET_UNKNOWN:' + from + '->' + to);
    }
    if (from === to) continue;
    const outgoing = edges.get(from) ?? new Set<string>();
    outgoing.add(to);
    edges.set(from, outgoing);
    const callers = incoming.get(to) ?? new Set<string>();
    callers.add(from);
    incoming.set(to, callers);
  }

  const roots = new Set<string>();
  for (const observation of symbols) {
    if (
      observation.exported ||
      observation.top_level_reference ||
      observation.explicit_witnesses.length > 0
    ) {
      roots.add(symbolId(observation.path, observation.symbol));
    }
  }

  const reachable = new Set<string>();
  const frontier = [...roots].sort();
  while (frontier.length > 0) {
    const current = frontier.pop() as string;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const target of [...(edges.get(current) ?? [])].sort().reverse()) {
      if (!reachable.has(target)) frontier.push(target);
    }
  }

  const findings: CodeWitnessFinding[] = [];
  for (const observation of symbols) {
    const id = symbolId(observation.path, observation.symbol);
    if (!reachable.has(id)) {
      findings.push({
        code: 'UNWITNESSED_PRIVATE_SYMBOL',
        path: observation.path,
        symbol: observation.symbol,
        start_line: observation.start_line,
        evidence: [
          'not exported',
          'not referenced from top-level runtime code',
          'not reachable from a witnessed production symbol',
          'not named by architecture or trusted-computing-base intent',
        ],
      });
      continue;
    }

    if (
      !observation.exported &&
      !observation.top_level_reference &&
      observation.explicit_witnesses.length === 0 &&
      observation.transparent_call_target
    ) {
      const reachableCallers = [...(incoming.get(id) ?? [])].filter((caller) =>
        reachable.has(caller),
      );
      if (reachableCallers.length === 1) {
        findings.push({
          code: 'SINGLE_CALLER_TRANSPARENT_WRAPPER',
          path: observation.path,
          symbol: observation.symbol,
          start_line: observation.start_line,
          evidence: [
            'one reachable production caller: ' + reachableCallers[0],
            'body forwards unchanged parameters to ' + observation.transparent_call_target,
          ],
        });
      }
    }
  }

  findings.sort(compareFindings);
  return {
    schema: CODE_WITNESS_REPORT_SCHEMA,
    source_revision: input.source_revision,
    summary: {
      observed_symbols: symbols.length,
      root_symbols: roots.size,
      reachable_symbols: reachable.size,
      unwitnessed_symbols: findings.filter(
        (finding) => finding.code === 'UNWITNESSED_PRIVATE_SYMBOL',
      ).length,
      simplification_candidates: findings.filter(
        (finding) => finding.code === 'SINGLE_CALLER_TRANSPARENT_WRAPPER',
      ).length,
    },
    findings,
  };
}
