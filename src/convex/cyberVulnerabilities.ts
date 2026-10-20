import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  CYBER_ACTION_STATUS_LABELS,
  CYBER_ASSET_NAME_MAX,
  CYBER_DESCRIPTION_MAX,
  CYBER_REASON_MIN,
  CYBER_COMPLETION_NOTES_MIN,
  CYBER_TEXT_MAX,
  CYBER_TITLE_MAX,
  CYBER_TITLE_MIN,
  CYBER_VERIFICATION_NOTES_MIN,
  CYBER_VULNERABILITY_STATUS_LABELS,
  canTransitionVulnerability,
  cyberSeverityValidator,
  cyberVulnerabilitySourceValidator,
  cyberVulnerabilityStatusValidator,
  isOpenVulnerabilityStatus,
  validateCveId,
  validateCvssScore,
  validateCvssVector,
  type CyberVulnerabilityStatus,
} from "../lib/cyber";
import {
  appendCyberEvent,
  logCyberAudit,
  nextReference,
  optionalDate,
  optionalText,
  presentAction,
  presentCyberEvidence,
  presentEvent,
  presentVulnerability,
  requireCyberManager,
  requireNarrative,
  requireOwnedAssessment,
  requireOwnedVulnerability,
  requireText,
  resolveCyberAccess,
  resolveMemberLabel,
} from "./cyberCore";

/**
 * Vulnerability register (Phase 4A — Batch 1)
 * ===========================================
 * Lifecycle: open → confirmed → in remediation → remediated → verified → closed
 * (plus risk-accepted / false-positive branches and explicit reopening).
 *
 * Security properties:
 *  - Severity and CVSS are INDEPENDENT validated inputs. A CVSS score is stored
 *    only when it is a real 0–10 score with at most one decimal; it is never
 *    derived from severity and no score is invented for unscored records.
 *  - The organization comes from the access context; the linked assessment and
 *    risk row are re-validated against it, so foreign ids are refused.
 *  - `remediated` is a CLAIM by the person who applied the fix. `verified`
 *    requires a DIFFERENT authorized user — the implementer can never verify
 *    their own remediation.
 *  - Closing requires a verified (or risk-accepted / false-positive) record and
 *    no outstanding remediation actions; the reason is recorded.
 *  - Linking an ICT risk row NEVER changes the risk's score or residual risk:
 *    that remains the Risk Assessment workflow's job.
 *  - Every transition appends an immutable event and an audit entry that name
 *    the ACTOR separately from the affected vulnerability.
 */

const LIST_LIMIT = 500;
const ACTION_SCAN_LIMIT = 1000;

type MutableVulnerability = Partial<Doc<"vulnerabilities">>;

function assertTransition(
  from: CyberVulnerabilityStatus,
  to: CyberVulnerabilityStatus,
  action: string,
) {
  if (!canTransitionVulnerability(from, to)) {
    throw new Error(
      `Cannot ${action}: ${CYBER_VULNERABILITY_STATUS_LABELS[from]} → ${CYBER_VULNERABILITY_STATUS_LABELS[to]} is not a permitted transition`,
    );
  }
}

async function actionsFor(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
): Promise<Doc<"vulnerabilityRemediationActions">[]> {
  return await ctx.db
    .query("vulnerabilityRemediationActions")
    .withIndex("by_organization", (q) =>
      q.eq("organizationId", organizationId),
    )
    .take(ACTION_SCAN_LIMIT);
}

function groupActions(actions: Doc<"vulnerabilityRemediationActions">[]) {
  const grouped = new Map<string, Doc<"vulnerabilityRemediationActions">[]>();
  for (const action of actions) {
    const key = String(action.vulnerabilityId);
    const list = grouped.get(key) ?? [];
    list.push(action);
    grouped.set(key, list);
  }
  return grouped;
}

