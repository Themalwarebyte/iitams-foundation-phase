import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { api } from "./_generated/api";
import { logAudit, requirePermission } from "./auditAccess";
import type { AccessContext } from "./access";
import {
  ACCESS_REVIEW_CAPTURE_PAGE_SIZE,
  ACCESS_REVIEW_DECISION_LABELS,
  ACCESS_REVIEW_NOTE_MAX,
  ACCESS_REVIEW_RECOMMENDATION_LABELS,
  ACCESS_REVIEW_TITLE_MAX,
  accessReviewDecisionValidator,
  accessReviewRecommendationValidator,
  isCycleOverdue,
} from "../lib/accessReview";
import {
  MEMBERSHIP_STATUS_LABELS,
  PROVISIONABLE_INITIAL_ROLES,
  effectiveMembershipStatus,
} from "../lib/membership";

/**
 * Phase 3A — Batch A3: access reviews & recertification foundation.
 * ================================================================
 * Review cycles hold an immutable SNAPSHOT of the reviewed membership
 * (identity, role, membership status, last activity) plus append-only
 * reviewer decisions and remediation RECOMMENDATIONS.
 *
 * Authorization (every function, server-side, never trusted from the UI):
 *  - reads require `admin.view`; every write requires `admin.manage`;
 *  - the caller's organization comes ONLY from the resolved access context,
 *    and every id-addressed row is re-checked against it (a guessed id from
 *    another organization resolves to "not found");
 *  - snapshots are insert-only: no function patches `accessReviewItems`, so a
 *    later role/status change cannot rewrite historical review evidence;
 *  - a reviewer may not certify their OWN privileged (administrator) access;
 *    an independent administrator must record that decision;
 *  - remediation never changes a role or membership itself — it calls the
 *    existing authorized mutations (`admin.changeMemberRole` /
 *    `admin.setMembershipStatus`) and is marked "applied" only after they
 *    succeed. Recommendations are therefore never misreported as done.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface AdminContext {
  access: AccessContext;
  organizationId: Id<"organizations">;
  userId: Id<"users">;
  label: string;
}

async function requireAdminContext(
  ctx: MutationCtx | QueryCtx,
): Promise<AdminContext> {
  const access = await requirePermission(ctx, "admin.manage");
  if (!access.organizationId || !access.user) {
    throw new Error("No organization context");
  }
  if (!access.isProvisioned) {
    throw new Error("Caller membership is not active");
  }
  return {
    access,
    organizationId: access.organizationId,
    userId: access.user._id,
    label: access.user.name ?? access.user.email ?? "Administrator",
  };
}

async function requireViewerContext(
  ctx: MutationCtx | QueryCtx,
): Promise<AdminContext> {
  const access = await requirePermission(ctx, "admin.view");
  if (!access.organizationId || !access.user) {
    throw new Error("No organization context");
  }
  return {
    access,
    organizationId: access.organizationId,
    userId: access.user._id,
    label: access.user.name ?? access.user.email ?? "Administrator",
  };
}

/** Trimmed, length-bounded note (evidence text, never interpreted as HTML). */
function cleanNotes(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > ACCESS_REVIEW_NOTE_MAX) {
    throw new Error(`Notes must be at most ${ACCESS_REVIEW_NOTE_MAX} characters`);
  }
  return trimmed;
}

async function loadCycle(
  ctx: MutationCtx | QueryCtx,
  cycleId: Id<"accessReviewCycles">,
  organizationId: Id<"organizations">,
): Promise<Doc<"accessReviewCycles">> {
  const cycle = await ctx.db.get(cycleId);
  if (!cycle || cycle.organizationId !== organizationId) {
    throw new Error("Review cycle not found in your organization");
  }
  return cycle;
}

async function loadItem(
  ctx: MutationCtx | QueryCtx,
  itemId: Id<"accessReviewItems">,
  organizationId: Id<"organizations">,
  cycleId: Id<"accessReviewCycles">,
): Promise<Doc<"accessReviewItems">> {
  const item = await ctx.db.get(itemId);
  if (
    !item ||
    item.organizationId !== organizationId ||
    item.cycleId !== cycleId
  ) {
    throw new Error("Review item not found in this cycle");
  }
  return item;
}

