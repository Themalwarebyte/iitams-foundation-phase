import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { severityValidator } from "./schema";
import {
  requirePermission,
  requireEngagementAccess,
  logAudit,
  notify,
} from "./auditAccess";
import {
  ACTION_LABELS,
  FINDING_LABELS,
  findingTransitionAllowed,
  isActionOverdue,
  type ActionStatus,
  type FindingStatus,
} from "../lib/auditWorkflow";

/**
 * Modules 8 + 9 — Findings Management and Corrective Action tracking.
 * Findings follow the six-stage lifecycle identified → draft → reviewed →
 * management_response → corrective_action → closed, guarded by the
 * transition state machine and audit-team roles. Corrective actions carry
 * their own Open → In Progress → Completed → Verified → Closed lifecycle
 * with overdue detection and reminders.
 */

// ---------------------------------------------------------------------------
// Findings (Module 8)
// ---------------------------------------------------------------------------

export const list = query({
  args: {
    search: v.optional(v.string()),
    severity: v.optional(severityValidator),
    status: v.optional(v.string()),
    engagementId: v.optional(v.id("auditEngagements")),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.view");
    if (!access.organizationId) return [];
    let rows = await ctx.db
      .query("findings")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId!),
      )
      .collect();
    if (args.severity) rows = rows.filter((r) => r.severity === args.severity);
    if (args.status) rows = rows.filter((r) => r.status === args.status);
    if (args.engagementId)
      rows = rows.filter((r) => r.engagementId === args.engagementId);
    if (args.search) {
      const q = args.search.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.code.toLowerCase().includes(q) ||
          (r.description ?? "").toLowerCase().includes(q) ||
          (r.ownerName ?? "").toLowerCase().includes(q),
      );
    }
    const severityRank: Record<string, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
      informational: 4,
    };
    return rows.sort(
      (a, b) =>
        (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9) ||
        b.createdAt - a.createdAt,
    );
  },
});

export const get = query({
  args: { id: v.id("findings") },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.view");
    if (!access.organizationId) return null;
    const finding = await ctx.db.get(args.id);
    if (!finding || finding.organizationId !== access.organizationId) return null;
    return finding;
  },
});

/** Create a finding on an engagement (assigned team members only). */
export const create = mutation({
  args: {
    engagementId: v.id("auditEngagements"),
    title: v.string(),
    description: v.optional(v.string()),
    condition: v.optional(v.string()),
    criteria: v.optional(v.string()),
    rootCause: v.optional(v.string()),
    impact: v.optional(v.string()),
    recommendation: v.optional(v.string()),
    severity: severityValidator,
    riskRating: v.optional(v.number()),
    ownerName: v.optional(v.string()),
    dueDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const ea = await requireEngagementAccess(ctx, args.engagementId);
    if (!ea.canWork) {
      throw new Error("Only assigned users can raise findings");
    }

    const siblings = await ctx.db
      .query("findings")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", ea.access.organizationId!),
      )
      .collect();
    const seq =
      siblings.filter((f) => f.code.startsWith("F-")).length + 1;
    const code = `F-${String(seq).padStart(3, "0")}`;
    const now = Date.now();

    const id = await ctx.db.insert("findings", {
      organizationId: ea.access.organizationId!,
      engagementId: args.engagementId,
      code,
      title: args.title,
      description: args.description,
      severity: args.severity,
      status: "identified",
      ownerName: args.ownerName,
      dueDate: args.dueDate,
      isOverdue: false,
      condition: args.condition,
      criteria: args.criteria,
      rootCause: args.rootCause,
      impact: args.impact,
      recommendation: args.recommendation,
      riskRating: args.riskRating,
      createdById: ea.access.user?._id,
      createdAt: now,
      updatedAt: now,
    });

    await logAudit(ctx, {
      organizationId: ea.access.organizationId!,
      userId: ea.access.user?._id,
      actorLabel: ea.access.user?.name ?? undefined,
      action: "finding.created",
      entityType: "findings",
      entityId: id,
      summary: `${code} ${args.title} (${args.severity}) on ${ea.engagement.code}`,
    });

    // Critical/high findings immediately alert the organization.
    if (args.severity === "critical" || args.severity === "high") {
      await notify(ctx, {
        organizationId: ea.access.organizationId!,
        title: `${args.severity === "critical" ? "Critical" : "High"} finding identified`,
        body: `${code} ${args.title} was identified on ${ea.engagement.code}.`,
        severity: args.severity === "critical" ? "critical" : "warning",
        href: "/audit/findings",
      });
    }

    return { id, code };
  },
});

