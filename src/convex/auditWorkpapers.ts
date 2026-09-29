import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  procedureResultValidator,
  procedureStatusValidator,
  programStatusValidator,
  workingPaperStatusValidator,
} from "./schema";
import {
  requirePermission,
  requireEngagementAccess,
  requireTeamRole,
  logAudit,
  notify,
  userLabel,
} from "./auditAccess";
import {
  WORKING_PAPER_LABELS,
  canReviewWork,
  workingPaperTransitionAllowed,
  type WorkingPaperStatus,
} from "../lib/auditWorkflow";

/**
 * Modules 5 + 6 — Audit Programs/Procedures and Working Papers.
 * Programs hold the engagement's test objectives; each procedure records a
 * Pass / Fail / Exception result with expected evidence. Working papers
 * follow Draft → Submitted → Reviewed/Returned → Approved, with reviewer
 * comments and an approval history. The Module-4 assignment rule is
 * enforced: only engagement-assigned users may create or modify these
 * artefacts, and only reviewer-tier roles may review/approve.
 */

// ---------------------------------------------------------------------------
// Programs & procedures (Module 5)
// ---------------------------------------------------------------------------

/** Programs (with procedure rollup) for an engagement. */
export const listPrograms = query({
  args: { engagementId: v.id("auditEngagements") },
  handler: async (ctx, args) => {
    const ea = await requireEngagementAccess(ctx, args.engagementId);
    if (!ea.canWork) throw new Error("Only assigned users can view programs");

    const programs = await ctx.db
      .query("auditPrograms")
      .withIndex("by_engagement", (q) => q.eq("engagementId", args.engagementId))
      .collect();

    const procedures = await ctx.db
      .query("auditProcedures")
      .withIndex("by_engagement", (q) => q.eq("engagementId", args.engagementId))
      .collect();

    return programs
      .map((p) => {
        const procs = procedures.filter((x) => x.auditProgramId === p._id);
        const completed = procs.filter(
          (x) => x.completionStatus === "completed",
        ).length;
        return {
          ...p,
          procedureCount: procs.length,
          completedCount: completed,
          passCount: procs.filter((x) => x.result === "pass").length,
          failCount: procs.filter((x) => x.result === "fail").length,
          exceptionCount: procs.filter((x) => x.result === "exception").length,
        };
      })
      .sort((a, b) => a.code.localeCompare(b.code));
  },
});

export const getProgram = query({
  args: { programId: v.id("auditPrograms") },
  handler: async (ctx, args) => {
    const program = await ctx.db.get(args.programId);
    if (!program) return null;
    const ea = await requireEngagementAccess(ctx, program.engagementId);
    if (!ea.canWork) throw new Error("Only assigned users can view programs");
    const procedures = await ctx.db
      .query("auditProcedures")
      .withIndex("by_program", (q) => q.eq("auditProgramId", args.programId))
      .collect();
    return { program, procedures };
  },
});

export const createProgram = mutation({
  args: {
    engagementId: v.id("auditEngagements"),
    title: v.string(),
    objective: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const ea = await requireEngagementAccess(
      ctx,
      args.engagementId,
      "audit.view",
    );
    requireTeamRole(ea, ["lead_auditor", "auditor"], "create audit programs");

    const siblings = await ctx.db
      .query("auditPrograms")
      .withIndex("by_engagement", (q) => q.eq("engagementId", args.engagementId))
      .collect();
    const code = `AP-${String(siblings.length + 1).padStart(3, "0")}`;
    const now = Date.now();

    const id = await ctx.db.insert("auditPrograms", {
      organizationId: ea.access.organizationId!,
      engagementId: args.engagementId,
      code,
      title: args.title,
      objective: args.objective,
      status: "draft",
      createdById: ea.access.user?._id,
      createdAt: now,
      updatedAt: now,
    });

    await logAudit(ctx, {
      organizationId: ea.access.organizationId!,
      userId: ea.access.user?._id,
      actorLabel: ea.access.user?.name ?? undefined,
      action: "audit_program.created",
      entityType: "auditPrograms",
      entityId: id,
      summary: `${code} ${args.title} on ${ea.engagement.code}`,
    });

    return { id, code };
  },
});