/** Organization-scoped vulnerability register with filters + roll-ups. */
export const listVulnerabilities = query({
  args: {
    search: v.optional(v.string()),
    status: v.optional(cyberVulnerabilityStatusValidator),
    severity: v.optional(cyberSeverityValidator),
    assessmentId: v.optional(v.id("securityAssessments")),
    overdueOnly: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await resolveCyberAccess(ctx);
    const now = Date.now();
    const limit = Math.min(Math.max(args.limit ?? 100, 1), LIST_LIMIT);
    const search = args.search?.trim().toLowerCase() ?? "";

    if (args.assessmentId) {
      // Refuse a foreign assessment id instead of silently returning no rows.
      await requireOwnedAssessment(ctx, access.organizationId, args.assessmentId);
    }

    const rows = await ctx.db
      .query("vulnerabilities")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(LIST_LIMIT);
    const actions = await actionsFor(ctx, access.organizationId);
    const grouped = groupActions(actions);

    const presented = rows
      .filter((row) => (args.status ? row.status === args.status : true))
      .filter((row) => (args.severity ? row.severity === args.severity : true))
      .filter((row) =>
        args.assessmentId ? row.assessmentId === args.assessmentId : true,
      )
      .filter((row) => {
        if (!search) return true;
        return [
          row.reference ?? "",
          row.title,
          row.assetName,
          row.cveId ?? "",
          row.description ?? "",
          row.ownerLabel ?? "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(search);
      })
      .map((row) =>
        presentVulnerability(row, {
          actions: grouped.get(String(row._id)) ?? [],
          now,
        }),
      )
      .filter((row) => (args.overdueOnly ? row.overdue : true))
      .sort((a, b) => a.severityRank - b.severityRank || b.discoveredAt - a.discoveredAt)
      .slice(0, limit);

    const summary = {
      total: rows.length,
      open: rows.filter((row) => isOpenVulnerabilityStatus(row.status)).length,
      critical: rows.filter(
        (row) =>
          row.severity === "critical" && isOpenVulnerabilityStatus(row.status),
      ).length,
      high: rows.filter(
        (row) => row.severity === "high" && isOpenVulnerabilityStatus(row.status),
      ).length,
      overdue: rows.filter(
        (row) =>
          isOpenVulnerabilityStatus(row.status) &&
          row.remediationDue !== undefined &&
          row.remediationDue < now,
      ).length,
      unverified: rows.filter((row) => row.status === "remediated").length,
      riskAccepted: rows.filter((row) => row.status === "risk_accepted").length,
      verified: rows.filter((row) => row.status === "verified").length,
      closed: rows.filter((row) => row.status === "closed").length,
      canManage: access.canManage,
      currentUserId: access.userId,
    };

    return { rows: presented, summary };
  },
});

/** One vulnerability with its actions, history, evidence and linked records. */
export const getVulnerability = query({
  args: { vulnerabilityId: v.id("vulnerabilities") },
  handler: async (ctx, args) => {
    const access = await resolveCyberAccess(ctx);
    const vulnerability = await requireOwnedVulnerability(
      ctx,
      access.organizationId,
      args.vulnerabilityId,
    );
    const now = Date.now();

    const actions = await ctx.db
      .query("vulnerabilityRemediationActions")
      .withIndex("by_organization_vulnerability", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("vulnerabilityId", args.vulnerabilityId),
      )
      .take(ACTION_SCAN_LIMIT);

    const events = await ctx.db
      .query("vulnerabilityEvents")
      .withIndex("by_organization_vulnerability", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("vulnerabilityId", args.vulnerabilityId),
      )
      .take(300);

    const evidence = await ctx.db
      .query("cyberEvidence")
      .withIndex("by_organization_vulnerability", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("vulnerabilityId", args.vulnerabilityId),
      )
      .take(200);

    let assessment: {
      assessmentId: Id<"securityAssessments">;
      reference: string | null;
      name: string;
      status: string;
    } | null = null;
    if (vulnerability.assessmentId) {
      const record = await ctx.db.get(vulnerability.assessmentId);
      if (record && record.organizationId === access.organizationId) {
        assessment = {
          assessmentId: record._id,
          reference: record.reference ?? null,
          name: record.name,
          status: record.status,
        };
      }
    }

    let risk: {
      riskId: Id<"risks">;
      code: string;
      title: string;
      status: string;
    } | null = null;
    if (vulnerability.riskId) {
      const record = await ctx.db.get(vulnerability.riskId);
      if (record && record.organizationId === access.organizationId) {
        risk = {
          riskId: record._id,
          code: record.code,
          title: record.title,
          status: record.status,
        };
      }
    }

    const blockers = actions
      .filter(
        (action) =>
          action.status === "open" ||
          action.status === "in_progress" ||
          action.status === "completed",
      )
      .map(
        (action) =>
          `${action.reference} is ${CYBER_ACTION_STATUS_LABELS[action.status]}`,
      );

    return {
      vulnerability: presentVulnerability(vulnerability, { actions, now }),
      actions: actions
        .slice()
        .sort((a, b) => (a.dueDate ?? Infinity) - (b.dueDate ?? Infinity))
        .map((action) => presentAction(action, now)),
      events: events
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(presentEvent),
      evidence: evidence.map(presentCyberEvidence),
      assessment,
      risk,
      closureBlockers: blockers,
      canManage: access.canManage,
      currentUserId: access.userId,
    };
  },
});

/** Register a vulnerability. Creates no actions, findings or risk scores. */
export const createVulnerability = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    assetName: v.string(),
    severity: cyberSeverityValidator,
    cvssScore: v.optional(v.number()),
    cvssVector: v.optional(v.string()),
    cveId: v.optional(v.string()),
    source: v.optional(cyberVulnerabilitySourceValidator),
    assessmentId: v.optional(v.id("securityAssessments")),
    ownerUserId: v.optional(v.id("users")),
    discoveredAt: v.optional(v.number()),
    remediationDue: v.optional(v.number()),
    remediationNotes: v.optional(v.string()),
    riskId: v.optional(v.id("risks")),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const title = requireText(
      args.title,
      "Vulnerability title",
      CYBER_TITLE_MAX,
      CYBER_TITLE_MIN,
    );
    const assetName = requireText(
      args.assetName,
      "Affected asset or system",
      CYBER_ASSET_NAME_MAX,
      2,
    );
    const description = optionalText(
      args.description,
      "Description",
      CYBER_DESCRIPTION_MAX,
    );
    const remediationNotes = optionalText(
      args.remediationNotes,
      "Remediation notes",
      CYBER_TEXT_MAX,
    );
    const cvssScore = validateCvssScore(args.cvssScore);
    const cvssVector = validateCvssVector(args.cvssVector);
    const cveId = validateCveId(args.cveId);

    const discoveredAt = optionalDate(args.discoveredAt, "Discovery date") ?? Date.now();
    const remediationDue = optionalDate(args.remediationDue, "Remediation target date");
    if (remediationDue !== undefined && remediationDue < discoveredAt) {
      throw new Error("The remediation target date cannot precede the discovery date");
    }

    if (args.assessmentId) {
      await requireOwnedAssessment(ctx, manager.organizationId, args.assessmentId);
    }
    if (args.riskId) {
      const risk = await ctx.db.get(args.riskId);
      if (!risk || risk.organizationId !== manager.organizationId) {
        throw new Error("Risk not found in your organization");
      }
    }
    const ownerLabel = await resolveMemberLabel(
      ctx,
      manager.organizationId,
      args.ownerUserId,
      manager.label,
      "Vulnerability owner",
    );

    const now = Date.now();
    const reference = await nextReference(
      ctx,
      "vulnerabilities",
      manager.organizationId,
      "VUL",
    );
    const vulnerabilityId = await ctx.db.insert("vulnerabilities", {
      organizationId: manager.organizationId,
      reference,
      title,
      description,
      assetName,
      severity: args.severity,
      cvssScore,
      cvssVector,
      cveId,
      source: args.source,
      status: "open",
      discoveredAt,
      remediationDue,
      assessmentId: args.assessmentId,
      ownerUserId: args.ownerUserId,
      ownerLabel,
      remediationNotes,
      riskId: args.riskId,
      createdAt: now,
      updatedAt: now,
    });

    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      vulnerabilityId,
      assessmentId: args.assessmentId,
      type: "vulnerability_created",
      toStatus: "open",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Vulnerability ${reference} recorded (${args.severity}) on ${assetName}`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.vulnerability_created",
      entityType: "vulnerabilities",
      entityId: String(vulnerabilityId),
      relatedEntityType: args.assessmentId ? "securityAssessments" : undefined,
      relatedEntityId: args.assessmentId ? String(args.assessmentId) : undefined,
      summary: `Recorded vulnerability ${reference} (${args.severity}) affecting ${assetName}`,
    });
    return { vulnerabilityId, reference };
  },
});

/** Edit descriptive fields before verification. Status is never changed here. */
export const updateVulnerability = mutation({
  args: {
    vulnerabilityId: v.id("vulnerabilities"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    assetName: v.optional(v.string()),
    severity: v.optional(cyberSeverityValidator),
    cvssScore: v.optional(v.number()),
    cvssVector: v.optional(v.string()),
    cveId: v.optional(v.string()),
    source: v.optional(cyberVulnerabilitySourceValidator),
    assessmentId: v.optional(v.id("securityAssessments")),
    ownerUserId: v.optional(v.id("users")),
    remediationDue: v.optional(v.number()),
    remediationNotes: v.optional(v.string()),
    riskId: v.optional(v.id("risks")),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const vulnerability = await requireOwnedVulnerability(
      ctx,
      manager.organizationId,
      args.vulnerabilityId,
    );
    if (
      vulnerability.status === "remediated" ||
      vulnerability.status === "verified" ||
      vulnerability.status === "closed"
    ) {
      throw new Error(
        "A remediated, verified or closed vulnerability cannot be edited; reopen it or record a new vulnerability",
      );
    }

    const patch: MutableVulnerability = { updatedAt: Date.now() };
    if (args.title !== undefined) {
      patch.title = requireText(
        args.title,
        "Vulnerability title",
        CYBER_TITLE_MAX,
        CYBER_TITLE_MIN,
      );
    }
    if (args.description !== undefined) {
      patch.description = optionalText(
        args.description,
        "Description",
        CYBER_DESCRIPTION_MAX,
      );
    }
    if (args.assetName !== undefined) {
      patch.assetName = requireText(
        args.assetName,
        "Affected asset or system",
        CYBER_ASSET_NAME_MAX,
        2,
      );
    }
    if (args.severity !== undefined) patch.severity = args.severity;
    if (args.cvssScore !== undefined) {
      patch.cvssScore = validateCvssScore(args.cvssScore);
    }
    if (args.cvssVector !== undefined) {
      patch.cvssVector = validateCvssVector(args.cvssVector);
    }
    if (args.cveId !== undefined) patch.cveId = validateCveId(args.cveId);
    if (args.source !== undefined) patch.source = args.source;
    if (args.remediationNotes !== undefined) {
      patch.remediationNotes = optionalText(
        args.remediationNotes,
        "Remediation notes",
        CYBER_TEXT_MAX,
      );
    }
    if (args.remediationDue !== undefined) {
      const due = optionalDate(args.remediationDue, "Remediation target date");
      if (due !== undefined && due < vulnerability.discoveredAt) {
        throw new Error(
          "The remediation target date cannot precede the discovery date",
        );
      }
      patch.remediationDue = due;
    }
    if (args.assessmentId !== undefined) {
      await requireOwnedAssessment(
        ctx,
        manager.organizationId,
        args.assessmentId,
      );
      patch.assessmentId = args.assessmentId;
    }
    if (args.riskId !== undefined) {
      const risk = await ctx.db.get(args.riskId);
      if (!risk || risk.organizationId !== manager.organizationId) {
        throw new Error("Risk not found in your organization");
      }
      patch.riskId = args.riskId;
    }
    if (args.ownerUserId !== undefined) {
      patch.ownerUserId = args.ownerUserId;
      patch.ownerLabel = await resolveMemberLabel(
        ctx,
        manager.organizationId,
        args.ownerUserId,
        manager.label,
        "Vulnerability owner",
      );
    }

    await ctx.db.patch(vulnerability._id, patch);
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      vulnerabilityId: vulnerability._id,
      type: "vulnerability_updated",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Vulnerability ${vulnerability.reference ?? vulnerability.title} details updated`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.vulnerability_updated",
      entityType: "vulnerabilities",
      entityId: String(vulnerability._id),
      summary: `Updated vulnerability ${vulnerability.reference ?? vulnerability.title}`,
    });
    return { vulnerabilityId: vulnerability._id };
  },
});

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

