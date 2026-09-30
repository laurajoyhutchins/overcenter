import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API, SymbolFlags, type Symbol as TypeScriptSymbol } from 'typescript/unstable/sync';
import {
  repositoryRelativePath as normalizedRepoPath,
  runtimeModuleClosure,
} from '../src/analysis/typescript-runtime.ts';

import { ARCHITECTURE_SQL_PATHS, loadArchitectureDatabase } from '../src/architecture/sql-model.ts';
import {
  deriveAssurancePropertyCompositions,
  deriveAssurancePropertyTrustRoots,
  deriveEffectTrustRoots,
  deriveRuntimeDispatchBindings,
  type AssurancePropertyTrustRoot,
  type EffectTrustRoot,
} from '../src/architecture/tcb.ts';

import {
  SyntaxKind,
  isCallExpression,
  isClassDeclaration,
  isEnumDeclaration,
  isFunctionDeclaration,
  isImportDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isTypeAliasDeclaration,
  isVariableStatement,
  type Node,
  type SourceFile,
} from 'typescript/unstable/ast';

interface SymbolEntry {
  path: string;
  symbol?: string;
  whole_file?: boolean;
  reason: string;
}

interface RuntimeDispatchBinding {
  target: string;
  implementation: {
    path: string;
    symbol: string;
  };
  reason: string;
}

interface TcbProperty {
  id: string;
  statement: string;
  require_sound_symbol_closure?: boolean;
  hostile_evidence_probes?: string[];
  entries: SymbolEntry[];
  composes_with?: string[];
  trusted_symbol_boundaries?: string[];
  runtime_dispatch_bindings?: RuntimeDispatchBinding[];
  external_assumptions: string[];
  excluded: string[];
}

interface TcbComposition {
  id: string;
  statement: string;
  properties: string[];
}

type TcbPolicyProperty = Omit<
  TcbProperty,
  'entries' | 'runtime_dispatch_bindings' | 'composes_with' | 'trusted_symbol_boundaries'
>;

interface TcbPolicy {
  schema: 'overcenter-tcb-policy';
  schema_version: 1 | 2;
  properties: TcbPolicyProperty[];
  compositions?: TcbComposition[];
}

interface MutationEvidenceProbe {
  id: string;
  source_blobs: Record<string, string>;
  mutation_score: number;
}

interface MutationEvidence {
  schema: string;
  probes: MutationEvidenceProbe[];
}

interface Slice {
  path: string;
  symbol: string;
  reason: string;
  start_line: number;
  end_line: number;
  physical_loc: number;
  semantic_loc: number;
  sha256: string;
}

function optionValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`TCB_OPTION_VALUE_REQUIRED:${name}`);
  return value;
}

const allowMissingTrustRoots = process.argv.includes('--allow-missing-trust-roots');

const policy = JSON.parse(readFileSync('tcb-policy.json', 'utf8')) as TcbPolicy;
if (
  policy.schema !== 'overcenter-tcb-policy' ||
  (policy.schema_version !== 1 && policy.schema_version !== 2)
) {
  throw new Error('TCB_POLICY_SCHEMA_UNSUPPORTED');
}

function scopeDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function propertyScopeDigest(property: TcbProperty): string {
  return scopeDigest({
    entries: property.entries
      .map((entry) => ({
        path: entry.path,
        symbol: entry.symbol ?? null,
        whole_file: entry.whole_file ?? false,
      }))
      .sort((left, right) =>
        `${left.path}#${left.symbol ?? (left.whole_file ? '*' : '')}`.localeCompare(
          `${right.path}#${right.symbol ?? (right.whole_file ? '*' : '')}`,
        ),
      ),
    runtime_dispatch_bindings: (property.runtime_dispatch_bindings ?? [])
      .map((binding) => ({
        target: binding.target,
        implementation: binding.implementation,
      }))
      .sort((left, right) => left.target.localeCompare(right.target)),
    composes_with: [...(property.composes_with ?? [])].sort(),
    trusted_symbol_boundaries: [...(property.trusted_symbol_boundaries ?? [])].sort(),
    external_assumptions: [...property.external_assumptions].sort(),
  });
}

function compositionScopeDigest(composition: TcbComposition): string {
  return scopeDigest({ properties: [...composition.properties].sort() });
}

interface ComparableTcbProperty {
  id: string;
  scope_sha256: string;
  hybrid_closure_semantic_loc: number;
  external_module_imports: string[];
  symbol_closure_external_symbols: string[];
}

interface ComparableTcbComposition {
  id: string;
  scope_sha256: string;
  properties: string[];
  hybrid_union_semantic_loc: number;
}

interface ComparableTcbReport {
  schema: 'overcenter-tcb-report';
  schema_version: 1;
  properties: ComparableTcbProperty[];
  compositions: ComparableTcbComposition[];
}

interface TcbDelta {
  scope: string;
  classification: 'unchanged' | 'reduction' | 'architectural-growth' | 'scope-change';
  baseline_semantic_loc: number | null;
  accepted_scope_semantic_loc: number | null;
  candidate_semantic_loc: number | null;
  delta_semantic_loc: number | null;
  accepted_scope_delta_semantic_loc: number | null;
  added_external_modules_under_accepted_scope: string[];
  added_external_symbols_under_accepted_scope: string[];
  growth_under_accepted_scope: boolean;
}

interface TcbReconciliation {
  baseline_revision: string;
  admitted: boolean;
  properties: TcbDelta[];
  compositions: TcbDelta[];
}

