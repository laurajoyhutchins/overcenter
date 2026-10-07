import {
  createPrinter,
  EmitHint,
  NewLineKind,
  type Node,
  type SourceFile,
} from 'typescript';

export interface SemanticSpan {
  start_offset: number;
  end_offset: number;
  semantic_loc: number;
}

const printer = createPrinter({
  newLine: NewLineKind.LineFeed,
  removeComments: true,
});

function renderedSemanticLoc(rendered: string): number {
  return rendered.split('\n').filter((line) => line.trim().length > 0).length;
}

export function canonicalSemanticLoc(node: Node, source: SourceFile): number {
  const rendered =
    node === source
      ? printer.printFile(source)
      : printer.printNode(EmitHint.Unspecified, node, source);
  return renderedSemanticLoc(rendered);
}

export function maximalSemanticSpans<T extends SemanticSpan>(spans: readonly T[]): T[] {
  const sorted = [...spans].sort(
    (left, right) =>
      left.start_offset - right.start_offset || right.end_offset - left.end_offset,
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

    if (
      previous.start_offset === span.start_offset &&
      previous.end_offset === span.end_offset
    ) {
      if (previous.semantic_loc !== span.semantic_loc) {
        throw new Error('TCB_SEMANTIC_SPAN_CONFLICT');
      }
      continue;
    }

    if (
      previous.start_offset <= span.start_offset &&
      previous.end_offset >= span.end_offset
    ) {
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
