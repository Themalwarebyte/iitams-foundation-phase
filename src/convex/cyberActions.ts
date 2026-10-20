import { v } from "convex/values";
import { mutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  CYBER_ACTION_STATUS_LABELS,
  CYBER_COMPLETION_NOTES_MIN,
  CYBER_REASON_MIN,
  CYBER_TEXT_MAX,
  CYBER_VERIFICATION_NOTES_MIN,
  canTransitionAction,
  type CyberActionStatus,
} from "../lib/cyber";
import {
  appendCyberEvent,
  logCyberAudit,
  nextReference,
  optionalDate,
  optionalText,
  requireCyberManager,
  requireNarrative,
  requireOwnedAction,
  requireOwnedVulnerability,
  resolveMemberLabel,
  validateEvidenceIds,
} from "./cyberCore";

/**
 * Vulnerability remediation actions (Phase 4A — Batch 1)
 * =====================================================
 * An action is explicit work: assigned, started, completed, independently
 * verified, then closed (or cancelled with a reason).
 *
 * Invariants:
 *  - `completed` is a CLAIM by the implementer; it is not verification.
 *  - Only a DIFFERENT authorized user may verify, and only a verified action may
 *    be closed. No argument, role or retry bypasses that check.
 *  - Failed verification returns the action to `in progress` and appends an
 *    immutable rejection event; the earlier claim stays readable.
 *  - Completing or verifying an action never changes the parent vulnerability's
 *    status: closure of the vulnerability is its own governed transition.
 */

function assertTransition(
  from: CyberActionStatus,
  to: CyberActionStatus,
  action: string,
) {
  if (!canTransitionAction(from, to)) {
    throw new Error(
      `Cannot ${action}: ${CYBER_ACTION_STATUS_LABELS[from]} → ${CYBER_ACTION_STATUS_LABELS[to]} is not a permitted transition`,
    );
  }
}

/** Assign a remediation action to a vulnerability. */
export const createRemediationAction = mutation({
  args: {
    vulnerabilityId: v.id("vulnerabilities"),
    description: v.string(),
    ownerUserId: v.optional(v.id("users")),
    dueDate: v.optional(v.number()),
    mandatory: v.optional(v.boolean()),
    evidenceIds: v.optional(v.array(v.id("cyberEvidence"))),
    progressNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const vulnerability = await requireOwnedVulnerability(
      ctx,
      manager.organizationId,
      args.vulnerabilityId,
    );
    if (vulnerability.status === "closed") {
      throw new Error(
        "A closed vulnerability cannot receive new remediation actions; reopen it first",
      );
    }
    const description = requireNarrative(
      args.description,
      "Action description",
      CYBER_TEXT_MAX,
      CYBER_REASON_MIN,
    );
    const progressNotes = optionalText(
      args.progressNotes,
      "Progress notes",
      CYBER_TEXT_MAX,
    );
    const dueDate = optionalDate(args.dueDate, "Due date");
    const ownerLabel = await resolveMemberLabel(
      ctx,
      manager.organizationId,
      args.ownerUserId,
      manager.label,
      "Action owner",
    );
    const evidenceIds = await validateEvidenceIds(
      ctx,
      manager.organizationId,
      vulnerability._id,
      args.evidenceIds,
    );

    const now = Date.now();
    const reference = await nextReference(
      ctx,
      "vulnerabilityRemediationActions",
      manager.organizationId,
      "VRA",
    );
    const actionId = await ctx.db.insert("vulnerabilityRemediationActions", {
      organizationId: manager.organizationId,
      vulnerabilityId: vulnerability._id,
      reference,
      description,
      ownerUserId: args.ownerUserId,
      ownerLabel,
      dueDate,
      mandatory: args.mandatory ?? true,
      status: "open",
      progressNotes,
      evidenceIds,
      createdAt: now,
      updatedAt: now,
    });

    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      vulnerabilityId: vulnerability._id,
      actionId,
      type: "action_created",
      toStatus: "open",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Remediation action ${reference} assigned to ${ownerLabel}`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.action_created",
      entityType: "vulnerabilityRemediationActions",
      entityId: String(actionId),
      relatedEntityType: "vulnerabilities",
      relatedEntityId: String(vulnerability._id),
      summary: `Assigned remediation action ${reference} for vulnerability ${vulnerability.reference ?? vulnerability.title}`,
    });
    return { actionId, reference };
  },
});

/** Edit an action that has not started yet. */
export const updateRemediationAction = mutation({
  args: {
    actionId: v.id("vulnerabilityRemediationActions"),
    description: v.optional(v.string()),
    ownerUserId: v.optional(v.id("users")),
    dueDate: v.optional(v.number()),
    mandatory: v.optional(v.boolean()),
    evidenceIds: v.optional(v.array(v.id("cyberEvidence"))),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const action = await requireOwnedAction(
      ctx,
      manager.organizationId,
      args.actionId,
    );
    if (action.status !== "open") {
      throw new Error(
        "Only an action that has not started can be edited; record progress instead",
      );
    }
    const patch: Partial<Doc<"vulnerabilityRemediationActions">> = {
      updatedAt: Date.now(),
    };
    if (args.description !== undefined) {
      patch.description = requireNarrative(
        args.description,
        "Action description",
        CYBER_TEXT_MAX,
        CYBER_REASON_MIN,
      );
    }
    if (args.ownerUserId !== undefined) {
      patch.ownerUserId = args.ownerUserId;
      patch.ownerLabel = await resolveMemberLabel(
        ctx,
        manager.organizationId,
        args.ownerUserId,
        manager.label,
        "Action owner",
      );
    }
    if (args.dueDate !== undefined) {
      patch.dueDate = optionalDate(args.dueDate, "Due date");
    }
    if (args.mandatory !== undefined) patch.mandatory = args.mandatory;
    if (args.evidenceIds !== undefined) {
      patch.evidenceIds = await validateEvidenceIds(
        ctx,
        manager.organizationId,
        action.vulnerabilityId,
        args.evidenceIds,
      );
    }
    await ctx.db.patch(action._id, patch);
    await logCyberAudit(ctx, manager, {
      action: "cyber.action_updated",
      entityType: "vulnerabilityRemediationActions",
      entityId: String(action._id),
      relatedEntityType: "vulnerabilities",
      relatedEntityId: String(action.vulnerabilityId),
      summary: `Updated remediation action ${action.reference}`,
    });
    return { actionId: action._id };
  },
});

export const startRemediationAction = mutation({
  args: { actionId: v.id("vulnerabilityRemediationActions") },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const action = await requireOwnedAction(
      ctx,
      manager.organizationId,
      args.actionId,
    );
    assertTransition(action.status, "in_progress", "start");
    const now = Date.now();
    await ctx.db.patch(action._id, {
      status: "in_progress",
      startedAt: action.startedAt ?? now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      vulnerabilityId: action.vulnerabilityId,
      actionId: action._id,
      type: "action_started",
      fromStatus: action.status,
      toStatus: "in_progress",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Remediation action ${action.reference} started`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.action_started",
      entityType: "vulnerabilityRemediationActions",
      entityId: String(action._id),
      relatedEntityType: "vulnerabilities",
      relatedEntityId: String(action.vulnerabilityId),
      summary: `Started remediation action ${action.reference}`,
    });
    return { status: "in_progress" as const };
  },
});