function reconcileTcb(
  baseline: ComparableTcbReport,
  candidateUnderAcceptedScope: ComparableTcbReport,
  candidate: ComparableTcbReport,
  baselineRevision: string,
): TcbReconciliation {
  const baseProperties = new Map(baseline.properties.map((property) => [property.id, property]));
  const acceptedScopeProperties = new Map(
    candidateUnderAcceptedScope.properties.map((property) => [property.id, property]),
  );
  const candidateProperties = new Map(
    candidate.properties.map((property) => [property.id, property]),
  );
  const propertyIds = [
    ...new Set([
      ...baseProperties.keys(),
      ...acceptedScopeProperties.keys(),
      ...candidateProperties.keys(),
    ]),
  ].sort();
  const scopeChanged = new Set<string>();
  const properties = propertyIds.map((id): TcbDelta => {
    const baseProperty = baseProperties.get(id);
    const acceptedScope = acceptedScopeProperties.get(id);
    const next = candidateProperties.get(id);
    const changed =
      !baseProperty || !acceptedScope || !next || acceptedScope.scope_sha256 !== next.scope_sha256;
    if (changed) scopeChanged.add(id);
    const acceptedScopeDelta =
      baseProperty && acceptedScope
        ? acceptedScope.hybrid_closure_semantic_loc - baseProperty.hybrid_closure_semantic_loc
        : null;
    const delta =
      baseProperty && next
        ? next.hybrid_closure_semantic_loc - baseProperty.hybrid_closure_semantic_loc
        : null;
    const baseExternalModules = new Set(baseProperty?.external_module_imports ?? []);
    const baseExternalSymbols = new Set(baseProperty?.symbol_closure_external_symbols ?? []);
    const addedExternalModules = (acceptedScope?.external_module_imports ?? []).filter(
      (module) => !baseExternalModules.has(module),
    );
    const addedExternalSymbols = (acceptedScope?.symbol_closure_external_symbols ?? []).filter(
      (symbol) => !baseExternalSymbols.has(symbol),
    );
    return {
      scope: id,
      classification: changed
        ? 'scope-change'
        : delta !== null && delta > 0
          ? 'architectural-growth'
          : delta !== null && delta < 0
            ? 'reduction'
            : 'unchanged',
      baseline_semantic_loc: baseProperty?.hybrid_closure_semantic_loc ?? null,
      accepted_scope_semantic_loc: acceptedScope?.hybrid_closure_semantic_loc ?? null,
      candidate_semantic_loc: next?.hybrid_closure_semantic_loc ?? null,
      delta_semantic_loc: delta,
      accepted_scope_delta_semantic_loc: acceptedScopeDelta,
      added_external_modules_under_accepted_scope: addedExternalModules,
      added_external_symbols_under_accepted_scope: addedExternalSymbols,
      growth_under_accepted_scope:
        (acceptedScopeDelta !== null && acceptedScopeDelta > 0) ||
        addedExternalModules.length > 0 ||
        addedExternalSymbols.length > 0,
    };
  });

  const baseCompositions = new Map(
    baseline.compositions.map((composition) => [composition.id, composition]),
  );
  const acceptedScopeCompositions = new Map(
    candidateUnderAcceptedScope.compositions.map((composition) => [composition.id, composition]),
  );
  const candidateCompositions = new Map(
    candidate.compositions.map((composition) => [composition.id, composition]),
  );
  const compositionIds = [
    ...new Set([
      ...baseCompositions.keys(),
      ...acceptedScopeCompositions.keys(),
      ...candidateCompositions.keys(),
    ]),
  ].sort();
  const compositions = compositionIds.map((id): TcbDelta => {
    const baseComposition = baseCompositions.get(id);
    const acceptedScope = acceptedScopeCompositions.get(id);
    const next = candidateCompositions.get(id);
    const memberScopeChanged =
      acceptedScope?.properties.some((property) => scopeChanged.has(property)) === true ||
      next?.properties.some((property) => scopeChanged.has(property)) === true;
    const changed =
      !baseComposition ||
      !acceptedScope ||
      !next ||
      acceptedScope.scope_sha256 !== next.scope_sha256 ||
      memberScopeChanged;
    const acceptedScopeDelta =
      baseComposition && acceptedScope
        ? acceptedScope.hybrid_union_semantic_loc - baseComposition.hybrid_union_semantic_loc
        : null;
    const delta =
      baseComposition && next
        ? next.hybrid_union_semantic_loc - baseComposition.hybrid_union_semantic_loc
        : null;
    return {
      scope: id,
      classification: changed
        ? 'scope-change'
        : delta !== null && delta > 0
          ? 'architectural-growth'
          : delta !== null && delta < 0
            ? 'reduction'
            : 'unchanged',
      baseline_semantic_loc: baseComposition?.hybrid_union_semantic_loc ?? null,
      accepted_scope_semantic_loc: acceptedScope?.hybrid_union_semantic_loc ?? null,
      candidate_semantic_loc: next?.hybrid_union_semantic_loc ?? null,
      delta_semantic_loc: delta,
      accepted_scope_delta_semantic_loc: acceptedScopeDelta,
      added_external_modules_under_accepted_scope: [],
      added_external_symbols_under_accepted_scope: [],
      growth_under_accepted_scope: acceptedScopeDelta !== null && acceptedScopeDelta > 0,
    };
  });

  return {
    baseline_revision: baselineRevision,
    admitted: ![...properties, ...compositions].some((delta) => delta.growth_under_accepted_scope),
    properties,
    compositions,
  };
}
const mutationEvidence = JSON.parse(
  readFileSync('experiments/production-criticality-ranking/mutation-evidence.json', 'utf8'),
) as MutationEvidence;
const mutationEvidenceById = new Map(mutationEvidence.probes.map((probe) => [probe.id, probe]));

const architectureDb = loadArchitectureDatabase();
let architectureRoots: EffectTrustRoot[];
let architecturePropertyRoots: AssurancePropertyTrustRoot[];
let architecturePropertyCompositions: Array<{
  property_id: string;
  required_property_id: string;
}>;
let architectureDispatchBindings: RuntimeDispatchBinding[];
try {
  architectureRoots = deriveEffectTrustRoots(architectureDb);
  architecturePropertyRoots = deriveAssurancePropertyTrustRoots(architectureDb);
  architecturePropertyCompositions = deriveAssurancePropertyCompositions(architectureDb);
  architectureDispatchBindings = deriveRuntimeDispatchBindings(architectureDb).map((binding) => ({
    target: `${binding.target.artifact_id}#${binding.target.symbol_id.split('.').at(-1)}`,
    implementation: {
      path: binding.implementation.artifact_id,
      symbol: binding.implementation.symbol_id,
    },
    reason: 'architecture physics dispatch binding',
  }));
} finally {
  architectureDb.close();
}

const propertyRootsById = new Map<string, AssurancePropertyTrustRoot[]>();
for (const root of architecturePropertyRoots) {
  const roots = propertyRootsById.get(root.property_id) ?? [];
  roots.push(root);
  propertyRootsById.set(root.property_id, roots);
}

const propertyCompositionById = new Map<string, string[]>();
for (const relation of architecturePropertyCompositions) {
  const required = propertyCompositionById.get(relation.property_id) ?? [];
  required.push(relation.required_property_id);
  propertyCompositionById.set(relation.property_id, required);
}