/** Update finding content (draft stages only; approved content is frozen). */
export const update = mutation({
  args: {
    id: v.id("findings"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    condition: v.optional(v.string()),
    criteria: v.optional(v.string()),
    rootCause: v.optional(v.string()),
    impact: v.optional(v.string()),
    recommendation: v.optional(v.string()),
    severity: v.optional(severityValidator),
    riskRating: v.optional(v.number()),
    ownerName: v.optional(v.string()),
    dueDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.manage");
    if (!access.organizationId) throw new Error("No organization context");
    const finding = await ctx.db.get(args.id);
    if (!finding || finding.organizationId !== access.organizationId) {
      throw new Error("Finding not found");
    }
    if (finding.status === "closed") {
      throw new Error("Closed findings are immutable");
    }

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const key of [
      "title",
      "description",
      "condition",
      "criteria",
      "rootCause",
      "impact",
      "recommendation",
      "severity",
      "riskRating",
      "ownerName",
      "dueDate",
    ] as const) {
      if (args[key] !== undefined) patch[key] = args[key];
    }
    await ctx.db.patch(args.id, patch);

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? undefined,
      action: "finding.updated",
      entityType: "findings",
      entityId: args.id,
      summary: `${finding.code} ${patch.title ?? finding.title} updated`,
    });
    return { ok: true };
  },
});

/**
 * Record the management response (moves reviewed → management_response).
 * Management users respond; audit managers may also record on their behalf.
 */
export const recordManagementResponse = mutation({
  args: {
    id: v.id("findings"),
    response: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.view");
    if (!access.organizationId) throw new Error("No organization context");
    const finding = await ctx.db.get(args.id);
    if (!finding || finding.organizationId !== access.organizationId) {
      throw new Error("Finding not found");
    }

    const status = finding.status as FindingStatus;
    if (status !== "reviewed") {
      throw new Error(
        `Management response is recorded after review (current: ${FINDING_LABELS[status] ?? status})`,
      );
    }
    // Management response authority: platform admin, audit roles with
    // manage permission, or the dedicated management_user role.
    const mayRespond =
      access.role === "admin" ||
      access.role === "management_user" ||
      access.role === "audit_manager" ||
      access.role === "audit_director" ||
      roleHasManage(access.role);
    if (!mayRespond) {
      throw new Error("Only management roles may record the management response");
    }

    await ctx.db.patch(args.id, {
      managementResponse: args.response,
      status: "management_response",
      updatedAt: Date.now(),
    });

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? undefined,
      action: "finding.management_response_recorded",
      entityType: "findings",
      entityId: args.id,
      summary: `${finding.code} management response recorded`,
    });

    return { ok: true };
  },
});

/** Platform roles with audit.manage that may also respond. */
function roleHasManage(role: string | undefined): boolean {
  return role === "admin" || role === "user" || role === "audit_manager" ||
    role === "audit_director";
}

/**
 * Finding lifecycle transition with role guard (auditWorkflow matrix).
 */
