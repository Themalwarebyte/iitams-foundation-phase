/**
 * IITAMS audit lifecycle state machines (Phase 2)
 * ===============================================
 * Pure definitions of the Module 3 engagement workflow, Module 6 working
 * paper workflow, Module 8 finding workflow and Module 9 corrective-action
 * workflow. Shared by Convex functions (authoritative transition guards) and
 * the React UI (which disables transitions that would be rejected).
 */

// ---------------------------------------------------------------------------
// Engagement lifecycle (Module 3) — Draft → Planning → Approved → Fieldwork
//   → Review → Report Issued → Closed   (with cancellation)
// ---------------------------------------------------------------------------

export const ENGAGEMENT_STATUSES = [
  "draft",
  "planning",
  "approved",
  "fieldwork",
  "review",
  "report_issued",
  "closed",
  "cancelled",
] as const;

export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

/** Ordered non-terminal stages (used for progress computation). */
export const ENGAGEMENT_ORDER: readonly EngagementStatus[] = [
  "draft",
  "planning",
  "approved",
  "fieldwork",
  "review",
  "report_issued",
  "closed",
];

/** Engagement-status → human label. */
export const ENGAGEMENT_LABELS: Record<EngagementStatus, string> = {
  draft: "Draft",
  planning: "Planning",
  approved: "Approved",
  fieldwork: "Fieldwork",
  review: "Review",
  report_issued: "Report Issued",
  closed: "Closed",
  cancelled: "Cancelled",
};

export const ENGAGEMENT_TRANSITIONS: Record<
  EngagementStatus,
  readonly EngagementStatus[]
> = {
  draft: ["planning", "cancelled"],
  planning: ["approved", "draft", "cancelled"],
  approved: ["fieldwork", "planning", "cancelled"],
  fieldwork: ["review", "approved", "cancelled"],
  review: ["report_issued", "fieldwork"],
  report_issued: ["closed"],
  closed: [],
  cancelled: [],
};

/** Is a status change legal at all (ignoring roles)? */
export function canTransitionEngagement(
  from: EngagementStatus,
  to: EngagementStatus,
): boolean {
  return ENGAGEMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Roles (audit-team roles from Module 4) authorized to perform engagement
 * status transitions. Progression is an auditor-side action; cancellation is
 * a manager-side decision.
 */
export const ENGAGEMENT_TRANSITION_ROLES: Partial<
  Record<`${EngagementStatus}->${EngagementStatus}`, readonly AuditTeamRole[]>
> = {
  "draft->planning": ["audit_manager", "lead_auditor", "audit_director"],
  "planning->approved": ["audit_manager", "audit_director"],
  "approved->fieldwork": ["audit_manager", "lead_auditor", "audit_director"],
  "fieldwork->review": ["lead_auditor", "audit_manager", "audit_director"],
  "review->report_issued": ["audit_manager", "audit_director"],
  "report_issued->closed": ["audit_manager", "audit_director"],
  // Backward moves
  "planning->draft": ["audit_manager", "audit_director"],
  "approved->planning": ["audit_manager", "audit_director"],
  "fieldwork->approved": ["audit_manager", "audit_director"],
  // Cancellation
  "draft->cancelled": ["audit_manager", "audit_director"],
  "planning->cancelled": ["audit_manager", "audit_director"],
  "approved->cancelled": ["audit_manager", "audit_director"],
  "fieldwork->cancelled": ["audit_director"],
};

export function engagementTransitionAllowed(
  from: EngagementStatus,
  to: EngagementStatus,
  teamRole: AuditTeamRole | undefined,
): boolean {
  if (!canTransitionEngagement(from, to)) return false;
  const allowed = ENGAGEMENT_TRANSITION_ROLES[`${from}->${to}`];
  return allowed?.includes(teamRole as AuditTeamRole) ?? false;
}

// ---------------------------------------------------------------------------
// Working paper lifecycle (Module 6) — Draft → Submitted → Reviewed → Approved
//   (with a Return loop from review)
// ---------------------------------------------------------------------------

export const WORKING_PAPER_STATUSES = [
  "draft",
  "submitted",
  "reviewed",
  "returned",
  "approved",
] as const;

export type WorkingPaperStatus = (typeof WORKING_PAPER_STATUSES)[number];

export const WORKING_PAPER_LABELS: Record<WorkingPaperStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  reviewed: "Reviewed",
  returned: "Returned",
  approved: "Approved",
};

export const WORKING_PAPER_TRANSITIONS: Record<
  WorkingPaperStatus,
  readonly WorkingPaperStatus[]
> = {
  draft: ["submitted"],
  submitted: ["reviewed", "returned"],
  reviewed: ["approved"],
  returned: ["submitted"],
  approved: [],
};

/** Roles allowed per transition; "reviewer" covers review/approve/return. */
export const WORKING_PAPER_TRANSITION_ROLES: Partial<
  Record<`${WorkingPaperStatus}->${WorkingPaperStatus}`, readonly AuditTeamRole[]>