const measuredProperties: TcbProperty[] = policy.properties.map((property) => {
  const roots = propertyRootsById.get(property.id) ?? [];
  if (roots.length === 0) {
    throw new Error(`TCB_ARCHITECTURE_PROPERTY_ROOTS_MISSING:${property.id}`);
  }
  const grouped = new Map<string, { path: string; symbol: string; reasons: string[] }>();
  for (const root of roots) {
    const key = `${root.artifact_id}\0${root.symbol_id}`;
    const entry = grouped.get(key) ?? {
      path: root.artifact_id,
      symbol: root.symbol_id,
      reasons: [],
    };
    entry.reasons.push(`${root.basis}:${root.requirement_id}`);
    grouped.set(key, entry);
  }
  const entries = [...grouped.values()]
    .map((entry) => ({
      path: entry.path,
      symbol: entry.symbol,
      reason: [...new Set(entry.reasons)].sort().join(', '),
    }))
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) || left.symbol.localeCompare(right.symbol),
    );
  const composesWith = [...(propertyCompositionById.get(property.id) ?? [])].sort();
  const trustedSymbolBoundaries = [
    ...new Set(
      composesWith.flatMap((requiredPropertyId) =>
        (propertyRootsById.get(requiredPropertyId) ?? []).map(
          (root) => `${root.artifact_id}#${root.symbol_id.split('.').at(-1)}`,
        ),
      ),
    ),
  ].sort();
  return {
    ...property,
    entries,
    runtime_dispatch_bindings: architectureDispatchBindings,
    composes_with: composesWith,
    trusted_symbol_boundaries: trustedSymbolBoundaries,
  };
});

const openFiles = [
  ...new Set(
    [
      ...measuredProperties.flatMap((property) => property.entries.map((entry) => entry.path)),
      ...architectureRoots.map((root) => root.artifact_id),
      ...architectureDispatchBindings.flatMap((binding) => [
        binding.target.split('#', 1)[0]!,
        binding.implementation.path,
      ]),
    ]
      .map((path) => resolve(path))
      .filter((path) => !allowMissingTrustRoots || existsSync(path)),
  ),
];
const api = new API({ cwd: process.cwd() });
const snapshot = api.updateSnapshot({ openFiles });
const sourceCache = new Map<string, { text: string; source: SourceFile }>();

function sourceFor(path: string) {
  const cached = sourceCache.get(path);
  if (cached) return cached;
  const absolute = resolve(path);
  const project = snapshot.getDefaultProjectForFile(absolute);
  const source = project?.program.getSourceFile(absolute);
  if (!source) throw new Error(`TCB_SOURCE_UNAVAILABLE:${path}`);
  const text = readFileSync(path, 'utf8');
  const loaded = { text, source };
  sourceCache.set(path, loaded);
  return loaded;
}

function nodeName(node: Node, source: SourceFile): string | null {
  const named = node as Node & { name?: Node };
  if (!named.name) return null;
  return named.name.getText(source);
}

function topLevelNamed(source: SourceFile, name: string): Node | null {
  for (const statement of source.statements) {
    if (
      (isFunctionDeclaration(statement) ||
        isClassDeclaration(statement) ||
        isInterfaceDeclaration(statement) ||
        isTypeAliasDeclaration(statement) ||
        isEnumDeclaration(statement)) &&
      nodeName(statement, source) === name
    ) {
      return statement;
    }
    if (isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.name.getText(source) === name) return declaration;
      }
    }
  }
  return null;
}

function declarationFor(path: string, symbol: string): Node {
  const { source } = sourceFor(path);
  const dot = symbol.indexOf('.');
  if (dot < 0) {
    const found = topLevelNamed(source, symbol);
    if (!found) throw new Error(`TCB_SYMBOL_NOT_FOUND:${path}#${symbol}`);
    return found;
  }

  const ownerName = symbol.slice(0, dot);
  const memberName = symbol.slice(dot + 1);
  const owner = topLevelNamed(source, ownerName);
  if (!owner || !isClassDeclaration(owner)) {
    throw new Error(`TCB_OWNER_NOT_FOUND:${path}#${ownerName}`);
  }
  for (const member of owner.members) {
    if (nodeName(member, source) === memberName) return member;
  }
  throw new Error(`TCB_MEMBER_NOT_FOUND:${path}#${symbol}`);
}

function measurableEntries(entries: readonly SymbolEntry[]): SymbolEntry[] {
  return entries.filter((entry) => {
    try {
      if (entry.whole_file === true) {
        sourceFor(entry.path);
      } else {
        declarationFor(
          entry.path,
          entry.symbol ??
            (() => {
              throw new Error('TCB_SYMBOL_REQUIRED');
            })(),
        );
      }
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        allowMissingTrustRoots &&
        /^(TCB_SOURCE_UNAVAILABLE|TCB_SYMBOL_NOT_FOUND|TCB_OWNER_NOT_FOUND|TCB_MEMBER_NOT_FOUND):/.test(
          message,
        )
      ) {
        return false;
      }
      throw error;
    }
  });
}

function semanticLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith('//') &&
    !trimmed.startsWith('/*') &&
    !trimmed.startsWith('*') &&
    !trimmed.startsWith('*/')
  );
}

function sliceFor(entry: SymbolEntry): Slice {
  const { text, source } = sourceFor(entry.path);
  const node =
    entry.whole_file === true
      ? source
      : declarationFor(
          entry.path,
          entry.symbol ??
            (() => {
              throw new Error('TCB_SYMBOL_REQUIRED');
            })(),
        );
  const start = entry.whole_file === true ? 0 : node.getStart(source);
  const end = entry.whole_file === true ? text.length : node.getEnd();
  const startLine = source.getLineAndCharacterOfPosition(start).line + 1;
  const endLine = source.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line + 1;
  const selected = text.slice(start, end);
  const lines = selected.split('\n');
  return {
    path: entry.path,
    symbol: entry.whole_file === true ? '*' : (entry.symbol as string),
    reason: entry.reason,
    start_line: startLine,
    end_line: endLine,
    physical_loc: endLine - startLine + 1,
    semantic_loc: lines.filter(semanticLine).length,
    sha256: createHash('sha256').update(selected).digest('hex'),
  };
}

function uniqueSemanticLoc(slices: Slice[]): number {
  const trusted = new Map<string, Set<number>>();
  for (const slice of slices) {
    const { text } = sourceFor(slice.path);
    const lines = text.split('\n');
    const selected = trusted.get(slice.path) ?? new Set<number>();
    for (let line = slice.start_line; line <= slice.end_line; line += 1) {
      if (semanticLine(lines[line - 1] ?? '')) selected.add(line);
    }
    trusted.set(slice.path, selected);
  }
  return [...trusted.values()].reduce((sum, lines) => sum + lines.size, 0);
}

function gitBlobSha1(path: string): string {
  const bytes = readFileSync(path);
  return createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function hostileEvidenceFor(probeIds: readonly string[] | undefined) {
  if (!probeIds || probeIds.length === 0) {
    return { status: 'unconfigured' as const, probes: [] };
  }
  const probes = probeIds.map((id) => {
    const probe = mutationEvidenceById.get(id);
    if (!probe) throw new Error(`TCB_HOSTILE_EVIDENCE_PROBE_UNKNOWN:${id}`);
    const sources = Object.entries(probe.source_blobs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, expected_blob_sha1]) => {
        const current_blob_sha1 = existsSync(path) ? gitBlobSha1(path) : null;
        return {
          path,
          expected_blob_sha1,
          current_blob_sha1,
          current: current_blob_sha1 === expected_blob_sha1,
        };
      });
    return {
      id,
      mutation_score: probe.mutation_score,
      status: sources.every((source) => source.current) ? ('current' as const) : ('stale' as const),
      sources,
    };
  });
  return {
    status: probes.every((probe) => probe.status === 'current')
      ? ('current' as const)
      : ('stale' as const),
    probes,
  };
}

