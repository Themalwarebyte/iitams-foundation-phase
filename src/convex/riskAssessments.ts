import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { logAudit, requirePermission } from "./auditAccess";
import {
  RISK_TEXT_MAX,
  isValidRiskFactor,
  riskBand,
  riskScore,
  type RiskBand,
} from "../lib/risk";

/**
 * Phase 3B — Batch 2A: ICT risk assessment and review history.
 * ============================================================
 * A structured assessment is an INSERT-ONLY snapshot for one existing risk:
 * assessment date, assessor, 5×5 inherent/residual factors, controls
 * considered, justification, observations and the next review date. Previous
 * assessments are historical evidence and are never patched or deleted.
 *
 * The register's CURRENT scores live on the `risks` row; recording an
 * assessment applies its factors and next review date there in the SAME
 * transaction, so the register can never drift from the latest assessment.
 * Scoring comes exclusively from src/lib/risk.ts — there is no second model.
 *
 * Authorization mirrors the register: `risk.view` to read, `risk.manage` to
 * write, an active membership for writes, organization resolved only from the
 * authenticated access context, and every risk id re-checked against it. No
 * approval workflow is implied or created here.
 */

const ASSESSMENT_LIST_LIMIT = 200;
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

interface AssessmentAccess {
  organizationId: Id<"organizations">;
  userId: Id<"users">;
  label: string;
}

async function requireViewer(ctx: Parameters<typeof requirePermission>[0]) {
  const access = await requirePermission(ctx, "risk.view");
  if (!access.organizationId || !access.user) {
    throw new Error("No organization context");
  }
  return {
    organizationId: access.organizationId,
    userId: access.user._id,
    label: access.user.name ?? access.user.email ?? "User",
  } satisfies AssessmentAccess;
}

async function requireManager(ctx: Parameters<typeof requirePermission>[0]) {
  const access = await requirePermission(ctx, "risk.manage");
  if (!access.organizationId || !access.user) {
    throw new Error("No organization context");
  }
  if (!access.isProvisioned) {
    throw new Error("Caller membership is not active");
  }
  return {
    organizationId: access.organizationId,
    userId: access.user._id,
    label: access.user.name ?? access.user.email ?? "User",
  } satisfies AssessmentAccess;
}

function validateFactors(
  likelihood: number,
  impact: number,
  label: string,
): void {
  if (!isValidRiskFactor(likelihood) || !isValidRiskFactor(impact)) {
    throw new Error(
      `${label} likelihood and impact must be whole numbers between 1 and 5`,
    );
  }
}

function cleanText(
  value: string | undefined,
  field: string,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) {
    throw new Error(`${field} must be at most ${max} characters`);
  }
  return trimmed;
}

function presentAssessment(
  row: Doc<"riskAssessments">,
): {
  _id: Id<"riskAssessments">;
  assessmentDate: number;
  assessorUserId: Id<"users">;
  assessorLabel: string;
  inherentLikelihood: number;
  inherentImpact: number;
  inherentScore: number;
  inherentBand: RiskBand;
  residualLikelihood: number;
  residualImpact: number;
  residualScore: number;
  residualBand: RiskBand;
  previousResidualScore: number;
  previousResidualBand: RiskBand;
  controlsConsidered?: string;
  justification: string;
  observations?: string;
  nextReviewDate: number;
  createdAt: number;
} {
  const inherent = riskScore(row.inherentLikelihood, row.inherentImpact);
  const residual = riskScore(row.residualLikelihood, row.residualImpact);
  return {
    _id: row._id,
    assessmentDate: row.assessmentDate,
    assessorUserId: row.assessorUserId,
    assessorLabel: row.assessorLabel,
    inherentLikelihood: row.inherentLikelihood,
    inherentImpact: row.inherentImpact,
    inherentScore: inherent,
    inherentBand: riskBand(inherent),
    residualLikelihood: row.residualLikelihood,
    residualImpact: row.residualImpact,
    residualScore: residual,
    residualBand: riskBand(residual),
    previousResidualScore: row.previousResidualScore,
    previousResidualBand: riskBand(row.previousResidualScore),
    controlsConsidered: row.controlsConsidered,
    justification: row.justification,
    observations: row.observations,
    nextReviewDate: row.nextReviewDate,
    createdAt: row.createdAt,
  };
}

/**
 * Assessment history for one risk, newest first, with the register's current
 * scores. `null` when the risk belongs to another organization (same "not
 * found" behaviour as `risks.getRisk`).
 */