/** Completion is a claim of work done — NOT verification. */
export const completeRemediationAction = mutation({
  args: {
    actionId: v.id("vulnerabilityRemediationActions"),
    completionNotes: v.string(),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const action = await requireOwnedAction(
      ctx,
      manager.organizationId,
      args.actionId,
    );
    assertTransition(action.status, "completed", "complete");
    const completionNotes = requireNarrative(
      args.completionNotes,
      "Completion notes",
      CYBER_TEXT_MAX,
      CYBER_COMPLETION_NOTES_MIN,
    );
    const now = Date.now();
    await ctx.db.patch(action._id, {
      status: "completed",
      completedAt: now,
      completedByUserId: manager.userId,
      completedByLabel: manager.label,
      completionNotes,
      // A fresh claim clears any earlier verification stamps.
      verifiedAt: undefined,
      verifiedByUserId: undefined,
      verifiedByLabel: undefined,
      verificationNotes: undefined,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      vulnerabilityId: action.vulnerabilityId,
      actionId: action._id,
      type: "action_completed",
      fromStatus: action.status,
      toStatus: "completed",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Remediation action ${action.reference} reported complete; independent verification required`,
      reason: completionNotes,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.action_completed",
      entityType: "vulnerabilityRemediationActions",
      entityId: String(action._id),
      relatedEntityType: "vulnerabilities",
      relatedEntityId: String(action.vulnerabilityId),
      summary: `Recorded (unverified) completion of action ${action.reference}`,
    });
    return { status: "completed" as const };
  },
});

/** Independent verification of a completed action. */
export const verifyRemediationAction = mutation({
  args: {
    actionId: v.id("vulnerabilityRemediationActions"),
    verificationNotes: v.string(),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const action = await requireOwnedAction(
      ctx,
      manager.organizationId,
      args.actionId,
    );
    assertTransition(action.status, "verified", "verify");
    if (!action.completedByUserId) {
      throw new Error(
        "This action has no recorded implementer, so it cannot be verified",
      );
    }
    if (action.completedByUserId === manager.userId) {
      throw new Error(
        "Independent verification required: the implementer cannot verify their own action",
      );
    }
    const verificationNotes = requireNarrative(
      args.verificationNotes,
      "Verification notes",
      CYBER_TEXT_MAX,
      CYBER_VERIFICATION_NOTES_MIN,
    );
    const now = Date.now();
    await ctx.db.patch(action._id, {
      status: "verified",
      verifiedAt: now,
      verifiedByUserId: manager.userId,
      verifiedByLabel: manager.label,
      verificationNotes,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      vulnerabilityId: action.vulnerabilityId,
      actionId: action._id,
      type: "action_verified",
      fromStatus: action.status,
      toStatus: "verified",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Remediation action ${action.reference} independently verified`,
      reason: verificationNotes,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.action_verified",
      entityType: "vulnerabilityRemediationActions",
      entityId: String(action._id),
      relatedEntityType: "vulnerabilities",
      relatedEntityId: String(action.vulnerabilityId),
      summary: `Verified remediation action ${action.reference}`,
    });
    return { status: "verified" as const };
  },
});