export const confirmVulnerability = mutation({
  args: { vulnerabilityId: v.id("vulnerabilities") },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const vulnerability = await requireOwnedVulnerability(
      ctx,
      manager.organizationId,
      args.vulnerabilityId,
    );
    assertTransition(vulnerability.status, "confirmed", "confirm");
    const now = Date.now();
    await ctx.db.patch(vulnerability._id, {
      status: "confirmed",
      lastTransitionAt: now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      vulnerabilityId: vulnerability._id,
      type: "vulnerability_confirmed",
      fromStatus: vulnerability.status,
      toStatus: "confirmed",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Vulnerability ${vulnerability.reference ?? vulnerability.title} confirmed`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.vulnerability_confirmed",
      entityType: "vulnerabilities",
      entityId: String(vulnerability._id),
      summary: `Confirmed vulnerability ${vulnerability.reference ?? vulnerability.title}`,
    });
    return { status: "confirmed" as const };
  },
});

export const startVulnerabilityRemediation = mutation({
  args: { vulnerabilityId: v.id("vulnerabilities") },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const vulnerability = await requireOwnedVulnerability(
      ctx,
      manager.organizationId,
      args.vulnerabilityId,
    );
    assertTransition(vulnerability.status, "in_remediation", "start remediation");
    const now = Date.now();
    await ctx.db.patch(vulnerability._id, {
      status: "in_remediation",
      lastTransitionAt: now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      vulnerabilityId: vulnerability._id,
      type: "vulnerability_remediation_started",
      fromStatus: vulnerability.status,
      toStatus: "in_remediation",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Remediation started for ${vulnerability.reference ?? vulnerability.title}`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.vulnerability_remediation_started",
      entityType: "vulnerabilities",
      entityId: String(vulnerability._id),
      summary: `Started remediation of ${vulnerability.reference ?? vulnerability.title}`,
    });
    return { status: "in_remediation" as const };
  },
});

