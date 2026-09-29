import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { auditTeamRoleValidator } from "./schema";
import {
  requirePermission,
  requireEngagementAccess,
  logAudit,
  notify,
  userLabel,
} from "./auditAccess";
import {
  AUDIT_TEAM_ROLES,
  AUDIT_TEAM_ROLE_LABELS,
  ENGAGEMENT_LABELS,
  canTransitionEngagement,
  engagementTransitionAllowed,
  type EngagementStatus,
  type AuditTeamRole,
} from "../lib/auditWorkflow";

/**
 * Modules 3 + 4 — Audit Engagement Management & Team Assignment.
 * The seven-stage lifecycle (draft → planning → approved → fieldwork →
 * review → report_issued → closed) is guarded server-side:
 *   - transitions must be legal edges in the state machine; and
 *   - the caller must hold the required audit-team role (assignment-checked,
 *     see auditAccess.requireEngagementAccess); and
 *   - the engagement must belong to the caller's organization.
 * Every transition, creation and assignment is written to the audit log.
 */

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const list = query({
  args: {
    search: v.optional(v.string()),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.view");
    if (!access.organizationId) return [];
    let rows = await ctx.db
      .query("auditEngagements")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId!),
      )
      .collect();
    if (args.status) rows = rows.filter((r) => r.status === args.status);
    if (args.search) {
      const q = args.search.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q),
      );
    }
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const get = query({
  args: { id: v.id("auditEngagements") },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.view");
    if (!access.organizationId) return null;
    const engagement = await ctx.db.get(args.id);
    if (!engagement || engagement.organizationId !== access.organizationId)
      return null;
    return engagement;
  },
});

/** My engagements — assignments for the current user (Module 4 "My Work"). */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const access = await requirePermission(ctx, "audit.view");
    if (!access.organizationId || !access.user) return [];
    const assignments = await ctx.db
      .query("auditAssignments")
      .withIndex("by_user", (q) => q.eq("userId", access.user!._id))
      .collect();
    const mine = assignments.filter(
      (a) => a.organizationId === access.organizationId,
    );
    const engagements = await Promise.all(
      mine.map((a) => ctx.db.get(a.engagementId)),
    );
    return mine
      .map((a, i) => {
        const e = engagements[i];
        return e && e.organizationId === access.organizationId
          ? { assignment: a, engagement: e }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  },
});

/** The caller's role on one engagement (drives UI action availability). */
export const myEngagementRole = query({
  args: { engagementId: v.id("auditEngagements") },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.view");
    if (!access.organizationId || !access.user) return null;
    const engagement = await ctx.db.get(args.engagementId);
    if (!engagement || engagement.organizationId !== access.organizationId)
      return null;
    const assignment = await ctx.db
      .query("auditAssignments")
      .withIndex("by_engagement", (q) => q.eq("engagementId", args.engagementId))
      .filter((q) => q.eq(q.field("userId"), access.user!._id))
      .first();
    const platformPrivileged = access.role === "admin";
    return {
      teamRole: assignment?.teamRole ?? null,
      isManagerLike:
        platformPrivileged ||
        assignment?.teamRole === "audit_manager" ||
        assignment?.teamRole === "audit_director",
      canWork: platformPrivileged || assignment !== undefined,
    };
  },
});

/** Team roster for an engagement (assigned users only may view). */
export const listTeam = query({
  args: { engagementId: v.id("auditEngagements") },
  handler: async (ctx, args) => {
    const ea = await requireEngagementAccess(ctx, args.engagementId);
    if (!ea.canWork) throw new Error("Only assigned users can view the team");
    const rows = await ctx.db
      .query("auditAssignments")
      .withIndex("by_engagement", (q) => q.eq("engagementId", args.engagementId))
      .collect();
    return Promise.all(
      rows.map(async (a) => ({
        ...a,
        userName: (await userLabel(ctx, a.userId)) ?? "Unknown user",
      })),
    );
  },
});

/**
 * Directory of provisioned users in the caller's organization (for team
 * assignment pickers). Requires audit.manage; org-scoped via the profile
 * organizationId index so other tenants' users are never read.
 */
export const listOrgUsers = query({
  args: {},
  handler: async (ctx) => {
    const access = await requirePermission(ctx, "audit.manage");
    if (!access.organizationId) return [];
    const profiles = await ctx.db
      .query("userProfiles")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId!),
      )
      .collect();
    const seen = new Set<string>();
    const out: { userId: string; label: string; jobTitle: string | null }[] = [];
    for (const p of profiles) {
      if (seen.has(p.userId)) continue;
      seen.add(p.userId);
      const u = await ctx.db.get(p.userId);
      if (!u) continue;
      out.push({
        userId: u._id,
        label: u.name ?? u.email ?? "Unnamed user",
        jobTitle: p.jobTitle ?? null,
      });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  },
});