/** Reject a completion claim: the action returns to active remediation. */
export const failRemediationVerification = mutation({
  args: {
    actionId: v.id("vulnerabilityRemediationActions"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const action = await requireOwnedAction(
      ctx,
      manager.organizationId,
      args.actionId,
    );
    assertTransition(action.status, "in_progress", "reject the completion claim");
    if (action.completedByUserId && action.completedByUserId === manager.userId) {
      throw new Error(
        "Independent verification required: the implementer cannot decide on their own action",
      );
    }
    const reason = requireNarrative(
      args.reason,
      "Verification failure reason",
      CYBER_TEXT_MAX,
      CYBER_VERIFICATION_NOTES_MIN,
    );
    const now = Date.now();
    await ctx.db.patch(action._id, {
      status: "in_progress",
      verificationNotes: reason,
      verifiedAt: undefined,
      verifiedByUserId: undefined,
      verifiedByLabel: undefined,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      vulnerabilityId: action.vulnerabilityId,
      actionId: action._id,
      type: "action_verification_failed",
      fromStatus: action.status,
      toStatus: "in_progress",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Verification of action ${action.reference} failed; returned to remediation`,
      reason,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.action_verification_failed",
      entityType: "vulnerabilityRemediationActions",
      entityId: String(action._id),
      relatedEntityType: "vulnerabilities",
      relatedEntityId: String(action.vulnerabilityId),
      summary: `Rejected the completion claim for action ${action.reference}`,
    });
    return { status: "in_progress" as const };
  },
});

export const closeRemediationAction = mutation({
  args: { actionId: v.id("vulnerabilityRemediationActions") },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const action = await requireOwnedAction(
      ctx,
      manager.organizationId,
      args.actionId,
    );
    assertTransition(action.status, "closed", "close");
    await ctx.db.patch(action._id, {
      status: "closed",
      updatedAt: Date.now(),
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      vulnerabilityId: action.vulnerabilityId,
      actionId: action._id,
      type: "action_closed",
      fromStatus: action.status,
      toStatus: "closed",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Remediation action ${action.reference} closed after verification`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.action_closed",
      entityType: "vulnerabilityRemediationActions",
      entityId: String(action._id),
      relatedEntityType: "vulnerabilities",
      relatedEntityId: String(action.vulnerabilityId),
      summary: `Closed verified remediation action ${action.reference}`,
    });
    return { status: "closed" as const };
  },
});

export const cancelRemediationAction = mutation({
  args: {
    actionId: v.id("vulnerabilityRemediationActions"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const action = await requireOwnedAction(
      ctx,
      manager.organizationId,
      args.actionId,
    );
    assertTransition(action.status, "cancelled", "cancel");
    const reason = requireNarrative(
      args.reason,
      "Cancellation reason",
      CYBER_TEXT_MAX,
      CYBER_REASON_MIN,
    );
    const now = Date.now();
    await ctx.db.patch(action._id, {
      status: "cancelled",
      cancelledAt: now,
      cancelledByUserId: manager.userId,
      cancelledByLabel: manager.label,
      cancelReason: reason,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      vulnerabilityId: action.vulnerabilityId,
      actionId: action._id,
      type: "action_cancelled",
      fromStatus: action.status,
      toStatus: "cancelled",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Remediation action ${action.reference} cancelled`,
      reason,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.action_cancelled",
      entityType: "vulnerabilityRemediationActions",
      entityId: String(action._id),
      relatedEntityType: "vulnerabilities",
      relatedEntityId: String(action.vulnerabilityId),
      summary: `Cancelled remediation action ${action.reference}`,
    });
    return { status: "cancelled" as const };
  },
});