interface ModuleClosure {
  files: string[];
  semantic_loc: number;
  bytes: number;
  sha256: string;
  external_modules: string[];
}

interface SymbolClosure {
  semantic_loc: number;
  files: string[];
  declarations: Array<{
    path: string;
    start_line: number;
    end_line: number;
    semantic_loc: number;
    symbol: string;
  }>;
  external_symbols: string[];
  obligations: string[];
  composed_boundaries: string[];
  resolved_dispatch_bindings: string[];
  status: 'candidate' | 'sound';
}

function isTypeSpaceNode(node: Node): boolean {
  return (
    (node.kind >= SyntaxKind.FirstTypeNode && node.kind <= SyntaxKind.LastTypeNode) ||
    node.kind === SyntaxKind.AnyKeyword ||
    node.kind === SyntaxKind.UnknownKeyword ||
    node.kind === SyntaxKind.NumberKeyword ||
    node.kind === SyntaxKind.BigIntKeyword ||
    node.kind === SyntaxKind.ObjectKeyword ||
    node.kind === SyntaxKind.BooleanKeyword ||
    node.kind === SyntaxKind.StringKeyword ||
    node.kind === SyntaxKind.SymbolKeyword ||
    node.kind === SyntaxKind.VoidKeyword ||
    node.kind === SyntaxKind.UndefinedKeyword ||
    node.kind === SyntaxKind.NeverKeyword ||
    node.kind === SyntaxKind.IntrinsicKeyword ||
    node.kind === SyntaxKind.ExpressionWithTypeArguments
  );
}

function isTypeOnlySpecifier(node: Node): boolean {
  if (node.kind !== SyntaxKind.ImportSpecifier && node.kind !== SyntaxKind.ExportSpecifier) {
    return false;
  }
  return (node as Node & { isTypeOnly?: boolean }).isTypeOnly === true;
}

function repoPathFor(node: Node): string | null {
  const source = node.getSourceFile();
  if (source.isDeclarationFile) return null;
  const path = normalizedRepoPath(source.fileName);
  if (
    path.startsWith('../') ||
    path === '..' ||
    path.startsWith('node_modules/') ||
    path.includes('/node_modules/')
  ) {
    return null;
  }
  return path;
}

function checkerFor(node: Node) {
  const project = snapshot.getDefaultProjectForFile(node.getSourceFile().fileName);
  if (!project) throw new Error(`TCB_PROJECT_UNAVAILABLE:${node.getSourceFile().fileName}`);
  return project.checker;
}

function resolvedValueSymbol(node: Node): TypeScriptSymbol | null {
  const checker = checkerFor(node);
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return null;
  const resolved = symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  if (checker.isUnknownSymbol(resolved)) return null;
  return resolved.flags & SymbolFlags.Value ? resolved : null;
}

function isInvocationTarget(node: Node): boolean {
  const parent = node.parent;
  if (isCallExpression(parent) && parent.expression === node) return true;
  if (parent.kind === SyntaxKind.PropertyAccessExpression) {
    const access = parent as Node & { name: Node };
    return (
      access.name === node && isCallExpression(parent.parent) && parent.parent.expression === parent
    );
  }
  return false;
}

function hasCallableImplementation(node: Node): boolean {
  if (
    node.kind === SyntaxKind.FunctionDeclaration ||
    node.kind === SyntaxKind.MethodDeclaration ||
    node.kind === SyntaxKind.FunctionExpression ||
    node.kind === SyntaxKind.ArrowFunction
  ) {
    return (node as Node & { body?: Node }).body !== undefined;
  }
  if (
    node.kind === SyntaxKind.VariableDeclaration ||
    node.kind === SyntaxKind.PropertyDeclaration ||
    node.kind === SyntaxKind.PropertyAssignment
  ) {
    return (node as Node & { initializer?: Node }).initializer !== undefined;
  }
  return false;
}

function isRuntimeDeclaration(node: Node): boolean {
  if (node.getSourceFile().isDeclarationFile) return false;
  return !isTypeSpaceNode(node) && !isInterfaceDeclaration(node) && !isTypeAliasDeclaration(node);
}

function lineRange(node: Node): {
  path: string;
  start_line: number;
  end_line: number;
  semantic_loc: number;
} | null {
  const path = repoPathFor(node);
  if (!path) return null;
  const { text, source } = sourceFor(path);
  const start = node.getStart(source);
  const end = node.getEnd();
  const startLine = source.getLineAndCharacterOfPosition(start).line + 1;
  const endLine = source.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line + 1;
  return {
    path,
    start_line: startLine,
    end_line: endLine,
    semantic_loc: text
      .split('\n')
      .slice(startLine - 1, endLine)
      .filter(semanticLine).length,
  };
}