function latestDecision<T extends { createdAt: number }>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  return rows.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a));
}

/**
 * Snapshot eligible memberships into a cycle — one bounded PAGE per call.
 *
 * Why paged: an organization can hold thousands of profiles (the shared demo
 * organization accumulates guest sessions), and a single transaction cannot
 * scan and insert them all inside Convex's execution budget. Each call
 * processes at most CAPTURE_PAGE_SIZE profiles, persists the continuation
 * cursor on the cycle and returns. Callers resume with `captureMembers` until
 * `scanComplete` is true.
 *
 * Safety properties:
 *  - snapshots are insert-only and keyed by (cycle, profile): resuming can
 *    never duplicate an item or rewrite a captured role/status;
 *  - the cursor is stored on the cycle, so an interrupted capture resumes
 *    where it stopped instead of rescanning;
 *  - `captureScanComplete` becomes true only when the index scan is exhausted;
 *    cycle completion REFUSES until then, so a partial snapshot can never be
 *    reported as a full review.
 *
 * Eligible = provisioned, NON-anonymous profile in this organization whose
 * effective membership status is active at capture time.
 */
async function capturePage(
  ctx: MutationCtx,
  admin: AdminContext,
  cycle: Doc<"accessReviewCycles">,
) {
  if (cycle.captureScanComplete === true) {
    const items = await ctx.db
      .query("accessReviewItems")
      .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
      .collect();
    const eligible = cycle.membersEligible ?? items.length;
    return {
      scannedThisPage: 0,
      capturedThisPage: 0,
      capturedTotal: items.length,
      eligibleTotal: eligible,
      outstanding: Math.max(0, eligible - items.length),
      scanComplete: true,
    };
  }

  // Newest profiles first: a resumable scan must surface members an
  // administrator just added on the first page, not after every historical
  // guest row. The cursor keeps the position stable across calls.
  const page = await ctx.db
    .query("userProfiles")
    .withIndex("by_organization", (q) =>
      q.eq("organizationId", admin.organizationId),
    )
    .order("desc")
    .paginate({
      numItems: ACCESS_REVIEW_CAPTURE_PAGE_SIZE,
      cursor: cycle.captureCursor ?? null,
    });

  const existing = await ctx.db
    .query("accessReviewItems")
    .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
    .collect();
  const alreadyCaptured = new Set(existing.map((i) => i.targetProfileId));

  // Identity lookups run in PARALLEL within the page (bounded work).
  const users = await Promise.all(
    page.page.map((profile) => ctx.db.get(profile.userId)),
  );

  const candidates: Array<{
    profile: Doc<"userProfiles">;
    user: Doc<"users">;
  }> = [];
  let eligibleSeen = 0;
  page.page.forEach((profile, i) => {
    if (effectiveMembershipStatus(profile.membershipStatus) !== "active") {
      return;
    }
    const user = users[i];
    if (!user || user.isAnonymous === true) return;
    eligibleSeen += 1;
    if (alreadyCaptured.has(profile._id)) return;
    candidates.push({ profile, user });
  });

  const now = Date.now();
  await Promise.all(
    candidates.map(({ profile, user }) =>
      ctx.db.insert("accessReviewItems", {
        organizationId: admin.organizationId,
        cycleId: cycle._id,
        targetProfileId: profile._id,
        targetUserId: profile.userId,
        targetLabel: user.name ?? user.email ?? "Member",
        targetEmail: user.email,
        roleSnapshot: profile.role ?? "member",
        membershipStatusSnapshot: effectiveMembershipStatus(
          profile.membershipStatus,
        ),
        lastActivityAt: profile.lastSeenAt,
        capturedAt: now,
        capturedByUserId: admin.userId,
        capturedByLabel: admin.label,
      }),
    ),
  );

  const eligibleTotal = (cycle.membersEligible ?? 0) + eligibleSeen;
  const scannedTotal = (cycle.membersScanned ?? 0) + page.page.length;
  const capturedTotal = existing.length + candidates.length;

  await ctx.db.patch(cycle._id, {
    captureCursor: page.isDone ? undefined : page.continueCursor,
    membersScanned: scannedTotal,
    membersEligible: eligibleTotal,
    captureScanComplete: page.isDone,
    captureCompletedAt: page.isDone ? now : cycle.captureCompletedAt,
    lastCaptureAt: now,
  });

  return {
    scannedThisPage: page.page.length,
    capturedThisPage: candidates.length,
    capturedTotal,
    eligibleTotal,
    outstanding: Math.max(0, eligibleTotal - capturedTotal),
    scanComplete: page.isDone,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Organisation-scoped review cycles with progress counts.
 *
 * Reads are explicitly bounded: Convex enforces a 32,000-document / 16 MB
 * limit per function execution, so an unbounded scan of every historical cycle
 * plus every snapshot item eventually fails outright (it did once enough demo
 * cycles accumulated).
 *
 * The list is CURSOR-PAGINATED over the `by_organization` index (newest first),
 * so every historical cycle stays reachable without reading the whole history
 * into memory in one execution. Each page caps the evidence it summarises;
 * `captureScanComplete` on the cycle still reports whether its snapshot was
 * fully captured.
 */
const CYCLE_PAGE_DEFAULT = 25;
const CYCLE_PAGE_MAX = 50;
const CYCLE_ITEM_LIMIT = 300;
const CYCLE_DECISION_LIMIT = 300;
const CYCLE_REMEDIATION_LIMIT = 100;

export const listCycles = query({
  args: {
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const org = await requireViewerContext(ctx);
    const requested = args.numItems ?? CYCLE_PAGE_DEFAULT;
    const numItems = Math.min(
      Math.max(Number.isFinite(requested) ? Math.floor(requested) : CYCLE_PAGE_DEFAULT, 1),
      CYCLE_PAGE_MAX,
    );
    const page = await ctx.db
      .query("accessReviewCycles")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", org.organizationId),
      )
      .order("desc")
      .paginate({ numItems, cursor: args.cursor ?? null });

    const now = Date.now();
    const rows = [];
    for (const cycle of page.page) {
      const items = await ctx.db
        .query("accessReviewItems")
        .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
        .take(CYCLE_ITEM_LIMIT);
      const decisions = await ctx.db
        .query("accessReviewDecisions")
        .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
        .take(CYCLE_DECISION_LIMIT);
      const remediations = await ctx.db
        .query("accessReviewRemediations")
        .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
        .take(CYCLE_REMEDIATION_LIMIT);

      const decidedItems = new Set(decisions.map((d) => d.itemId));
      rows.push({
        _id: cycle._id,
        title: cycle.title,
        dueAt: cycle.dueAt,
        status: cycle.status,
        creatorLabel: cycle.creatorLabel,
        createdAt: cycle.createdAt,
        completedAt: cycle.completedAt,
        overdue: isCycleOverdue(cycle.status, cycle.dueAt, now),
        itemCount: items.length,
        membersEligible: cycle.membersEligible ?? items.length,
        captureScanComplete: cycle.captureScanComplete === true,
        outstanding: Math.max(
          0,
          (cycle.membersEligible ?? items.length) - items.length,
        ),
        decidedCount: items.filter((i) => decidedItems.has(i._id)).length,
        pendingCount: items.filter((i) => !decidedItems.has(i._id)).length,
        remediationProposed: remediations.filter((r) => r.status === "proposed")
          .length,
        remediationApplied: remediations.filter((r) => r.status === "applied")
          .length,
      });
    }
    return {
      rows,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * One cycle with its immutable snapshots, append-only decision history and
 * remediation records. Returns null for a cycle in another organization.
 */
export const getCycle = query({
  args: { cycleId: v.id("accessReviewCycles") },
  handler: async (ctx, args) => {
    const org = await requireViewerContext(ctx);
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle || cycle.organizationId !== org.organizationId) return null;

    const items = await ctx.db
      .query("accessReviewItems")
      .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
      .collect();
    const decisions = await ctx.db
      .query("accessReviewDecisions")
      .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
      .collect();
    const remediations = await ctx.db
      .query("accessReviewRemediations")
      .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
      .collect();

    const now = Date.now();
    return {
      cycle: {
        _id: cycle._id,
        title: cycle.title,
        dueAt: cycle.dueAt,
        status: cycle.status,
        creatorLabel: cycle.creatorLabel,
        creatorUserId: cycle.creatorUserId,
        createdAt: cycle.createdAt,
        completedAt: cycle.completedAt,
        completedByLabel: cycle.completedByLabel,
        overdue: isCycleOverdue(cycle.status, cycle.dueAt, now),
        membersScanned: cycle.membersScanned ?? 0,
        membersEligible: cycle.membersEligible ?? items.length,
        captureScanComplete: cycle.captureScanComplete === true,
        captureCompletedAt: cycle.captureCompletedAt,
        outstanding: Math.max(
          0,
          (cycle.membersEligible ?? items.length) - items.length,
        ),
      },
      items: items
        .sort((a, b) => a.targetLabel.localeCompare(b.targetLabel))
        .map((item) => {
          const itemDecisions = decisions
            .filter((d) => d.itemId === item._id)
            .sort((a, b) => b.createdAt - a.createdAt);
          const itemRemediations = remediations
            .filter((r) => r.itemId === item._id)
            .sort((a, b) => b.createdAt - a.createdAt);
          return {
            _id: item._id,
            targetProfileId: item.targetProfileId,
            targetUserId: item.targetUserId,
            targetLabel: item.targetLabel,
            targetEmail: item.targetEmail,
            roleSnapshot: item.roleSnapshot,
            membershipStatusSnapshot: item.membershipStatusSnapshot,
            lastActivityAt: item.lastActivityAt,
            capturedAt: item.capturedAt,
            capturedByLabel: item.capturedByLabel,
            latestDecision: itemDecisions[0] ?? null,
            decisions: itemDecisions,
            remediations: itemRemediations,
            latestRemediation: itemRemediations[0] ?? null,
          };
        }),
    };
  },
});

// ---------------------------------------------------------------------------
// Cycle lifecycle
// ---------------------------------------------------------------------------

/** Create a cycle (and snapshot the organization's real memberships). */
export const createCycle = mutation({
  args: {
    title: v.string(),
    dueAt: v.number(),
    captureMembers: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdminContext(ctx);
    const title = args.title.trim();
    if (title.length < 3 || title.length > ACCESS_REVIEW_TITLE_MAX) {
      throw new Error(
        `Title must be between 3 and ${ACCESS_REVIEW_TITLE_MAX} characters`,
      );
    }
    if (!Number.isFinite(args.dueAt)) {
      throw new Error("A due date is required");
    }
    // Due dates are forward-looking: a cycle created already past due could
    // never be completed inside its own window.
    if (args.dueAt <= Date.now()) {
      throw new Error("The due date must be in the future");
    }

    const now = Date.now();
    const manualScope = args.captureMembers === false;
    const cycleId = await ctx.db.insert("accessReviewCycles", {
      organizationId: admin.organizationId,
      title,
      dueAt: args.dueAt,
      status: "in_progress",
      creatorUserId: admin.userId,
      creatorLabel: admin.label,
      createdAt: now,
      membersScanned: 0,
      membersEligible: 0,
      // A cycle created WITHOUT capture is an explicit, empty-scope review:
      // the administrator declared there is nothing to snapshot. Anything
      // else stays incomplete until the index scan is exhausted.
      captureScanComplete: manualScope,
      captureCompletedAt: manualScope ? now : undefined,
    });

    const cycle = await ctx.db.get(cycleId);
    if (!cycle) throw new Error("Review cycle could not be created");

    const capture = manualScope
      ? {
          scannedThisPage: 0,
          capturedThisPage: 0,
          capturedTotal: 0,
          eligibleTotal: 0,
          outstanding: 0,
          scanComplete: true,
        }
      : await capturePage(ctx, admin, cycle);

    await logAudit(ctx, {
      organizationId: admin.organizationId,
      userId: admin.userId,
      actorId: admin.userId,
      actorLabel: admin.label,
      action: "access_review.cycle_created",
      entityType: "accessReviewCycles",
      entityId: cycleId,
      summary: `Access review cycle "${title}" created (due ${new Date(args.dueAt).toISOString()}); ${capture.capturedTotal} membership snapshot(s) captured, ${capture.scanComplete ? "snapshot complete" : "capture in progress (resumable)"}`,
    });

    return { cycleId, ...capture };
  },
});

/**
 * Capture the NEXT page of eligible memberships (resumable).
 *
 * Each call handles one bounded page and persists its cursor, so any
 * organization size is supported without a single oversized transaction.
 * Callers repeat until `scanComplete` is true; repeated calls after completion
 * are a no-op that reports the final counts.
 */
export const captureMembers = mutation({
  args: { cycleId: v.id("accessReviewCycles") },
  handler: async (ctx, args) => {
    const admin = await requireAdminContext(ctx);
    const cycle = await loadCycle(ctx, args.cycleId, admin.organizationId);
    if (cycle.status !== "in_progress") {
      throw new Error("Only an in-progress cycle can capture members");
    }
    const result = await capturePage(ctx, admin, cycle);
    if (result.scannedThisPage > 0 || result.scanComplete) {
      await logAudit(ctx, {
        organizationId: admin.organizationId,
        userId: admin.userId,
        actorId: admin.userId,
        actorLabel: admin.label,
        action: "access_review.members_captured",
        entityType: "accessReviewCycles",
        entityId: cycle._id,
        summary: `Capture page for "${cycle.title}": ${result.scannedThisPage} profile(s) scanned, ${result.capturedThisPage} snapshot(s) added, ${result.capturedTotal}/${result.eligibleTotal} eligible member(s) captured — ${result.scanComplete ? "snapshot complete" : "more pages remain"}`,
      });
    }
    return result;
  },
});

/** Close a fully reviewed cycle. Undecided items block completion. */
export const completeCycle = mutation({
  args: { cycleId: v.id("accessReviewCycles") },
  handler: async (ctx, args) => {
    const admin = await requireAdminContext(ctx);
    const cycle = await loadCycle(ctx, args.cycleId, admin.organizationId);
    if (cycle.status !== "in_progress") {
      throw new Error("Only an in-progress cycle can be completed");
    }

    // A partially captured snapshot is never a completed review.
    if (cycle.captureScanComplete !== true) {
      throw new Error(
        "Cannot complete: the membership snapshot is still being captured — finish capture first",
      );
    }

    const items = await ctx.db
      .query("accessReviewItems")
      .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
      .collect();
    const decisions = await ctx.db
      .query("accessReviewDecisions")
      .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
      .collect();
    const decided = new Set(decisions.map((d) => d.itemId));
    const pending = items.filter((i) => !decided.has(i._id)).length;
    if (pending > 0) {
      throw new Error(
        `Cannot complete: ${pending} review item(s) still have no decision`,
      );
    }
    const outstanding = Math.max(0, (cycle.membersEligible ?? items.length) - items.length);
    if (outstanding > 0) {
      throw new Error(
        `Cannot complete: ${outstanding} eligible member(s) were not captured`,
      );
    }

    const now = Date.now();
    await ctx.db.patch(cycle._id, {
      status: "completed",
      completedAt: now,
      completedByUserId: admin.userId,
      completedByLabel: admin.label,
    });
    await logAudit(ctx, {
      organizationId: admin.organizationId,
      userId: admin.userId,
      actorId: admin.userId,
      actorLabel: admin.label,
      action: "access_review.cycle_completed",
      entityType: "accessReviewCycles",
      entityId: cycle._id,
      summary: `Access review cycle "${cycle.title}" completed with ${items.length} reviewed membership(ies)`,
    });
    return { ok: true as const, completedAt: now };
  },
});

/** Abandon a cycle. Recorded history is retained; scores are never claimed. */
export const cancelCycle = mutation({
  args: { cycleId: v.id("accessReviewCycles"), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const admin = await requireAdminContext(ctx);
    const cycle = await loadCycle(ctx, args.cycleId, admin.organizationId);
    if (cycle.status !== "in_progress") {
      throw new Error("Only an in-progress cycle can be cancelled");
    }
    const notes = cleanNotes(args.reason);
    const now = Date.now();
    await ctx.db.patch(cycle._id, {
      status: "cancelled",
      completedAt: now,
      completedByUserId: admin.userId,
      completedByLabel: admin.label,
    });
    await logAudit(ctx, {
      organizationId: admin.organizationId,
      userId: admin.userId,
      actorId: admin.userId,
      actorLabel: admin.label,
      action: "access_review.cycle_cancelled",
      entityType: "accessReviewCycles",
      entityId: cycle._id,
      summary: `Access review cycle "${cycle.title}" cancelled${notes ? `: ${notes}` : ""}`,
    });
    return { ok: true as const };
  },
});

// ---------------------------------------------------------------------------
// Decisions (append-only history)
// ---------------------------------------------------------------------------

/**
 * Record a reviewer decision on one snapshotted membership.
 *
 * A reviewer can never certify their OWN administrator access: the only
 * privileged role in this system is `admin`, and self-certification of
 * privileged access requires an independent reviewer.
 */
export const recordDecision = mutation({
  args: {
    cycleId: v.id("accessReviewCycles"),
    itemId: v.id("accessReviewItems"),
    decision: accessReviewDecisionValidator,
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdminContext(ctx);
    const cycle = await loadCycle(ctx, args.cycleId, admin.organizationId);
    if (cycle.status !== "in_progress") {
      throw new Error("Decisions can only be recorded while a cycle is in progress");
    }
    const item = await loadItem(
      ctx,
      args.itemId,
      admin.organizationId,
      cycle._id,
    );

    // Self-review guard: privileged (administrator) access always needs an
    // independent reviewer. Non-privileged self-attestation is allowed.
    if (
      item.targetUserId === admin.userId &&
      item.roleSnapshot === "admin"
    ) {
      throw new Error(
        "Administrators cannot certify their own privileged access — an independent reviewer must record this decision",
      );
    }

    const notes = cleanNotes(args.notes);
    if (
      args.decision !== "access_confirmed" &&
      !notes
    ) {
      throw new Error(
        `${ACCESS_REVIEW_DECISION_LABELS[args.decision]} requires a reviewer note`,
      );
    }

    const decisionId = await ctx.db.insert("accessReviewDecisions", {
      organizationId: admin.organizationId,
      cycleId: cycle._id,
      itemId: item._id,
      decision: args.decision,
      notes,
      reviewerUserId: admin.userId,
      reviewerLabel: admin.label,
      createdAt: Date.now(),
    });

    await logAudit(ctx, {
      organizationId: admin.organizationId,
      userId: item.targetUserId,
      actorId: admin.userId,
      actorLabel: admin.label,
      action: "access_review.decision_recorded",
      entityType: "accessReviewItems",
      entityId: item._id,
      summary: `${ACCESS_REVIEW_DECISION_LABELS[args.decision]} recorded for ${item.targetLabel} (role at review: ${item.roleSnapshot ?? "member"}) in "${cycle.title}"`,
    });

    return { ok: true as const, decisionId };
  },
});

// ---------------------------------------------------------------------------
// Remediation (recommendation → existing authorized operation)
// ---------------------------------------------------------------------------

/** Record a remediation RECOMMENDATION for an item requiring remediation. */
export const proposeRemediation = mutation({
  args: {
    cycleId: v.id("accessReviewCycles"),
    itemId: v.id("accessReviewItems"),
    recommendation: accessReviewRecommendationValidator,
    targetRole: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdminContext(ctx);
    const cycle = await loadCycle(ctx, args.cycleId, admin.organizationId);
    if (cycle.status !== "in_progress") {
      throw new Error("Recommendations can only be recorded on an in-progress cycle");
    }
    const item = await loadItem(
      ctx,
      args.itemId,
      admin.organizationId,
      cycle._id,
    );

    const decisions = await ctx.db
      .query("accessReviewDecisions")
      .withIndex("by_item", (q) => q.eq("itemId", item._id))
      .collect();
    const latest = latestDecision(decisions);
    if (!latest || latest.decision !== "remediation_required") {
      throw new Error(
        "A recommendation requires a current \"Remediation required\" decision",
      );
    }

    const existing = await ctx.db
      .query("accessReviewRemediations")
      .withIndex("by_item", (q) => q.eq("itemId", item._id))
      .collect();
    if (existing.some((r) => r.status === "proposed")) {
      throw new Error("An open recommendation already exists for this member");
    }

    let targetRole: string | undefined;
    if (args.recommendation === "change_role") {
      const role = args.targetRole?.trim();
      if (!role) throw new Error("A target role is required for a role change");
      if (!(PROVISIONABLE_INITIAL_ROLES as readonly string[]).includes(role)) {
        throw new Error("That role cannot be assigned through role management");
      }
      // Snapshot is untouched; the recommendation simply must differ from the
      // reviewed role or it would change nothing.
      if (role === (item.roleSnapshot ?? "member")) {
        throw new Error("That is already the reviewed role");
      }
      targetRole = role;
    } else if (args.targetRole) {
      throw new Error("A target role only applies to a role-change recommendation");
    }

    const notes = cleanNotes(args.notes);
    const remediationId = await ctx.db.insert("accessReviewRemediations", {
      organizationId: admin.organizationId,
      cycleId: cycle._id,
      itemId: item._id,
      recommendation: args.recommendation,
      targetRole,
      notes,
      status: "proposed",
      proposedByUserId: admin.userId,
      proposedByLabel: admin.label,
      createdAt: Date.now(),
    });

    await logAudit(ctx, {
      organizationId: admin.organizationId,
      userId: item.targetUserId,
      actorId: admin.userId,
      actorLabel: admin.label,
      action: "access_review.remediation_proposed",
      entityType: "accessReviewRemediations",
      entityId: remediationId,
      summary: `Recommendation recorded (NOT applied) for ${item.targetLabel}: ${ACCESS_REVIEW_RECOMMENDATION_LABELS[args.recommendation]}${targetRole ? ` ${targetRole}` : ""}`,
    });

    return { ok: true as const, remediationId };
  },
});

/** Withdraw an unapplied recommendation (history is kept). */
export const withdrawRemediation = mutation({
  args: { remediationId: v.id("accessReviewRemediations") },
  handler: async (ctx, args) => {
    const admin = await requireAdminContext(ctx);
    const remediation = await ctx.db.get(args.remediationId);
    if (
      !remediation ||
      remediation.organizationId !== admin.organizationId
    ) {
      throw new Error("Recommendation not found in your organization");
    }
    if (remediation.status !== "proposed") {
      throw new Error("Only a proposed recommendation can be withdrawn");
    }
    await ctx.db.patch(remediation._id, {
      status: "withdrawn",
      withdrawnAt: Date.now(),
      withdrawnByLabel: admin.label,
    });
    await logAudit(ctx, {
      organizationId: admin.organizationId,
      userId: undefined,
      actorId: admin.userId,
      actorLabel: admin.label,
      action: "access_review.remediation_withdrawn",
      entityType: "accessReviewRemediations",
      entityId: remediation._id,
      summary: `Recommendation withdrawn before any access change`,
    });
    return { ok: true as const };
  },
});

/**
 * Apply a recommendation through the EXISTING authorized operations.
 *
 * The access change is performed by `admin.changeMemberRole` /
 * `admin.setMembershipStatus` — this module never writes `role` or
 * `membershipStatus` itself. The recommendation is marked "applied" only
 * AFTER that mutation succeeds; a refusal leaves it "proposed" and propagates
 * the error, so the UI can never show an unimplemented action as done.
 */
export const applyRemediation = mutation({
  args: { remediationId: v.id("accessReviewRemediations") },
  handler: async (ctx, args) => {
    const admin = await requireAdminContext(ctx);
    const remediation = await ctx.db.get(args.remediationId);
    if (
      !remediation ||
      remediation.organizationId !== admin.organizationId
    ) {
      throw new Error("Recommendation not found in your organization");
    }
    if (remediation.status !== "proposed") {
      throw new Error("Only a proposed recommendation can be applied");
    }

    const cycle = await loadCycle(
      ctx,
      remediation.cycleId,
      admin.organizationId,
    );
    if (cycle.status !== "in_progress") {
      throw new Error("Remediation can only be applied while the cycle is in progress");
    }
    const item = await loadItem(
      ctx,
      remediation.itemId,
      admin.organizationId,
      cycle._id,
    );

    // Re-check that the item is still awaiting remediation under its latest
    // decision: applying stale recommendations is refused.
    const decisions = await ctx.db
      .query("accessReviewDecisions")
      .withIndex("by_item", (q) => q.eq("itemId", item._id))
      .collect();
    const latest = latestDecision(decisions);
    if (!latest || latest.decision !== "remediation_required") {
      throw new Error(
        "The latest decision no longer requires remediation for this member",
      );
    }

    const profile = await ctx.db.get(item.targetProfileId);
    if (!profile || profile.organizationId !== admin.organizationId) {
      throw new Error("Reviewed membership no longer exists in your organization");
    }
    const roleBefore = profile.role ?? "member";
    const membershipBefore = effectiveMembershipStatus(
      profile.membershipStatus,
    );

    switch (remediation.recommendation) {
      case "change_role": {
        const role = remediation.targetRole;
        if (!role) throw new Error("Recommendation has no target role");
        // Existing authorized path: permission + tenant + guards + audit.
        await ctx.runMutation(api.admin.changeMemberRole, {
          profileId: item.targetProfileId,
          role: role as never,
        });
        break;
      }
      case "suspend_membership":
      case "deactivate_membership": {
        const status =
          remediation.recommendation === "suspend_membership"
            ? ("suspended" as const)
            : ("deactivated" as const);
        await ctx.runMutation(api.admin.setMembershipStatus, {
          profileId: item.targetProfileId,
          status,
        });
        break;
      }
      default:
        throw new Error("Unsupported recommendation");
    }

    // Only now — after the authorized mutation succeeded — mark it applied.
    const after = await ctx.db.get(item.targetProfileId);
    const roleAfter = after?.role ?? "member";
    const membershipAfter = effectiveMembershipStatus(after?.membershipStatus);
    const now = Date.now();
    await ctx.db.patch(remediation._id, {
      status: "applied",
      appliedAt: now,
      appliedByUserId: admin.userId,
      appliedByLabel: admin.label,
      roleBefore,
      roleAfter,
      membershipBefore,
      membershipAfter,
    });

    await logAudit(ctx, {
      organizationId: admin.organizationId,
      userId: item.targetUserId,
      actorId: admin.userId,
      actorLabel: admin.label,
      action: "access_review.remediation_applied",
      entityType: "accessReviewRemediations",
      entityId: remediation._id,
      summary: `${ACCESS_REVIEW_RECOMMENDATION_LABELS[remediation.recommendation]} applied for ${item.targetLabel}: role ${roleBefore} → ${roleAfter}, membership ${MEMBERSHIP_STATUS_LABELS[membershipBefore]} → ${MEMBERSHIP_STATUS_LABELS[membershipAfter]}`,
    });

    return {
      ok: true as const,
      roleBefore,
      roleAfter,
      membershipBefore,
      membershipAfter,
    };
  },
});

/** Reviewer-facing summary of what still needs attention in one cycle. */
export const pendingItems = query({
  args: { cycleId: v.id("accessReviewCycles") },
  handler: async (ctx, args) => {
    const org = await requireViewerContext(ctx);
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle || cycle.organizationId !== org.organizationId) return [];

    const items = await ctx.db
      .query("accessReviewItems")
      .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
      .collect();
    const decisions = await ctx.db
      .query("accessReviewDecisions")
      .withIndex("by_cycle", (q) => q.eq("cycleId", cycle._id))
      .collect();
    const decided = new Set(decisions.map((d) => d.itemId));
    return items
      .filter((i) => !decided.has(i._id))
      .sort((a, b) => a.targetLabel.localeCompare(b.targetLabel))
      .map((i) => ({
        _id: i._id,
        targetLabel: i.targetLabel,
        roleSnapshot: i.roleSnapshot,
        dueAt: cycle.dueAt,
        overdue: isCycleOverdue(cycle.status, cycle.dueAt),
      }));
  },
});