// ---------------------------------------------------------------------------
// Mutations — engagement lifecycle
// ---------------------------------------------------------------------------

export const create = mutation({
  args: {
    title: v.string(),
    planId: v.optional(v.id("auditPlans")),
    universeItemId: v.optional(v.id("auditUniverseItems")),
    objective: v.optional(v.string()),
    scope: v.optional(v.string()),
    criteria: v.optional(v.string()),
    startDate: v.optional(v.number()),
    targetEndDate: v.optional(v.number()),
    auditManagerId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.manage");
    if (!access.organizationId) throw new Error("No organization context");

    // Validate referenced plan/universe item belong to the same tenant.
    if (args.planId) {
      const plan = await ctx.db.get(args.planId);
      if (!plan || plan.organizationId !== access.organizationId) {
        throw new Error("Audit plan not found in your organization");
      }
    }
    if (args.universeItemId) {
      const item = await ctx.db.get(args.universeItemId);
      if (!item || item.organizationId !== access.organizationId) {
        throw new Error("Audit universe item not found in your organization");
      }
    }

    const year = new Date().getFullYear();
    const existing = await ctx.db
      .query("auditEngagements")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId!),
      )
      .collect();
    const seq = existing.filter((e) => e.code.includes(`-${year}-`)).length + 1;
    const code = `ENG-${year}-${String(seq).padStart(3, "0")}`;
    const now = Date.now();

    const id = await ctx.db.insert("auditEngagements", {
      organizationId: access.organizationId,
      code,
      name: args.title,
      planId: args.planId,
      universeItemId: args.universeItemId,
      status: "draft",
      progressPct: 0,
      leadAuditorId: undefined,
      auditManagerId: args.auditManagerId,
      auditManagerName: await userLabel(ctx, args.auditManagerId),
      objective: args.objective,
      scope: args.scope,
      criteria: args.criteria,
      startDate: args.startDate,
      targetEndDate: args.targetEndDate,
      createdById: access.user?._id,
      createdAt: now,
      updatedAt: now,
    });

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? access.user?.email ?? undefined,
      action: "engagement.created",
      entityType: "auditEngagements",
      entityId: id,
      summary: `${code} ${args.title} created (draft)`,
    });

    return { id, code };
  },
});

/**
 * Move an engagement between lifecycle stages. Guards: legal transition +
 * authorized team role + same-tenant engagement. Progress percentage is
 * derived from the stage for the dashboard.
 */
export const transition = mutation({
  args: {
    id: v.id("auditEngagements"),
    to: v.string(),
  },
  handler: async (ctx, args) => {
    const ea = await requireEngagementAccess(ctx, args.id);
    const from = ea.engagement.status as EngagementStatus;
    const to = args.to as EngagementStatus;

    if (!canTransitionEngagement(from, to)) {
      throw new Error(
        `Illegal engagement transition: ${ENGAGEMENT_LABELS[from]} → ${ENGAGEMENT_LABELS[to] ?? to}`,
      );
    }
    // Per-transition role matrix (engagementTransitionAllowed) is the single
    // authority: manager-like callers pass via their team role, and legal
    // auditor-side edges (e.g. draft→planning for lead_auditor) are honored.
    if (!engagementTransitionAllowed(from, to, ea.teamRole)) {
      throw new Error(
        `Your role (${ea.teamRole ?? "unassigned"}) may not move this engagement from ${ENGAGEMENT_LABELS[from]} to ${ENGAGEMENT_LABELS[to] ?? to}`,
      );
    }

    const stageProgress: Record<string, number> = {
      draft: 5,
      planning: 15,
      approved: 25,
      fieldwork: 55,
      review: 80,
      report_issued: 95,
      closed: 100,
      cancelled: ea.engagement.progressPct,
    };

    await ctx.db.patch(args.id, {
      status: to,
      progressPct: stageProgress[to] ?? ea.engagement.progressPct,
      endDate: to === "closed" ? Date.now() : ea.engagement.endDate,
      updatedAt: Date.now(),
    });

    await logAudit(ctx, {
      organizationId: ea.access.organizationId!,
      userId: ea.access.user?._id,
      actorLabel: ea.access.user?.name ?? ea.access.user?.email ?? undefined,
      action: "engagement.status_changed",
      entityType: "auditEngagements",
      entityId: args.id,
      summary: `${ea.engagement.code} ${ea.engagement.name}: ${ENGAGEMENT_LABELS[from]} → ${ENGAGEMENT_LABELS[to] ?? to}`,
    });

    if (to === "review") {
      await notify(ctx, {
        organizationId: ea.access.organizationId!,
        title: "Engagement ready for review",
        body: `${ea.engagement.code} ${ea.engagement.name} has entered the review stage.`,
        severity: "info",
        href: "/audit/engagements",
      });
    }

    return { ok: true, from, to };
  },
});