export const addProcedure = mutation({
  args: {
    auditProgramId: v.id("auditPrograms"),
    procedureName: v.string(),
    description: v.optional(v.string()),
    controlObjective: v.optional(v.string()),
    expectedEvidence: v.optional(v.string()),
    assignedAuditorId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const program = await ctx.db.get(args.auditProgramId);
    if (!program) throw new Error("Audit program not found");
    const ea = await requireEngagementAccess(ctx, program.engagementId);
    requireTeamRole(ea, ["lead_auditor", "auditor"], "add procedures");

    const siblings = await ctx.db
      .query("auditProcedures")
      .withIndex("by_program", (q) =>
        q.eq("auditProgramId", args.auditProgramId),
      )
      .collect();
    const code = `${program.code}.${String(siblings.length + 1).padStart(2, "0")}`;
    const now = Date.now();

    const id = await ctx.db.insert("auditProcedures", {
      organizationId: ea.access.organizationId!,
      auditProgramId: args.auditProgramId,
      engagementId: program.engagementId,
      code,
      procedureName: args.procedureName,
      description: args.description,
      controlObjective: args.controlObjective,
      expectedEvidence: args.expectedEvidence,
      assignedAuditorId: args.assignedAuditorId,
      completionStatus: "not_started",
      createdAt: now,
      updatedAt: now,
    });

    await logAudit(ctx, {
      organizationId: ea.access.organizationId!,
      userId: ea.access.user?._id,
      actorLabel: ea.access.user?.name ?? undefined,
      action: "audit_procedure.created",
      entityType: "auditProcedures",
      entityId: id,
      summary: `${code} ${args.procedureName}`,
    });

    return { id, code };
  },
});

/**
 * Record a procedure result (Pass / Fail / Exception) with notes. Any
 * assigned team member may execute; the assigned auditor is stamped when
 * unset. Failing results notify the engagement's managers.
 */
