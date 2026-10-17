import { v } from "convex/values";

/**
 * Phase 3A — Batch A3: access reviews and recertification foundation.
 * ==================================================================
 * Single source of truth for the review-cycle, decision and remediation
 * vocabularies. Imported by the Convex schema/validators AND by the
 * Administration UI so the two can never drift apart.
 *
 * Deliberately NOT included here: any role or membership-status write path.
 * Remediation records a RECOMMENDATION; the only way a recommendation becomes
 * an implemented action is the existing authorized mutations
 * (`admin.changeMemberRole`, `admin.setMembershipStatus`).
 */

/** Cycle lifecycle. "in_progress" covers open + overdue (due date derived). */
export const ACCESS_REVIEW_CYCLE_STATUSES = [
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type AccessReviewCycleStatus =
  (typeof ACCESS_REVIEW_CYCLE_STATUSES)[number];

export const ACCESS_REVIEW_CYCLE_STATUS_LABELS: Record<
  AccessReviewCycleStatus,
  string
> = {
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const ACCESS_REVIEW_DECISIONS = [
  "access_confirmed",
  "remediation_required",
  "exception_pending",
] as const;
export type AccessReviewDecision = (typeof ACCESS_REVIEW_DECISIONS)[number];

export const ACCESS_REVIEW_DECISION_LABELS: Record<
  AccessReviewDecision,
  string
> = {
  access_confirmed: "Access confirmed",
  remediation_required: "Remediation required",
  exception_pending: "Exception requiring follow-up",
};

/**
 * Recommendations are recorded separately from completed remediation. They
 * point AT existing authorized operations — they never change access
 * themselves.
 */
export const ACCESS_REVIEW_RECOMMENDATIONS = [
  "change_role",
  "suspend_membership",
  "deactivate_membership",
] as const;
export type AccessReviewRecommendation =
  (typeof ACCESS_REVIEW_RECOMMENDATIONS)[number];

export const ACCESS_REVIEW_RECOMMENDATION_LABELS: Record<
  AccessReviewRecommendation,
  string
> = {
  change_role: "Change role to",
  suspend_membership: "Suspend membership",
  deactivate_membership: "Deactivate membership",
};

export const ACCESS_REVIEW_REMEDIATION_STATUSES = [
  "proposed",
  "applied",
  "withdrawn",
] as const;
export type AccessReviewRemediationStatus =
  (typeof ACCESS_REVIEW_REMEDIATION_STATUSES)[number];

export const ACCESS_REVIEW_REMEDIATION_STATUS_LABELS: Record<
  AccessReviewRemediationStatus,
  string
> = {
  proposed: "Recommended — not applied",
  applied: "Applied",
  withdrawn: "Withdrawn",
};

// ---------------------------------------------------------------------------
// Convex validators (shared by schema + function args)
// ---------------------------------------------------------------------------

export const accessReviewCycleStatusValidator = v.union(
  ...ACCESS_REVIEW_CYCLE_STATUSES.map((s) => v.literal(s)),
);
export const accessReviewDecisionValidator = v.union(
  ...ACCESS_REVIEW_DECISIONS.map((d) => v.literal(d)),
);
export const accessReviewRecommendationValidator = v.union(
  ...ACCESS_REVIEW_RECOMMENDATIONS.map((r) => v.literal(r)),
);
export const accessReviewRemediationStatusValidator = v.union(
  ...ACCESS_REVIEW_REMEDIATION_STATUSES.map((s) => v.literal(s)),
);

/** Max characters for a review note (kept small: notes are evidence, not files). */
export const ACCESS_REVIEW_NOTE_MAX = 2000;
/** Max cycle title length. */
export const ACCESS_REVIEW_TITLE_MAX = 120;
/**
 * Snapshot capture PAGE SIZE (profiles scanned per call). Capture is
 * resumable: callers repeat until the scan reports completion, so there is no
 * organization-size cap — only a bounded amount of work per transaction.
 */
export const ACCESS_REVIEW_CAPTURE_PAGE_SIZE = 200;

/** A cycle is overdue when its due date passed while still in progress. */
export function isCycleOverdue(
  status: AccessReviewCycleStatus,
  dueAt: number,
  now: number = Date.now(),
): boolean {
  return status === "in_progress" && dueAt < now;
}

/** Whole-day distance between now and the due date (negative = past due). */
export function daysUntilDue(dueAt: number, now: number = Date.now()): number {
  return Math.ceil((dueAt - now) / (24 * 60 * 60 * 1000));
}