// ---------------------------------------------------------------------------
// Mutations — team assignment (Module 4)
// ---------------------------------------------------------------------------

/** Assign a user to the engagement team (manager-like authority required). */
export const assignMember = mutation({
  args: {
    engagementId: v.id("auditEngagements"),
    userId: v.id("users"),
    teamRole: auditTeamRoleValidator,
  },
  handler: async (ctx, args) => {
    const ea = await requireEngagementAccess(ctx, args.engagementId);
    if (!ea.canManageStructure) {
      throw new Error("Only the audit manager or director can assign the team");
    }
    if (!AUDIT_TEAM_ROLES.includes(args.teamRole as AuditTeamRole)) {
      throw new Error("Invalid audit team role");
    }

    // The assigned user must belong to the same organization.
    const targetProfile = await ctx.db
      .query("userProfiles")
      .withIndex("userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (!targetProfile || targetProfile.organizationId !== ea.access.organizationId) {
      throw new Error("User is not provisioned in your organization");
    }

    const duplicate = await ctx.db
      .query("auditAssignments")
      .withIndex("by_engagement", (q) => q.eq("engagementId", args.engagementId))
      .filter((q) => q.eq(q.field("userId"), args.userId))
      .first();
    if (duplicate) {
      await ctx.db.patch(duplicate._id, {
        teamRole: args.teamRole,
        updatedAt: Date.now(),
      });
      await logAudit(ctx, {
        organizationId: ea.access.organizationId!,
        userId: ea.access.user?._id,
        actorLabel: ea.access.user?.name ?? undefined,
        action: "engagement.assignment_updated",
        entityType: "auditAssignments",
        entityId: duplicate._id,
        summary: `${await userLabel(ctx, args.userId)} → ${AUDIT_TEAM_ROLE_LABELS[args.teamRole]} on ${ea.engagement.code}`,
      });
      return { id: duplicate._id, updated: true };
    }

    const now = Date.now();
    const id = await ctx.db.insert("auditAssignments", {
      organizationId: ea.access.organizationId,
      engagementId: args.engagementId,
      userId: args.userId,
      teamRole: args.teamRole,
      assignedById: ea.access.user?._id,
      createdAt: now,
      updatedAt: now,
    });

    await logAudit(ctx, {
      organizationId: ea.access.organizationId!,
      userId: ea.access.user?._id,
      actorLabel: ea.access.user?.name ?? undefined,
      action: "engagement.member_assigned",
      entityType: "auditAssignments",
      entityId: id,
      summary: `${await userLabel(ctx, args.userId)} assigned as ${AUDIT_TEAM_ROLE_LABELS[args.teamRole]} on ${ea.engagement.code}`,
    });

    await notify(ctx, {
      organizationId: ea.access.organizationId,
      userId: args.userId,
      title: "Engagement assignment",
      body: `You have been assigned as ${AUDIT_TEAM_ROLE_LABELS[args.teamRole]} on ${ea.engagement.code} ${ea.engagement.name}.`,
      severity: "info",
      href: "/audit/engagements",
    });

    return { id, updated: false };
  },
});

/** Remove a team member (manager-like authority required). */
export const unassignMember = mutation({
  args: { assignmentId: v.id("auditAssignments") },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error("Assignment not found");
    const ea = await requireEngagementAccess(ctx, assignment.engagementId);
    if (!ea.canManageStructure) {
      throw new Error("Only the audit manager or director can remove the team");
    }
    await ctx.db.delete(args.assignmentId);
    await logAudit(ctx, {
      organizationId: ea.access.organizationId!,
      userId: ea.access.user?._id,
      actorLabel: ea.access.user?.name ?? undefined,
      action: "engagement.member_unassigned",
      entityType: "auditAssignments",
      entityId: args.assignmentId,
      summary: `Team member removed from ${ea.engagement.code}`,
    });
    return { ok: true };
  },
});