export const transition = mutation({
  args: {
    id: v.id("findings"),
    to: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.view");
    if (!access.organizationId) throw new Error("No organization context");
    const finding = await ctx.db.get(args.id);
    if (!finding || finding.organizationId !== access.organizationId) {
      throw new Error("Finding not found");
    }

    const from = finding.status as FindingStatus;
    const to = args.to as FindingStatus;

    // Engagement-scoped role resolution when the finding sits on an
    // engagement; platform role governs org-wide findings.
    let teamRole: import("../lib/auditWorkflow").AuditTeamRole | undefined;
    if (finding.engagementId && access.user) {
      const assignment = await ctx.db
        .query("auditAssignments")
        .withIndex("by_engagement", (q) =>
          q.eq("engagementId", finding.engagementId!),
        )
        .filter((q) => q.eq(q.field("userId"), access.user!._id))
        .first();
      teamRole = assignment?.teamRole;
    }
    const platformPrivileged =
      access.role === "admin" ||
      access.role === "user" ||
      access.role === "audit_manager" ||
      access.role === "audit_director";

    if (!findingTransitionAllowed(from, to, teamRole) && !platformPrivileged) {
      throw new Error(
        `Not authorized to move this finding from ${FINDING_LABELS[from] ?? from} to ${FINDING_LABELS[to] ?? to}`,
      );
    }

    await ctx.db.patch(args.id, {
      status: to,
      updatedAt: Date.now(),
    });

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? undefined,
      action: "finding.status_changed",
      entityType: "findings",
      entityId: args.id,
      summary: `${finding.code} ${finding.title}: ${FINDING_LABELS[from] ?? from} → ${FINDING_LABELS[to] ?? to}`,
    });

    return { ok: true, from, to };
  },
});

// ---------------------------------------------------------------------------
// Corrective actions (Module 9)
// ---------------------------------------------------------------------------

export const listActions = query({
  args: {
    search: v.optional(v.string()),
    status: v.optional(v.string()),
    findingId: v.optional(v.id("findings")),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.view");
    if (!access.organizationId) return [];
    let rows = await ctx.db
      .query("correctiveActions")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId!),
      )
      .collect();
    if (args.status) rows = rows.filter((r) => r.status === args.status);
    if (args.findingId)
      rows = rows.filter((r) => r.findingId === args.findingId);
    if (args.search) {
      const q = args.search.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          (r.ownerName ?? "").toLowerCase().includes(q) ||
          (r.responsiblePerson ?? "").toLowerCase().includes(q),
      );
    }
    const now = Date.now();
    return rows
      .map((r) => ({
        ...r,
        computedOverdue: isActionOverdue(
          r.status as ActionStatus,
          r.dueDate,
          now,
        ),
      }))
      .sort((a, b) => {
        if (a.computedOverdue !== b.computedOverdue)
          return a.computedOverdue ? -1 : 1;
        return (a.dueDate ?? Infinity) - (b.dueDate ?? Infinity);
      });
  },
});

/** Create a corrective action for a finding (management/audit roles). */
export const createAction = mutation({
  args: {
    findingId: v.id("findings"),
    title: v.string(),
    description: v.optional(v.string()),
    responsiblePerson: v.optional(v.string()),
    responsiblePersonId: v.optional(v.id("users")),
    dueDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.manage");
    if (!access.organizationId) throw new Error("No organization context");
    const finding = await ctx.db.get(args.findingId);
    if (!finding || finding.organizationId !== access.organizationId) {
      throw new Error("Finding not found");
    }

    const now = Date.now();
    const id = await ctx.db.insert("correctiveActions", {
      organizationId: access.organizationId,
      findingId: args.findingId,
      title: args.title,
      description: args.description,
      status: "open",
      ownerName: finding.ownerName,
      responsiblePerson: args.responsiblePerson,
      responsiblePersonId: args.responsiblePersonId,
      dueDate: args.dueDate,
      createdAt: now,
      updatedAt: now,
    });

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? undefined,
      action: "corrective_action.created",
      entityType: "correctiveActions",
      entityId: id,
      summary: `${args.title} for ${finding.code}`,
    });

    // Notify the responsible person when known.
    if (args.responsiblePersonId) {
      await notify(ctx, {
        organizationId: access.organizationId,
        userId: args.responsiblePersonId,
        title: "Corrective action assigned",
        body: `${args.title} (from finding ${finding.code}) is due ${args.dueDate ? new Date(args.dueDate).toLocaleDateString() : "without a due date"}.`,
        severity: "info",
        href: "/audit/corrective-actions",
      });
    }

    return { id };
  },
});