/**
 * Record that the fix was applied. This is a CLAIM, not verification: the
 * record becomes `remediated` and must be independently verified afterwards.
 */
export const markVulnerabilityRemediated = mutation({
  args: { vulnerabilityId: v.id("vulnerabilities"), notes: v.string() },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const vulnerability = await requireOwnedVulnerability(
      ctx,
      manager.organizationId,
      args.vulnerabilityId,
    );
    assertTransition(vulnerability.status, "remediated", "record remediation");
    const notes = requireNarrative(
      args.notes,
      "Remediation notes",
      CYBER_TEXT_MAX,
      CYBER_COMPLETION_NOTES_MIN,
    );
    const now = Date.now();
    await ctx.db.patch(vulnerability._id, {
      status: "remediated",
      remediationNotes: notes,
      remediatedAt: now,
      remediatedByUserId: manager.userId,
      remediatedByLabel: manager.label,
      // A new remediation claim clears any earlier verification stamps.
      verifiedAt: undefined,
      verifiedByUserId: undefined,
      verifiedByLabel: undefined,
      verificationNotes: undefined,
      lastTransitionAt: now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      vulnerabilityId: vulnerability._id,
      type: "vulnerability_remediated",
      fromStatus: vulnerability.status,
      toStatus: "remediated",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Remediation recorded for ${vulnerability.reference ?? vulnerability.title}; independent verification required`,
      reason: notes,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.vulnerability_remediated",
      entityType: "vulnerabilities",
      entityId: String(vulnerability._id),
      summary: `Recorded (unverified) remediation of ${vulnerability.reference ?? vulnerability.title}`,
    });
    return { status: "remediated" as const };
  },
});

/**
 * Independent verification. The user who recorded the remediation can never
 * verify it, and no reason can bypass that separation of duties.
 */
export const verifyVulnerability = mutation({
  args: { vulnerabilityId: v.id("vulnerabilities"), notes: v.string() },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const vulnerability = await requireOwnedVulnerability(
      ctx,
      manager.organizationId,
      args.vulnerabilityId,
    );
    assertTransition(vulnerability.status, "verified", "verify");
    if (!vulnerability.remediatedByUserId) {
      throw new Error(
        "This record has no recorded remediation owner, so it cannot be verified",
      );
    }
    if (vulnerability.remediatedByUserId === manager.userId) {
      throw new Error(
        "Independent verification required: the person who recorded the remediation cannot verify it",
      );
    }
    const notes = requireNarrative(
      args.notes,
      "Verification notes",
      CYBER_TEXT_MAX,
      CYBER_VERIFICATION_NOTES_MIN,
    );
    const now = Date.now();
    await ctx.db.patch(vulnerability._id, {
      status: "verified",
      verifiedAt: now,
      verifiedByUserId: manager.userId,
      verifiedByLabel: manager.label,
      verificationNotes: notes,
      lastTransitionAt: now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      vulnerabilityId: vulnerability._id,
      type: "vulnerability_verified",
      fromStatus: vulnerability.status,
      toStatus: "verified",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Remediation of ${vulnerability.reference ?? vulnerability.title} independently verified`,
      reason: notes,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.vulnerability_verified",
      entityType: "vulnerabilities",
      entityId: String(vulnerability._id),
      summary: `Independently verified remediation of ${vulnerability.reference ?? vulnerability.title}`,
    });
    return { status: "verified" as const };
  },
});