export const recordProcedureResult = mutation({
  args: {
    procedureId: v.id("auditProcedures"),
    completionStatus: procedureStatusValidator,
    result: v.optional(procedureResultValidator),
    resultNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const procedure = await ctx.db.get(args.procedureId);
    if (!procedure) throw new Error("Procedure not found");
    const ea = await requireEngagementAccess(ctx, procedure.engagementId);
    if (!ea.canWork) {
      throw new Error("Only assigned users can record procedure results");
    }

    await ctx.db.patch(args.procedureId, {
      completionStatus: args.completionStatus,
      result: args.result,
      resultNotes: args.resultNotes,
      assignedAuditorId:
        procedure.assignedAuditorId ?? ea.access.user?._id,
      completedAt:
        args.completionStatus === "completed"
          ? Date.now()
          : procedure.completedAt,
      updatedAt: Date.now(),
    });

    await logAudit(ctx, {
      organizationId: ea.access.organizationId!,
      userId: ea.access.user?._id,
      actorLabel: ea.access.user?.name ?? undefined,
      action: "audit_procedure.result_recorded",
      entityType: "auditProcedures",
      entityId: args.procedureId,
      summary: `${procedure.code} ${procedure.procedureName}: ${args.completionStatus}${args.result ? ` (${args.result})` : ""}`,
    });

    if (args.result === "fail") {
      await notify(ctx, {
        organizationId: ea.access.organizationId!,
        title: "Procedure failed",
        body: `${procedure.code} ${procedure.procedureName} on ${ea.engagement.code} recorded a FAIL result.`,
        severity: "warning",
        href: "/audit/programs",
      });
    }

    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Working papers (Module 6)
// ---------------------------------------------------------------------------

export const listWorkingPapers = query({
  args: { engagementId: v.id("auditEngagements") },
  handler: async (ctx, args) => {
    const ea = await requireEngagementAccess(ctx, args.engagementId);
    if (!ea.canWork)
      throw new Error("Only assigned users can view working papers");
    const rows = await ctx.db
      .query("workingPapers")
      .withIndex("by_engagement", (q) =>
        q.eq("engagementId", args.engagementId),
      )
      .collect();
    return Promise.all(
      rows.map(async (wp) => ({
        ...wp,
        authorName: (await userLabel(ctx, wp.createdById)) ?? "—",
        reviewerName: (await userLabel(ctx, wp.reviewerId)) ?? null,
      })),
    ).then((list) => list.sort((a, b) => a.code.localeCompare(b.code)));
  },
});

export const getWorkingPaper = query({
  args: { id: v.id("workingPapers") },
  handler: async (ctx, args) => {
    const wp = await ctx.db.get(args.id);
    if (!wp) return null;
    const ea = await requireEngagementAccess(ctx, wp.engagementId);
    if (!ea.canWork) throw new Error("Only assigned users can view working papers");
    const comments = await ctx.db
      .query("workingPaperComments")
      .withIndex("by_paper", (q) => q.eq("workingPaperId", args.id))
      .collect();
    return {
      workingPaper: wp,
      comments: comments.sort((a, b) => a.createdAt - b.createdAt),
      viewer: {
        teamRole: ea.teamRole ?? null,
        isManagerLike: ea.isManagerLike,
      },
    };
  },
});

export const createWorkingPaper = mutation({
  args: {
    engagementId: v.id("auditEngagements"),
    title: v.string(),
    description: v.optional(v.string()),
    content: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const ea = await requireEngagementAccess(ctx, args.engagementId);
    requireTeamRole(ea, ["auditor", "lead_auditor"], "create working papers");

    const siblings = await ctx.db
      .query("workingPapers")
      .withIndex("by_engagement", (q) =>
        q.eq("engagementId", args.engagementId),
      )
      .collect();
    const code = `WP-${String(siblings.length + 1).padStart(3, "0")}`;
    const now = Date.now();

    const id = await ctx.db.insert("workingPapers", {
      organizationId: ea.access.organizationId!,
      engagementId: args.engagementId,
      code,
      title: args.title,
      description: args.description,
      content: args.content,
      createdById: ea.access.user?._id,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });

    await logAudit(ctx, {
      organizationId: ea.access.organizationId!,
      userId: ea.access.user?._id,
      actorLabel: ea.access.user?.name ?? undefined,
      action: "working_paper.created",
      entityType: "workingPapers",
      entityId: id,
      summary: `${code} ${args.title} on ${ea.engagement.code}`,
    });

    return { id, code };
  },
});

/** Update prepared-by content (draft/returned states only). */
export const updateWorkingPaper = mutation({
  args: {
    id: v.id("workingPapers"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    content: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const wp = await ctx.db.get(args.id);
    if (!wp) throw new Error("Working paper not found");
    const ea = await requireEngagementAccess(ctx, wp.engagementId);
    if (!ea.canWork) throw new Error("Only assigned users can edit working papers");
    if (wp.status === "approved") {
      throw new Error("Approved working papers are immutable");
    }

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const key of ["title", "description", "content"] as const) {
      if (args[key] !== undefined) patch[key] = args[key];
    }
    await ctx.db.patch(args.id, patch);

    await logAudit(ctx, {
      organizationId: ea.access.organizationId!,
      userId: ea.access.user?._id,
      actorLabel: ea.access.user?.name ?? undefined,
      action: "working_paper.updated",
      entityType: "workingPapers",
      entityId: args.id,
      summary: `${wp.code} updated`,
    });
    return { ok: true };
  },
});

/**
 * Working-paper lifecycle transition with reviewer authority:
 * draft→submitted (preparer), submitted→reviewed/returned (reviewer),
 * reviewed→approved (manager/director), returned→submitted (preparer).
 */
export const transitionWorkingPaper = mutation({
  args: {
    id: v.id("workingPapers"),
    to: workingPaperStatusValidator,
    reviewerId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const wp = await ctx.db.get(args.id);
    if (!wp) throw new Error("Working paper not found");
    const ea = await requireEngagementAccess(ctx, wp.engagementId);
    const from = wp.status as WorkingPaperStatus;
    const to = args.to;

    if (!workingPaperTransitionAllowed(from, to, ea.teamRole ?? undefined)) {
      throw new Error(
        `Your role (${ea.teamRole ?? "unassigned"}) may not move this working paper from ${WORKING_PAPER_LABELS[from]} to ${WORKING_PAPER_LABELS[to]}`,
      );
    }
    if ((to === "reviewed" || to === "returned" || to === "approved") &&
        !canReviewWork(ea.teamRole ?? "auditor") &&
        !ea.isManagerLike) {
      throw new Error("Only reviewers may disposition a submitted working paper");
    }

    const now = Date.now();
    const patch: Record<string, unknown> = {
      status: to,
      updatedAt: now,
    };
    if (to === "submitted") patch.submittedAt = now;
    if (to === "reviewed") {
      patch.reviewedAt = now;
      patch.reviewerId = ea.access.user?._id;
    }
    if (to === "returned") patch.reviewerId = ea.access.user?._id;
    if (to === "approved") {
      patch.approvedAt = now;
      patch.reviewerId = wp.reviewerId ?? ea.access.user?._id;
    }
    if (args.reviewerId && (to === "submitted" || to === "returned")) {
      patch.reviewerId = args.reviewerId;
    }
    await ctx.db.patch(args.id, patch);

    await logAudit(ctx, {
      organizationId: ea.access.organizationId!,
      userId: ea.access.user?._id,
      actorLabel: ea.access.user?.name ?? undefined,
      action: "working_paper.status_changed",
      entityType: "workingPapers",
      entityId: args.id,
      summary: `${wp.code} ${wp.title}: ${WORKING_PAPER_LABELS[from]} → ${WORKING_PAPER_LABELS[to]}`,
    });

    // Notify the reviewer (submission) or the preparer (return/approval).
    if (to === "submitted" && args.reviewerId) {
      await notify(ctx, {
        organizationId: ea.access.organizationId!,
        userId: args.reviewerId,
        title: "Review required",
        body: `${wp.code} ${wp.title} on ${ea.engagement.code} was submitted for your review.`,
        severity: "info",
        href: "/audit/workpapers",
      });
    }
    if (to === "returned" && wp.createdById) {
      await notify(ctx, {
        organizationId: ea.access.organizationId!,
        userId: wp.createdById,
        title: "Working paper returned",
        body: `${wp.code} ${wp.title} was returned by the reviewer — see the review comments.`,
        severity: "warning",
        href: "/audit/workpapers",
      });
    }

    return { ok: true, from, to };
  },
});

/** Append a reviewer/preparer comment (approval history trail). */
export const addWorkingPaperComment = mutation({
  args: {
    workingPaperId: v.id("workingPapers"),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const wp = await ctx.db.get(args.workingPaperId);
    if (!wp) throw new Error("Working paper not found");
    const ea = await requireEngagementAccess(ctx, wp.engagementId);
    if (!ea.canWork) throw new Error("Only assigned users may comment");

    const id = await ctx.db.insert("workingPaperComments", {
      organizationId: ea.access.organizationId!,
      workingPaperId: args.workingPaperId,
      authorId: ea.access.user?._id,
      authorName: ea.access.user?.name ?? ea.access.user?.email ?? undefined,
      body: args.body,
      createdAt: Date.now(),
    });

    await logAudit(ctx, {
      organizationId: ea.access.organizationId!,
      userId: ea.access.user?._id,
      actorLabel: ea.access.user?.name ?? undefined,
      action: "working_paper.commented",
      entityType: "workingPapers",
      entityId: args.workingPaperId,
      summary: `Comment on ${wp.code}`,
    });

    return { id };
  },
});