export const updateAction = mutation({
  args: {
    id: v.id("correctiveActions"),
    status: v.optional(v.string()),
    completionEvidence: v.optional(v.string()),
    dueDate: v.optional(v.number()),
    responsiblePerson: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.manage");
    if (!access.organizationId) throw new Error("No organization context");
    const action = await ctx.db.get(args.id);
    if (!action || action.organizationId !== access.organizationId) {
      throw new Error("Corrective action not found");
    }

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const key of [
      "status",
      "completionEvidence",
      "dueDate",
      "responsiblePerson",
    ] as const) {
      if (args[key] !== undefined) patch[key] = args[key];
    }
    await ctx.db.patch(args.id, patch);

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? undefined,
      action: "corrective_action.updated",
      entityType: "correctiveActions",
      entityId: args.id,
      summary: `${action.title}${args.status ? ` → ${args.status}` : ""}`,
    });
    return { ok: true };
  },
});

/**
 * Verify a completed action (completed → verified). Verification authority:
 * audit manager / director / platform admin — the same tier that reviews
 * working papers.
 */
export const verifyAction = mutation({
  args: { id: v.id("correctiveActions") },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.manage");
    if (!access.organizationId) throw new Error("No organization context");
    const action = await ctx.db.get(args.id);
    if (!action || action.organizationId !== access.organizationId) {
      throw new Error("Corrective action not found");
    }
    const status = action.status as ActionStatus;
    if (status !== "completed") {
      throw new Error(
        `Only completed actions can be verified (current: ${ACTION_LABELS[status] ?? status})`,
      );
    }

    await ctx.db.patch(args.id, {
      status: "verified",
      verifiedById: access.user?._id,
      verifiedByName: access.user?.name ?? access.user?.email ?? undefined,
      verifiedAt: Date.now(),
      updatedAt: Date.now(),
    });

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? undefined,
      action: "corrective_action.verified",
      entityType: "correctiveActions",
      entityId: args.id,
      summary: `${action.title} verified by ${access.user?.name ?? "auditor"}`,
    });

    return { ok: true };
  },
});

/**
 * Send reminders for open/in-progress actions that are near or past due.
 * Returns the number of reminders sent; marks an overdue state and records
 * lastReminderAt so callers can rate-limit (max once per 7 days).
 */
export const sendOverdueReminders = mutation({
  args: {},
  handler: async (ctx) => {
    const access = await requirePermission(ctx, "audit.manage");
    if (!access.organizationId) throw new Error("No organization context");

    const now = Date.now();
    const WEEK = 7 * 24 * 60 * 60 * 1000;
    const rows = await ctx.db
      .query("correctiveActions")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId!),
      )
      .collect();

    let sent = 0;
    for (const a of rows) {
      const status = a.status as ActionStatus;
      if (status === "completed" || status === "verified" || status === "closed")
        continue;
      if (a.dueDate === undefined) continue;
      if (!isActionOverdue(status, a.dueDate, now)) continue;
      if (a.lastReminderAt !== undefined && now - a.lastReminderAt < WEEK)
        continue;

      await ctx.db.patch(a._id, {
        status: status === "overdue" ? status : "overdue",
        lastReminderAt: now,
        updatedAt: now,
      });
      await notify(ctx, {
        organizationId: access.organizationId,
        userId: a.responsiblePersonId,
        title: "Corrective action overdue",
        body: `${a.title} passed its due date on ${new Date(a.dueDate).toLocaleDateString()}.`,
        severity: "warning",
        href: "/audit/corrective-actions",
      });
      await logAudit(ctx, {
        organizationId: access.organizationId,
        userId: access.user?._id,
        actorLabel: access.user?.name ?? undefined,
        action: "corrective_action.reminder_sent",
        entityType: "correctiveActions",
        entityId: a._id,
        summary: `Overdue reminder for ${a.title}`,
      });
      sent += 1;
    }
    return { sent };
  },
});
