import type { CodeWitnessReport } from '../../src/repository/code-witness.ts';

export const CODE_DELETION_PLAN_SCHEMA = 'overcenter-code-deletion-plan/v1' as const;
export const DEFAULT_CODE_DELETION_PLAN_LIMIT = 4;

export interface CodeDeletionPlanItem {
  selector: string;
  path: string;
  symbol: string;
  start_line: number;
  reason_code: 'UNWITNESSED_PRIVATE_SYMBOL';
}

export interface CodeDeletionPlan {
  schema: typeof CODE_DELETION_PLAN_SCHEMA;
  source_revision: string;
  limit: number;
  eligible_findings: number;
  items: CodeDeletionPlanItem[];
}

export function planCodeDeletions(
  report: CodeWitnessReport,
  limit = DEFAULT_CODE_DELETION_PLAN_LIMIT,
): CodeDeletionPlan {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('CODE_DELETION_PLAN_LIMIT_INVALID');
  }
  const eligible = report.findings
    .filter((finding) => finding.code === 'UNWITNESSED_PRIVATE_SYMBOL')
    .map((finding) => ({
      selector: finding.path + '#' + finding.symbol,
      path: finding.path,
      symbol: finding.symbol,
      start_line: finding.start_line,
      reason_code: 'UNWITNESSED_PRIVATE_SYMBOL' as const,
    }))
    .sort((left, right) => {
      const path = left.path.localeCompare(right.path);
      if (path !== 0) return path;
      if (left.start_line !== right.start_line) return left.start_line - right.start_line;
      return left.symbol.localeCompare(right.symbol);
    });
  return {
    schema: CODE_DELETION_PLAN_SCHEMA,
    source_revision: report.source_revision,
    limit,
    eligible_findings: eligible.length,
    items: eligible.slice(0, limit),
  };
}