function symbolClosure(property: TcbProperty): SymbolClosure {
  if ((property.trusted_symbol_boundaries?.length ?? 0) > 0 && !property.composes_with?.length) {
    throw new Error(`TCB_COMPOSITION_REQUIRED:${property.id}`);
  }
  const boundaries = new Set(property.trusted_symbol_boundaries ?? []);
  const dispatchBindings = new Map(
    (property.runtime_dispatch_bindings ?? []).map((binding) => [binding.target, binding]),
  );
  const queue: Array<{ node: Node; symbol: string }> = property.entries.map((entry) => {
    const { source } = sourceFor(entry.path);
    return {
      node:
        entry.whole_file === true
          ? source
          : declarationFor(
              entry.path,
              entry.symbol ??
                (() => {
                  throw new Error('TCB_SYMBOL_REQUIRED');
                })(),
            ),
      symbol: entry.whole_file === true ? `${entry.path}#*` : `${entry.path}#${entry.symbol}`,
    };
  });
  const visitedSymbols = new Set<number>();
  const declarations = new Map<
    string,
    {
      path: string;
      start_line: number;
      end_line: number;
      semantic_loc: number;
      symbol: string;
    }
  >();
  const externalSymbols = new Set<string>();
  const obligations = new Set<string>();
  const composedBoundaries = new Set<string>();
  const resolvedDispatchBindings = new Set<string>();

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;
    const range = lineRange(current.node);
    if (range) {
      const key = `${range.path}:${range.start_line}:${range.end_line}`;
      declarations.set(key, { ...range, symbol: current.symbol });
    }

    const visit = (node: Node): void => {
      if (
        isTypeSpaceNode(node) ||
        isInterfaceDeclaration(node) ||
        isTypeAliasDeclaration(node) ||
        (isImportDeclaration(node) &&
          node.importClause?.phaseModifier === SyntaxKind.TypeKeyword) ||
        isTypeOnlySpecifier(node)
      ) {
        return;
      }

      if (isIdentifier(node)) {
        const symbol = resolvedValueSymbol(node);
        if (symbol && !visitedSymbols.has(symbol.id)) {
          visitedSymbols.add(symbol.id);
          const resolvedDeclarations = symbol.declarations
            .map((handle) => handle.resolve())
            .filter((declaration): declaration is Node => declaration !== undefined);
          const repositoryDeclarations = resolvedDeclarations.filter(
            (declaration) => repoPathFor(declaration) !== null,
          );
          const runtimeDeclarations = repositoryDeclarations.filter(isRuntimeDeclaration);
          const declarationKeys = repositoryDeclarations
            .map((declaration) => repoPathFor(declaration))
            .filter((path): path is string => path !== null)
            .map((path) => `${path}#${symbol.name}`);
          const boundaryDeclarations = runtimeDeclarations.filter((declaration) => {
            const path = repoPathFor(declaration);
            return path !== null && boundaries.has(`${path}#${symbol.name}`);
          });
          for (const declaration of boundaryDeclarations) {
            const path = repoPathFor(declaration) as string;
            composedBoundaries.add(`${path}#${symbol.name}`);
          }
          const activeRuntimeDeclarations = runtimeDeclarations.filter(
            (declaration) => !boundaryDeclarations.includes(declaration),
          );
          const dispatchBinding = declarationKeys
            .map((key) => dispatchBindings.get(key))
            .find((binding): binding is RuntimeDispatchBinding => binding !== undefined);

          if (activeRuntimeDeclarations.length > 0) {
            if (
              isInvocationTarget(node) &&
              !activeRuntimeDeclarations.some(hasCallableImplementation)
            ) {
              if (dispatchBinding) {
                queue.push({
                  node: declarationFor(
                    dispatchBinding.implementation.path,
                    dispatchBinding.implementation.symbol,
                  ),
                  symbol: dispatchBinding.implementation.symbol,
                });
                resolvedDispatchBindings.add(
                  `${dispatchBinding.target}->${dispatchBinding.implementation.path}#${dispatchBinding.implementation.symbol}`,
                );
              } else {
                const targets = [
                  ...new Set(
                    activeRuntimeDeclarations
                      .map((declaration) => repoPathFor(declaration))
                      .filter((path): path is string => path !== null),
                  ),
                ].sort();
                obligations.add(
                  `DYNAMIC_CALL_TARGET_UNRESOLVED:${symbol.name}:${targets.join(',')}`,
                );
              }
            }
            for (const declaration of activeRuntimeDeclarations) {
              queue.push({
                node: declaration,
                symbol: symbol.name,
              });
            }
          } else if (boundaryDeclarations.length > 0) {
            // The implementation is deliberately supplied by a separately measured TCB property.
          } else if (repositoryDeclarations.length > 0 && dispatchBinding) {
            queue.push({
              node: declarationFor(
                dispatchBinding.implementation.path,
                dispatchBinding.implementation.symbol,
              ),
              symbol: dispatchBinding.implementation.symbol,
            });
            resolvedDispatchBindings.add(
              `${dispatchBinding.target}->${dispatchBinding.implementation.path}#${dispatchBinding.implementation.symbol}`,
            );
          } else if (repositoryDeclarations.length > 0) {
            const targets = [...new Set(declarationKeys.map((key) => key.split('#')[0]))].sort();
            obligations.add(`DYNAMIC_DISPATCH_UNRESOLVED:${symbol.name}:${targets.join(',')}`);
          } else {
            externalSymbols.add(symbol.name);
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(current.node);
  }

  const trusted = new Map<string, Set<number>>();
  for (const declaration of declarations.values()) {
    const { text } = sourceFor(declaration.path);
    const lines = text.split('\n');
    const selected = trusted.get(declaration.path) ?? new Set<number>();
    for (let line = declaration.start_line; line <= declaration.end_line; line += 1) {
      if (semanticLine(lines[line - 1] ?? '')) selected.add(line);
    }
    trusted.set(declaration.path, selected);
  }

  const output = [...declarations.values()].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.start_line - right.start_line ||
      left.end_line - right.end_line,
  );
  return {
    semantic_loc: [...trusted.values()].reduce((sum, lines) => sum + lines.size, 0),
    files: [...trusted.keys()].sort(),
    declarations: output,
    external_symbols: [...externalSymbols].sort(),
    obligations: [...obligations].sort(),
    composed_boundaries: [...composedBoundaries].sort(),
    resolved_dispatch_bindings: [...resolvedDispatchBindings].sort(),
    status: obligations.size === 0 ? 'sound' : 'candidate',
  };
}

interface HybridClosure {
  semantic_loc: number;
  files: string[];
  sha256: string;
  semantic_line_ranges: Array<{
    path: string;
    ranges: Array<[number, number]>;
  }>;
}

function hybridClosure(
  module: ModuleClosure,
  symbols: SymbolClosure,
  property: TcbProperty,
): HybridClosure {
  const trusted = new Map<string, Set<number>>();
  const fingerprintMaterial = [`module:${module.sha256}`];
  const moduleFiles = new Set(module.files);

  for (const path of module.files) {
    const { text } = sourceFor(path);
    const selected = trusted.get(path) ?? new Set<number>();
    text.split('\n').forEach((line, index) => {
      if (semanticLine(line)) selected.add(index + 1);
    });
    trusted.set(path, selected);
  }

  for (const declaration of symbols.declarations) {
    const { text } = sourceFor(declaration.path);
    const lines = text.split('\n');
    const selected = trusted.get(declaration.path) ?? new Set<number>();
    for (let line = declaration.start_line; line <= declaration.end_line; line += 1) {
      if (semanticLine(lines[line - 1] ?? '')) selected.add(line);
    }
    trusted.set(declaration.path, selected);

    if (!moduleFiles.has(declaration.path)) {
      const source = sourceFor(declaration.path).source;
      const start = source.getPositionOfLineAndCharacter(declaration.start_line - 1, 0);
      const end =
        declaration.end_line < lines.length
          ? source.getPositionOfLineAndCharacter(declaration.end_line, 0)
          : text.length;
      const body = text.slice(start, end);
      fingerprintMaterial.push(
        `symbol:${declaration.path}:${declaration.start_line}-${declaration.end_line}:${createHash('sha256').update(body).digest('hex')}`,
      );
    }
  }

  for (const boundary of symbols.composed_boundaries) {
    fingerprintMaterial.push(`composition:${boundary}`);
  }
  for (const binding of symbols.resolved_dispatch_bindings) {
    fingerprintMaterial.push(`dispatch:${binding}`);
  }
  for (const propertyId of property.composes_with ?? []) {
    fingerprintMaterial.push(`composes-with:${propertyId}`);
  }

  const semanticLineRanges = [...trusted.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, selected]) => {
      const ranges: Array<[number, number]> = [];
      for (const line of [...selected].sort((left, right) => left - right)) {
        const current = ranges.at(-1);
        if (current && line === current[1] + 1) {
          current[1] = line;
        } else {
          ranges.push([line, line]);
        }
      }
      return { path, ranges };
    });

  return {
    semantic_loc: [...trusted.values()].reduce((sum, lines) => sum + lines.size, 0),
    files: [...trusted.keys()].sort(),
    sha256: createHash('sha256').update(fingerprintMaterial.sort().join('\n')).digest('hex'),
    semantic_line_ranges: semanticLineRanges,
  };
}