export const listForRisk = query({
  args: { riskId: v.id("risks") },
  handler: async (ctx, args) => {
    const viewer = await requireViewer(ctx);
    const risk = await ctx.db.get(args.riskId);
    if (!risk || risk.organizationId !== viewer.organizationId) return null;

    const rows = await ctx.db
      .query("riskAssessments")
      .withIndex("by_organization_risk", (q) =>
        q.eq("organizationId", viewer.organizationId).eq("riskId", args.riskId),
      )
      .take(ASSESSMENT_LIST_LIMIT);

    const assessments = rows
      .map(presentAssessment)
      .sort(
        (a, b) =>
          b.assessmentDate - a.assessmentDate || b.createdAt - a.createdAt,
      );

    const currentResidual = riskScore(
      risk.residualLikelihood,
      risk.residualImpact,
    );
    const currentInherent = riskScore(
      risk.inherentLikelihood,
      risk.inherentImpact,
    );
    const latest = assessments[0];
    return {
      risk: {
        _id: risk._id,
        code: risk.code,
        title: risk.title,
        inherentLikelihood: risk.inherentLikelihood,
        inherentImpact: risk.inherentImpact,
        inherentScore: currentInherent,
        inherentBand: riskBand(currentInherent),
        residualLikelihood: risk.residualLikelihood,
        residualImpact: risk.residualImpact,
        residualScore: currentResidual,
        residualBand: riskBand(currentResidual),
        reviewDue: risk.reviewDue,
        reviewOverdue: risk.reviewDue !== undefined && risk.reviewDue < Date.now(),
      },
      assessments,
      latestResidualScore: latest?.residualScore ?? null,
      previousResidualScore: latest?.previousResidualScore ?? null,
      // Positive when the register has moved since the latest assessment (a
      // manual edit after the assessment); the page surfaces this honestly.
      driftSinceLatestAssessment:
        latest === null || latest === undefined
          ? null
          : currentResidual - latest.residualScore,
    };
  },
});

/**
 * Record a structured assessment and apply its outcome to the current risk
 * register row in one transaction. Prior assessment rows are untouched.
 */
export const createAssessment = mutation({
  args: {
    riskId: v.id("risks"),
    assessmentDate: v.number(),
    inherentLikelihood: v.number(),
    inherentImpact: v.number(),
    residualLikelihood: v.number(),
    residualImpact: v.number(),
    controlsConsidered: v.optional(v.string()),
    justification: v.string(),
    observations: v.optional(v.string()),
    nextReviewDate: v.number(),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const risk = await ctx.db.get(args.riskId);
    if (!risk || risk.organizationId !== manager.organizationId) {
      throw new Error("Risk not found in your organization");
    }

    validateFactors(args.inherentLikelihood, args.inherentImpact, "Inherent");
    validateFactors(args.residualLikelihood, args.residualImpact, "Residual");

    const now = Date.now();
    if (!Number.isFinite(args.assessmentDate)) {
      throw new Error("Assessment date must be a valid date");
    }
    if (args.assessmentDate > now + CLOCK_TOLERANCE_MS) {
      throw new Error("Assessment date cannot be in the future");
    }
    if (args.assessmentDate < risk.createdAt - CLOCK_TOLERANCE_MS) {
      throw new Error("Assessment date cannot precede the risk record");
    }
    if (!Number.isFinite(args.nextReviewDate)) {
      throw new Error("Next review date must be a valid date");
    }
    if (args.nextReviewDate <= now) {
      throw new Error("Next review date must be in the future");
    }
    if (args.nextReviewDate <= args.assessmentDate) {
      throw new Error("Next review date must be after the assessment date");
    }

    const justification = args.justification.trim();
    if (justification.length < 10) {
      throw new Error("Assessment justification must be at least 10 characters");
    }
    if (justification.length > RISK_TEXT_MAX) {
      throw new Error(`Assessment justification must be at most ${RISK_TEXT_MAX} characters`);
    }
    const controlsConsidered = cleanText(
      args.controlsConsidered,
      "Controls considered",
      RISK_TEXT_MAX,
    );
    const observations = cleanText(args.observations, "Observations", RISK_TEXT_MAX);

    const previousResidualScore = riskScore(
      risk.residualLikelihood,
      risk.residualImpact,
    );
    const newResidualScore = riskScore(
      args.residualLikelihood,
      args.residualImpact,
    );

    const assessmentId = await ctx.db.insert("riskAssessments", {
      organizationId: manager.organizationId,
      riskId: risk._id,
      assessmentDate: args.assessmentDate,
      assessorUserId: manager.userId,
      assessorLabel: manager.label,
      inherentLikelihood: args.inherentLikelihood,
      inherentImpact: args.inherentImpact,
      residualLikelihood: args.residualLikelihood,
      residualImpact: args.residualImpact,
      previousResidualScore,
      previousResidualBand: riskBand(previousResidualScore),
      controlsConsidered,
      justification,
      observations,
      nextReviewDate: args.nextReviewDate,
      isDemo: risk.isDemo,
      createdAt: now,
    });

    // Keep the register consistent with the latest assessment (same
    // transaction). The assessment row itself is already immutable history.
    await ctx.db.patch(risk._id, {
      inherentLikelihood: args.inherentLikelihood,
      inherentImpact: args.inherentImpact,
      residualLikelihood: args.residualLikelihood,
      residualImpact: args.residualImpact,
      reviewDue: args.nextReviewDate,
      updatedAt: now,
    });

    const previousBand = riskBand(previousResidualScore);
    const newBand = riskBand(newResidualScore);
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      // The entry concerns the risk owner when known; the actor is the
      // assessor, recorded explicitly and never conflated with the target.
      userId: risk.ownerUserId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "risk.assessment_recorded",
      entityType: "risks",
      entityId: String(risk._id),
      summary: `${risk.code} assessed by ${manager.label} on ${new Date(args.assessmentDate).toISOString().slice(0, 10)}: residual ${previousResidualScore} (${previousBand}) → ${newResidualScore} (${newBand}); next review ${new Date(args.nextReviewDate).toISOString().slice(0, 10)}`,
    });

    return {
      ok: true as const,
      assessmentId,
      previousResidualScore,
      previousResidualBand: previousBand,
      residualScore: newResidualScore,
      residualBand: newBand,
      bandChanged: previousBand !== newBand,
      nextReviewDate: args.nextReviewDate,
    };
  },
});
