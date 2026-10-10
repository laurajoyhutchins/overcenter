export type ApprovalJobResult = "success" | "failure" | "cancelled" | "skipped" | "unknown";

export type ApprovalDecision = "approved" | "rejected" | "unreviewed" | "unauthorized" | "unavailable";

export type ApprovalOutcome =
  | "approved_no_side_effect_canary"
  | "rejected_no_side_effect_canary"
  | "approved_canary_did_not_settle"
  | "reviewer_not_authorized"
  | "cancelled_without_review"
  | "approval_not_settled"
  | "approval_not_recorded"
  | "approval_evidence_unavailable";

export interface EnvironmentApproval {
  state?: unknown;
  comment?: unknown;
  user?: { login?: unknown };
  environments?: Array<{ name?: unknown }>;
}

export interface ApprovalReceipt {
  review_state: ApprovalDecision;
  reviewed_by: string | null;
  review_comment: string | null;
  outcome: ApprovalOutcome;
}

export function classifyCanaryApproval(input: {
  gateJobResult: ApprovalJobResult;
  evidenceAvailable: boolean;
  approvals: EnvironmentApproval[];
  environmentName: string;
  expectedReviewer: string;
}): ApprovalReceipt {
  if (!input.evidenceAvailable) {
    return {
      review_state: "unavailable",
      reviewed_by: null,
      review_comment: null,
      outcome: "approval_evidence_unavailable",
    };
  }

  const records = input.approvals.filter((approval) =>
    approval.environments?.some((environment) => environment.name === input.environmentName),
  );
  const latest = records.at(-1);
  const state = latest?.state;
  const reviewer = typeof latest?.user?.login === "string" ? latest.user.login : null;
  const comment = typeof latest?.comment === "string" ? latest.comment : null;
  const decision = state === "approved" || state === "rejected" ? state : null;

  if (decision !== null && reviewer !== input.expectedReviewer) {
    return {
      review_state: "unauthorized",
      reviewed_by: reviewer,
      review_comment: comment,
      outcome: "reviewer_not_authorized",
    };
  }

  if (decision === "rejected") {
    return {
      review_state: "rejected",
      reviewed_by: reviewer,
      review_comment: comment,
      outcome: "rejected_no_side_effect_canary",
    };
  }

  if (decision === "approved") {
    return {
      review_state: "approved",
      reviewed_by: reviewer,
      review_comment: comment,
      outcome:
        input.gateJobResult === "success"
          ? "approved_no_side_effect_canary"
          : "approved_canary_did_not_settle",
    };
  }

  const outcome: ApprovalOutcome =
    input.gateJobResult === "cancelled"
      ? "cancelled_without_review"
      : input.gateJobResult === "failure"
        ? "approval_not_settled"
        : "approval_not_recorded";

  return {
    review_state: "unreviewed",
    reviewed_by: null,
    review_comment: null,
    outcome,
  };
}