function moduleClosure(rootPaths: string[]): ModuleClosure {
  const closure = runtimeModuleClosure(process.cwd(), rootPaths, (path) => sourceFor(path).source);
  let semanticLoc = 0;
  let bytes = 0;
  const hashes: string[] = [];
  for (const path of closure.files) {
    const text = readFileSync(path, 'utf8');
    semanticLoc += text.split('\n').filter(semanticLine).length;
    bytes += Buffer.byteLength(text);
    hashes.push(`${path}:${createHash('sha256').update(text).digest('hex')}`);
  }

  return {
    files: closure.files,
    semantic_loc: semanticLoc,
    bytes,
    sha256: createHash('sha256').update(hashes.join('\n')).digest('hex'),
    external_modules: closure.external_modules,
  };
}

try {
  let failed = false;
  const reports = measuredProperties.map((property) => {
    const measuredEntries = measurableEntries(property.entries);
    const measuredProperty =
      measuredEntries.length === property.entries.length
        ? property
        : { ...property, entries: measuredEntries };
    const slices = measuredEntries.map(sliceFor);
    const semanticLoc = uniqueSemanticLoc(slices);
    const surfaceSha256 = createHash('sha256')
      .update(
        slices
          .map((slice) => `${slice.path}#${slice.symbol}:${slice.sha256}`)
          .sort()
          .join('\n'),
      )
      .digest('hex');
    const closure = moduleClosure(measuredEntries.map((entry) => entry.path));
    const symbols = symbolClosure(measuredProperty);
    const hybrid = hybridClosure(closure, symbols, measuredProperty);
    const moduleFiles = new Set(closure.files);
    const symbolFilesOutsideModuleClosure = symbols.files.filter((path) => !moduleFiles.has(path));
    if (property.require_sound_symbol_closure && symbols.status !== 'sound') {
      failed = true;
    }
    return {
      id: property.id,
      statement: property.statement,
      scope_sha256: propertyScopeDigest(property),
      semantic_loc: semanticLoc,
      surface_sha256: surfaceSha256,
      module_closure_semantic_loc: closure.semantic_loc,
      module_closure_bytes: closure.bytes,
      module_closure_sha256: closure.sha256,
      module_closure_files: closure.files,
      external_module_imports: closure.external_modules,
      symbol_closure_status: symbols.status,
      symbol_closure_semantic_loc: symbols.semantic_loc,
      require_sound_symbol_closure: property.require_sound_symbol_closure ?? false,
      hybrid_closure_semantic_loc: hybrid.semantic_loc,
      hybrid_closure_sha256: hybrid.sha256,
      hybrid_closure_files: hybrid.files,
      symbol_closure_files: symbols.files,
      symbol_closure_files_outside_module_closure: symbolFilesOutsideModuleClosure,
      symbol_closure_declarations: symbols.declarations,
      symbol_closure_external_symbols: symbols.external_symbols,
      symbol_closure_obligations: symbols.obligations,
      symbol_closure_composed_boundaries: symbols.composed_boundaries,
      symbol_closure_resolved_dispatch_bindings: symbols.resolved_dispatch_bindings,
      composes_with: property.composes_with ?? [],
      hostile_evidence: hostileEvidenceFor(property.hostile_evidence_probes),
      slices,
      external_assumptions: property.external_assumptions,
      excluded: property.excluded,
    };
  });

  const compositions = (policy.compositions ?? []).map((composition) => {
    const members = composition.properties.map((id) => {
      const member = reports.find((candidate) => candidate.id === id);
      if (!member) throw new Error(`TCB_COMPOSITION_PROPERTY_UNKNOWN:${composition.id}:${id}`);
      return member;
    });
    const trusted = new Map<string, Set<number>>();
    for (const member of members) {
      for (const path of member.module_closure_files) {
        const lines = readFileSync(path, 'utf8').split('\n');
        const selected = trusted.get(path) ?? new Set<number>();
        lines.forEach((line, index) => {
          if (semanticLine(line)) selected.add(index + 1);
        });
        trusted.set(path, selected);
      }
      const moduleFiles = new Set(member.module_closure_files);
      for (const declaration of member.symbol_closure_declarations) {
        if (moduleFiles.has(declaration.path)) continue;
        const lines = readFileSync(declaration.path, 'utf8').split('\n');
        const selected = trusted.get(declaration.path) ?? new Set<number>();
        for (let line = declaration.start_line; line <= declaration.end_line; line += 1) {
          if (semanticLine(lines[line - 1] ?? '')) selected.add(line);
        }
        trusted.set(declaration.path, selected);
      }
    }
    const fingerprintMaterial = [`composition:${composition.id}`];
    for (const member of [...composition.properties].sort())
      fingerprintMaterial.push(`member:${member}`);
    for (const path of [...trusted.keys()].sort()) {
      const lines = readFileSync(path, 'utf8').split('\n');
      for (const line of [...(trusted.get(path) ?? [])].sort((left, right) => left - right)) {
        fingerprintMaterial.push(`${path}:${line}:${lines[line - 1] ?? ''}`);
      }
    }
    const semanticLoc = [...trusted.values()].reduce((sum, lines) => sum + lines.size, 0);
    const sha256 = createHash('sha256').update(fingerprintMaterial.join('\n')).digest('hex');
    const memberEvidence = members.map((member) => member.hostile_evidence);
    const hasStaleEvidence = memberEvidence.some((evidence) => evidence.status === 'stale');
    const hasUnconfiguredEvidence = memberEvidence.some(
      (evidence) => evidence.status === 'unconfigured',
    );
    const hostileEvidenceStatus =
      hasStaleEvidence && hasUnconfiguredEvidence
        ? 'stale-and-incomplete'
        : hasStaleEvidence
          ? 'stale'
          : hasUnconfiguredEvidence
            ? 'incomplete'
            : 'current';
    return {
      id: composition.id,
      statement: composition.statement,
      scope_sha256: compositionScopeDigest(composition),
      properties: composition.properties,
      hybrid_union_semantic_loc: semanticLoc,
      hybrid_union_sha256: sha256,
      hybrid_union_files: [...trusted.keys()].sort(),
      hybrid_union_file_semantic_loc: [...trusted.entries()]
        .map(([path, lines]) => ({ path, semantic_loc: lines.size }))
        .sort(
          (left, right) =>
            right.semantic_loc - left.semantic_loc || left.path.localeCompare(right.path),
        ),
      hostile_evidence_status: hostileEvidenceStatus,
    };
  });

  const propertyCoversRoot = (
    property: (typeof reports)[number],
    root: EffectTrustRoot,
  ): boolean => {
    if (property.module_closure_files.includes(root.artifact_id)) return true;
    if (
      property.slices.some(
        (slice) =>
          slice.path === root.artifact_id &&
          (slice.symbol === '*' ||
            slice.symbol === root.symbol_id ||
            slice.symbol === root.symbol_id.split('.').at(-1)),
      )
    ) {
      return true;
    }
    const leaf = root.symbol_id.split('.').at(-1);
    return property.symbol_closure_declarations.some(
      (declaration) =>
        declaration.path === root.artifact_id &&
        (declaration.symbol === root.symbol_id || declaration.symbol === leaf),
    );
  };

  const rootsByEffect = new Map<string, EffectTrustRoot[]>();
  for (const root of architectureRoots) {
    const roots = rootsByEffect.get(root.effect_id) ?? [];
    roots.push(root);
    rootsByEffect.set(root.effect_id, roots);
  }

  const architectureEffectTcbs = [...rootsByEffect]
    .map(([effectId, roots]) => {
      const groupedEntries = new Map<string, { path: string; symbol: string; reasons: string[] }>();
      for (const root of roots) {
        const key = `${root.artifact_id}\0${root.symbol_id}`;
        const entry = groupedEntries.get(key) ?? {
          path: root.artifact_id,
          symbol: root.symbol_id,
          reasons: [],
        };
        entry.reasons.push(`${root.basis}:${root.requirement_id}`);
        groupedEntries.set(key, entry);
      }
      const entries: SymbolEntry[] = [...groupedEntries.values()]
        .map((entry) => ({
          path: entry.path,
          symbol: entry.symbol,
          reason: [...new Set(entry.reasons)].sort().join(', '),
        }))
        .sort(
          (left, right) =>
            left.path.localeCompare(right.path) ||
            (left.symbol ?? '').localeCompare(right.symbol ?? ''),
        );
      const measuredEntries = measurableEntries(entries);
      const candidate: TcbProperty = {
        id: `architecture-effect:${effectId}`,
        statement: `Architecture-derived trusted computation required for ${effectId}.`,
        entries: measuredEntries,
        runtime_dispatch_bindings: architectureDispatchBindings,
        external_assumptions: [],
        excluded: [],
      };
      const slices = measuredEntries.map(sliceFor);
      const closure = moduleClosure(measuredEntries.map((entry) => entry.path));
      const symbols = symbolClosure(candidate);
      const hybrid = hybridClosure(closure, symbols, candidate);
      return {
        effect_id: effectId,
        roots,
        root_semantic_loc: uniqueSemanticLoc(slices),
        module_closure_semantic_loc: closure.semantic_loc,
        symbol_closure_status: symbols.status,
        symbol_closure_semantic_loc: symbols.semantic_loc,
        symbol_closure_obligations: symbols.obligations,
        resolved_dispatch_bindings: symbols.resolved_dispatch_bindings,
        hybrid_closure_semantic_loc: hybrid.semantic_loc,
        hybrid_closure_sha256: hybrid.sha256,
        hybrid_closure_files: hybrid.files,
        hybrid_closure_semantic_line_ranges: hybrid.semantic_line_ranges,
      };
    })
    .sort((left, right) => left.effect_id.localeCompare(right.effect_id));

  const architectureTcb = {
    source: ARCHITECTURE_SQL_PATHS,
    runtime_dispatch_bindings: architectureDispatchBindings,
    effects: architectureEffectTcbs.map((candidate) => {
      const compositionsForEffect = compositions
        .map((composition) => {
          const properties = composition.properties
            .map((id) => reports.find((property) => property.id === id))
            .filter((property): property is (typeof reports)[number] => property !== undefined);
          const uncoveredRoots = candidate.roots.filter(
            (root) => !properties.some((property) => propertyCoversRoot(property, root)),
          );
          return {
            composition_id: composition.id,
            covered: uncoveredRoots.length === 0,
            semantic_loc_delta:
              candidate.hybrid_closure_semantic_loc - composition.hybrid_union_semantic_loc,
            uncovered_roots: uncoveredRoots,
          };
        })
        .sort((left, right) => left.composition_id.localeCompare(right.composition_id));
      return {
        ...candidate,
        covered_by_compositions: compositionsForEffect
          .filter((composition) => composition.covered)
          .map((composition) => composition.composition_id),
        composition_coverage: compositionsForEffect,
      };
    }),
  };

  type TcbFindingKind = 'hostile-evidence-stale' | 'hostile-evidence-missing';

  interface TcbFinding {
    id: string;
    kind: TcbFindingKind;
    scope: string;
    evidence: Record<string, unknown>;
  }

  const findings: TcbFinding[] = [];
  for (const property of reports) {
    for (const probe of property.hostile_evidence.probes) {
      if (probe.status !== 'stale') continue;
      findings.push({
        id: `tcb:hostile-evidence-stale:${property.id}:${probe.id}`,
        kind: 'hostile-evidence-stale',
        scope: property.id,
        evidence: {
          probe_id: probe.id,
          mutation_score: probe.mutation_score,
          stale_sources: probe.sources.filter((source) => !source.current),
        },
      });
    }
    if (property.hostile_evidence.status === 'unconfigured') {
      findings.push({
        id: `tcb:hostile-evidence-missing:${property.id}`,
        kind: 'hostile-evidence-missing',
        scope: property.id,
        evidence: {
          property_id: property.id,
          hybrid_sha256: property.hybrid_closure_sha256,
        },
      });
    }
  }
  findings.sort((left, right) => left.id.localeCompare(right.id));

  const report = {
    schema: 'overcenter-tcb-report' as const,
    schema_version: 1 as const,
    generated_from: [...ARCHITECTURE_SQL_PATHS, 'tcb-policy.json'],
    architecture_tcb: architectureTcb,
    properties: reports,
    compositions,
    obligations: findings,
  };

  const baselineRevision = optionValue('--baseline');
  let reconciliation: TcbReconciliation | null = null;
  if (baselineRevision !== null) {
    if (!/^[0-9a-f]{40}$/.test(baselineRevision)) {
      throw new Error('TCB_BASELINE_REVISION_INVALID');
    }
    const scratch = mkdtempSync(join(tmpdir(), 'overcenter-tcb-baseline-'));
    const baselineRoot = join(scratch, 'baseline');
    const acceptedScopeRoot = join(scratch, 'accepted-scope');
    const baselineOutput = join(scratch, 'baseline.json');
    const acceptedScopeOutput = join(scratch, 'accepted-scope.json');
    try {
      const candidateRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
      execFileSync('git', ['worktree', 'add', '--detach', baselineRoot, baselineRevision], {
        stdio: 'ignore',
      });
      execFileSync('git', ['worktree', 'add', '--detach', acceptedScopeRoot, candidateRevision], {
        stdio: 'ignore',
      });
      const installedModules = resolve('node_modules');
      if (existsSync(installedModules)) {
        for (const root of [baselineRoot, acceptedScopeRoot]) {
          symlinkSync(
            installedModules,
            join(root, 'node_modules'),
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        }
      }
      for (const path of ['tcb-policy.json', ...ARCHITECTURE_SQL_PATHS]) {
        const accepted = execFileSync('git', ['show', `${baselineRevision}:${path}`], {
          encoding: 'utf8',
        });
        writeFileSync(join(acceptedScopeRoot, path), accepted, 'utf8');
      }
      const trustedScript = fileURLToPath(import.meta.url);
      const runReport = (
        cwd: string,
        output: string,
        label: string,
        allowMissing = false,
      ): ComparableTcbReport => {
        const run = spawnSync(
          process.execPath,
          [
            '--experimental-strip-types',
            trustedScript,
            '--output',
            output,
            ...(allowMissing ? ['--allow-missing-trust-roots'] : []),
          ],
          { cwd, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] },
        );
        if (run.status !== 0 || !existsSync(output)) {
          throw new Error(
            `TCB_${label}_ANALYSIS_FAILED:${String(run.stderr || run.stdout || '').trim()}`,
          );
        }
        return JSON.parse(readFileSync(output, 'utf8')) as ComparableTcbReport;
      };
      const baseline = runReport(baselineRoot, baselineOutput, 'BASELINE');
      const candidateUnderAcceptedScope = runReport(
        acceptedScopeRoot,
        acceptedScopeOutput,
        'ACCEPTED_SCOPE',
        true,
      );
      reconciliation = reconcileTcb(
        baseline,
        candidateUnderAcceptedScope,
        report,
        baselineRevision,
      );
      if (!reconciliation.admitted) failed = true;
    } finally {
      for (const root of [acceptedScopeRoot, baselineRoot]) {
        spawnSync('git', ['worktree', 'remove', '--force', root], { stdio: 'ignore' });
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  const finalReport = { ...report, reconciliation };

  const outputPath = optionValue('--output');
  if (outputPath) {
    writeFileSync(outputPath, `${JSON.stringify(finalReport, null, 2)}\n`, 'utf8');
  }

  const summaryPath = optionValue('--summary');
  if (summaryPath) {
    const number = (value: number): string => value.toLocaleString('en-US');
    const signed = (value: number | null): string =>
      value === null ? 'n/a' : value > 0 ? `+${number(value)}` : number(value);
    const propertyDelta = new Map(
      (reconciliation?.properties ?? []).map((delta) => [delta.scope, delta]),
    );
    const compositionDelta = new Map(
      (reconciliation?.compositions ?? []).map((delta) => [delta.scope, delta]),
    );
    const staleProbeRows = reports.flatMap((property) =>
      property.hostile_evidence.probes
        .filter((probe) => probe.status !== 'current')
        .map(
          (probe) =>
            `| \`${property.id}\` | \`${probe.id}\` | ${probe.status} | ${probe.mutation_score.toFixed(3)} |`,
        ),
    );
    const summary = [
      '## Trusted computing base analysis',
      '',
      reconciliation
        ? `Accepted-base comparison: **${reconciliation.admitted ? 'admitted' : 'rejected'}** against \`${reconciliation.baseline_revision}\`.`
        : 'Observation only: no accepted-base revision was supplied.',
      '',
      '| Property | Hybrid TCB | Δ total | Δ under accepted scope | Classification | Symbol closure | Hostile evidence |',
      '| --- | ---: | ---: | ---: | --- | --- | --- |',
      ...reports.map((property) => {
        const delta = propertyDelta.get(property.id);
        return `| \`${property.id}\` | **${number(property.hybrid_closure_semantic_loc)}** | ${signed(delta?.delta_semantic_loc ?? null)} | ${signed(delta?.accepted_scope_delta_semantic_loc ?? null)} | ${delta?.classification ?? 'observation-only'} | ${property.symbol_closure_status} | ${property.hostile_evidence.status} |`;
      }),
      '',
      '| Composition | Deduplicated hybrid union | Δ total | Δ under accepted scope | Classification | Hostile evidence |',
      '| --- | ---: | ---: | ---: | --- | --- |',
      ...compositions.map((composition) => {
        const delta = compositionDelta.get(composition.id);
        return `| \`${composition.id}\` | **${number(composition.hybrid_union_semantic_loc)}** | ${signed(delta?.delta_semantic_loc ?? null)} | ${signed(delta?.accepted_scope_delta_semantic_loc ?? null)} | ${delta?.classification ?? 'observation-only'} | ${composition.hostile_evidence_status} |`;
      }),
      '',
      '### Architecture-derived trust roots',
      '',
      '| Effect | Roots | Derived TCB | Symbol closure | Covered by current composition |',
      '| --- | ---: | ---: | --- | --- |',
      ...architectureTcb.effects.map(
        (effect) =>
          `| \`${effect.effect_id}\` | ${effect.roots.length} | **${number(effect.hybrid_closure_semantic_loc)}** | ${effect.symbol_closure_status} | ${effect.covered_by_compositions.length > 0 ? effect.covered_by_compositions.map((id) => `\`${id}\``).join(', ') : '_none_'} |`,
      ),
      '',
      '### Hostile-evidence debt',
      '',
      '| Property | Probe | Freshness | Mutation score |',
      '| --- | --- | --- | ---: |',
      ...(staleProbeRows.length > 0 ? staleProbeRows : ['| _none_ | _none_ | current | 1.000 |']),
      '',
    ].join('\n');
    writeFileSync(summaryPath, summary, { encoding: 'utf8', flag: 'a' });
  }

  if (failed) {
    console.error(
      JSON.stringify(
        {
          check: 'tcb-admission-failed',
          reconciliation,
          unsound_properties: reports
            .filter(
              (property) =>
                property.require_sound_symbol_closure && property.symbol_closure_status !== 'sound',
            )
            .map((property) => property.id),
        },
        null,
        2,
      ),
    );
  }
  console.log(JSON.stringify(finalReport, null, 2));

  if (failed) {
    throw new Error('TCB_ADMISSION_FAILED');
  }
} finally {
  snapshot.dispose();
  api.close();
}