export const acceptVulnerabilityRisk = mutation({
  args: { vulnerabilityId: v.id("vulnerabilities"), reason: v.string() },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const vulnerability = await requireOwnedVulnerability(
      ctx,
      manager.organizationId,
      args.vulnerabilityId,
    );
    assertTransition(vulnerability.status, "risk_accepted", "accept the risk");
    const reason = requireNarrative(
      args.reason,
      "Risk acceptance reason",
      CYBER_TEXT_MAX,
      CYBER_REASON_MIN,
    );
    const now = Date.now();
    await ctx.db.patch(vulnerability._id, {
      status: "risk_accepted",
      lastTransitionAt: now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      vulnerabilityId: vulnerability._id,
      type: "vulnerability_risk_accepted",
      fromStatus: vulnerability.status,
      toStatus: "risk_accepted",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Risk accepted for ${vulnerability.reference ?? vulnerability.title}`,
      reason,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.vulnerability_risk_accepted",
      entityType: "vulnerabilities",
      entityId: String(vulnerability._id),
      summary: `Accepted the risk of ${vulnerability.reference ?? vulnerability.title} (risk scores unchanged)`,
    });
    return { status: "risk_accepted" as const };
  },
});

export const markVulnerabilityFalsePositive = mutation({
  args: { vulnerabilityId: v.id("vulnerabilities"), reason: v.string() },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const vulnerability = await requireOwnedVulnerability(
      ctx,
      manager.organizationId,
      args.vulnerabilityId,
    );
    assertTransition(vulnerability.status, "false_positive", "mark as false positive");
    const reason = requireNarrative(
      args.reason,
      "False-positive rationale",
      CYBER_TEXT_MAX,
      CYBER_REASON_MIN,
    );
    const now = Date.now();
    await ctx.db.patch(vulnerability._id, {
      status: "false_positive",
      lastTransitionAt: now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      vulnerabilityId: vulnerability._id,
      type: "vulnerability_false_positive",
      fromStatus: vulnerability.status,
      toStatus: "false_positive",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Vulnerability ${vulnerability.reference ?? vulnerability.title} marked a false positive`,
      reason,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.vulnerability_false_positive",
      entityType: "vulnerabilities",
      entityId: String(vulnerability._id),
      summary: `Marked ${vulnerability.reference ?? vulnerability.title} as a false positive`,
    });
    return { status: "false_positive" as const };
  },
});