> = {
  "draft->submitted": ["auditor", "lead_auditor", "audit_manager"],
  "submitted->reviewed": ["reviewer", "audit_manager", "audit_director"],
  "submitted->returned": ["reviewer", "audit_manager", "audit_director"],
  "reviewed->approved": ["audit_manager", "audit_director"],
  "returned->submitted": ["auditor", "lead_auditor", "audit_manager"],
};

export function workingPaperTransitionAllowed(
  from: WorkingPaperStatus,
  to: WorkingPaperStatus,
  teamRole: AuditTeamRole | undefined,
): boolean {
  if (!WORKING_PAPER_TRANSITIONS[from]?.includes(to)) return false;
  const allowed =
    WORKING_PAPER_TRANSITION_ROLES[`${from}->${to}` as keyof typeof WORKING_PAPER_TRANSITION_ROLES];
  return allowed?.includes(teamRole as AuditTeamRole) ?? false;
}

// ---------------------------------------------------------------------------
// Finding lifecycle (Module 8) — Identified → Draft → Reviewed →
//   Management Response → Corrective Action → Closed
// ---------------------------------------------------------------------------

export const FINDING_STATUSES = [
  "identified",
  "draft",
  "reviewed",
  "management_response",
  "corrective_action",
  "closed",
] as const;

export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const FINDING_LABELS: Record<FindingStatus, string> = {
  identified: "Identified",
  draft: "Draft",
  reviewed: "Reviewed",
  management_response: "Management Response",
  corrective_action: "Corrective Action",
  closed: "Closed",
};

export const FINDING_TRANSITIONS: Record<FindingStatus, readonly FindingStatus[]> = {
  identified: ["draft"],
  draft: ["reviewed", "identified"],
  reviewed: ["management_response", "draft"],
  management_response: ["corrective_action", "reviewed"],
  corrective_action: ["closed", "management_response"],
  closed: [],
};

export const FINDING_TRANSITION_ROLES: Partial<
  Record<`${FindingStatus}->${FindingStatus}`, readonly AuditTeamRole[]>
> = {
  "identified->draft": ["auditor", "lead_auditor", "audit_manager"],
  "draft->reviewed": ["lead_auditor", "audit_manager", "reviewer"],
  "reviewed->management_response": ["audit_manager", "audit_director"],
  "management_response->corrective_action": ["audit_manager", "audit_director"],
  "corrective_action->closed": ["audit_manager", "audit_director"],
  // Revisions
  "draft->identified": ["auditor", "lead_auditor"],
  "reviewed->draft": ["lead_auditor", "audit_manager"],
  "management_response->reviewed": ["audit_manager"],
  "corrective_action->management_response": ["audit_manager"],
};

export function findingTransitionAllowed(
  from: FindingStatus,
  to: FindingStatus,
  teamRole: AuditTeamRole | undefined,
): boolean {
  if (!FINDING_TRANSITIONS[from]?.includes(to)) return false;
  const allowed =
    FINDING_TRANSITION_ROLES[`${from}->${to}` as keyof typeof FINDING_TRANSITION_ROLES];
  return allowed?.includes(teamRole as AuditTeamRole) ?? false;
}

// ---------------------------------------------------------------------------
// Corrective action statuses (Module 9)
// ---------------------------------------------------------------------------

export const ACTION_STATUSES = [
  "open",
  "in_progress",
  "completed",
  "verified",
  "closed",
  "overdue",
] as const;

export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const ACTION_LABELS: Record<ActionStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  completed: "Completed",
  verified: "Verified",
  closed: "Closed",
  overdue: "Overdue",
};

export const ACTION_TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
  open: ["in_progress", "overdue"],
  in_progress: ["completed", "overdue"],
  completed: ["verified"],
  verified: ["closed"],
  closed: [],
  overdue: ["in_progress", "completed"],
};

export function isActionOverdue(
  status: ActionStatus,
  dueDate: number | undefined,
  now: number = Date.now(),
): boolean {
  if (dueDate === undefined) return false;
  // Terminal states are never "overdue" for dashboard purposes.
  if (status === "verified" || status === "closed") return false;
  return dueDate < now;
}

// ---------------------------------------------------------------------------
// Audit team roles (Module 4)
// ---------------------------------------------------------------------------

export const AUDIT_TEAM_ROLES = [
  "audit_director",
  "audit_manager",
  "lead_auditor",
  "auditor",
  "reviewer",
] as const;

export type AuditTeamRole = (typeof AUDIT_TEAM_ROLES)[number];

export const AUDIT_TEAM_ROLE_LABELS: Record<AuditTeamRole, string> = {
  audit_director: "Audit Director",
  audit_manager: "Audit Manager",
  lead_auditor: "Lead Auditor",
  auditor: "Auditor",
  reviewer: "Audit Reviewer",
};

/** Team roles authorized to create/edit engagement child artefacts. */
export function canPerformEngagementWork(role: AuditTeamRole): boolean {
  return role !== undefined; // any assignment grants participation
}

/** Only reviewers and above may review/approve artefacts. */
export function canReviewWork(role: AuditTeamRole): boolean {
  return role === "reviewer" || role === "audit_manager" || role === "audit_director";
}
