import {
  SyntaxKind,
  isImportDeclaration,
  isInterfaceDeclaration,
  isTypeAliasDeclaration,
  type Node,
} from 'typescript/unstable/ast';

export interface SemanticSpan {
  start_offset: number;
  end_offset: number;
  semantic_loc: number;
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

function isTypeOnlyDeclaration(node: Node): boolean {
  if (isInterfaceDeclaration(node) || isTypeAliasDeclaration(node) || isTypeOnlySpecifier(node)) {
    return true;
  }
  if (isImportDeclaration(node) && node.importClause?.phaseModifier === SyntaxKind.TypeKeyword) {
    return true;
  }
  return (
    node.kind === SyntaxKind.ExportDeclaration &&
    (node as Node & { isTypeOnly?: boolean }).isTypeOnly === true
  );
}

function isLogicalSourceLine(node: Node): boolean {
  if (node.kind >= SyntaxKind.FirstStatement && node.kind <= SyntaxKind.LastStatement) return true;

  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.ModuleDeclaration:
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.ExportAssignment:
    case SyntaxKind.ExportDeclaration:
    case SyntaxKind.Constructor:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.ClassStaticBlockDeclaration:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ShorthandPropertyAssignment:
    case SyntaxKind.SpreadAssignment:
      return true;
    default:
      return false;
  }
}

export function logicalSemanticLoc(node: Node): number {
  let semanticLoc = 0;

  const visit = (current: Node): void => {
    if (isTypeSpaceNode(current) || isTypeOnlyDeclaration(current)) return;
    if (isLogicalSourceLine(current)) semanticLoc += 1;
    current.forEachChild(visit);
  };

  visit(node);
  return semanticLoc;
}

export function maximalSemanticSpans<T extends SemanticSpan>(spans: readonly T[]): T[] {
  const sorted = [...spans].sort(
    (left, right) => left.start_offset - right.start_offset || right.end_offset - left.end_offset,
  );
  const maximal: T[] = [];

  for (const span of sorted) {
    if (
      span.start_offset < 0 ||
      span.end_offset <= span.start_offset ||
      !Number.isInteger(span.semantic_loc) ||
      span.semantic_loc < 0
    ) {
      throw new Error('TCB_SEMANTIC_SPAN_INVALID');
    }

    const previous = maximal.at(-1);
    if (!previous) {
      maximal.push(span);
      continue;
    }

    if (previous.start_offset === span.start_offset && previous.end_offset === span.end_offset) {
      if (previous.semantic_loc !== span.semantic_loc) {
        throw new Error('TCB_SEMANTIC_SPAN_CONFLICT');
      }
      continue;
    }

    if (previous.start_offset <= span.start_offset && previous.end_offset >= span.end_offset) {
      continue;
    }

    if (span.start_offset < previous.end_offset) {
      throw new Error('TCB_SEMANTIC_SPANS_OVERLAP');
    }

    maximal.push(span);
  }

  return maximal;
}

export function maximalSemanticLoc(spans: readonly SemanticSpan[]): number {
  return maximalSemanticSpans(spans).reduce((sum, span) => sum + span.semantic_loc, 0);
}