/**
 * Close a verified / risk-accepted / false-positive record. Outstanding
 * remediation actions must be resolved first — closure cannot bypass them.
 */
export const closeVulnerability = mutation({
  args: { vulnerabilityId: v.id("vulnerabilities"), closureReason: v.string() },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const vulnerability = await requireOwnedVulnerability(
      ctx,
      manager.organizationId,
      args.vulnerabilityId,
    );
    assertTransition(vulnerability.status, "closed", "close");
    const closureReason = requireNarrative(
      args.closureReason,
      "Closure reason",
      CYBER_TEXT_MAX,
      CYBER_REASON_MIN,
    );

    const actions = await ctx.db
      .query("vulnerabilityRemediationActions")
      .withIndex("by_organization_vulnerability", (q) =>
        q
          .eq("organizationId", manager.organizationId)
          .eq("vulnerabilityId", vulnerability._id),
      )
      .take(ACTION_SCAN_LIMIT);
    const outstanding = actions.filter(
      (action) =>
        action.status === "open" ||
        action.status === "in_progress" ||
        action.status === "completed",
    );
    if (outstanding.length > 0) {
      throw new Error(
        `Cannot close while remediation actions are unresolved: ${outstanding
          .map((action) => action.reference)
          .join(", ")}`,
      );
    }

    const now = Date.now();
    await ctx.db.patch(vulnerability._id, {
      status: "closed",
      closedAt: now,
      closureReason,
      lastTransitionAt: now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      vulnerabilityId: vulnerability._id,
      type: "vulnerability_closed",
      fromStatus: vulnerability.status,
      toStatus: "closed",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Vulnerability ${vulnerability.reference ?? vulnerability.title} closed`,
      reason: closureReason,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.vulnerability_closed",
      entityType: "vulnerabilities",
      entityId: String(vulnerability._id),
      summary: `Closed vulnerability ${vulnerability.reference ?? vulnerability.title}`,
    });
    return { status: "closed" as const };
  },
});

/**
 * Reopen a closed / risk-accepted / false-positive / verified record. The
 * earlier remediation and verification stamps are cleared so the new cycle
 * starts honest work, while the immutable events keep the full history.
 */
export const reopenVulnerability = mutation({
  args: { vulnerabilityId: v.id("vulnerabilities"), reason: v.string() },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const vulnerability = await requireOwnedVulnerability(
      ctx,
      manager.organizationId,
      args.vulnerabilityId,
    );
    assertTransition(vulnerability.status, "open", "reopen");
    const reason = requireNarrative(
      args.reason,
      "Reopening reason",
      CYBER_TEXT_MAX,
      CYBER_REASON_MIN,
    );
    const now = Date.now();
    await ctx.db.patch(vulnerability._id, {
      status: "open",
      closedAt: undefined,
      closureReason: undefined,
      remediatedAt: undefined,
      remediatedByUserId: undefined,
      remediatedByLabel: undefined,
      verifiedAt: undefined,
      verifiedByUserId: undefined,
      verifiedByLabel: undefined,
      verificationNotes: undefined,
      lastTransitionAt: now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      vulnerabilityId: vulnerability._id,
      type: "vulnerability_reopened",
      fromStatus: vulnerability.status,
      toStatus: "open",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Vulnerability ${vulnerability.reference ?? vulnerability.title} reopened`,
      reason,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.vulnerability_reopened",
      entityType: "vulnerabilities",
      entityId: String(vulnerability._id),
      summary: `Reopened vulnerability ${vulnerability.reference ?? vulnerability.title}`,
    });
    return { status: "open" as const };
  },
});

/**
 * Link an ICT risk register row for traceability. Nothing on the risk record is
 * modified: residual risk remains governed by the Risk Assessment workflow.
 */
export const linkVulnerabilityRisk = mutation({
  args: { vulnerabilityId: v.id("vulnerabilities"), riskId: v.id("risks") },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const vulnerability = await requireOwnedVulnerability(
      ctx,
      manager.organizationId,
      args.vulnerabilityId,
    );
    const risk = await ctx.db.get(args.riskId);
    if (!risk || risk.organizationId !== manager.organizationId) {
      throw new Error("Risk not found in your organization");
    }
    await ctx.db.patch(vulnerability._id, {
      riskId: risk._id,
      updatedAt: Date.now(),
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      vulnerabilityId: vulnerability._id,
      type: "vulnerability_risk_linked",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Linked to ICT risk ${risk.code}`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.vulnerability_risk_linked",
      entityType: "vulnerabilities",
      entityId: String(vulnerability._id),
      relatedEntityType: "risks",
      relatedEntityId: String(risk._id),
      summary: `Linked vulnerability ${vulnerability.reference ?? vulnerability.title} to risk ${risk.code}; risk scores unchanged`,
    });
    return { riskId: risk._id };
  },
});
