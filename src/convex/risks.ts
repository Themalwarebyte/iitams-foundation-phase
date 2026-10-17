import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { logAudit, requirePermission } from "./auditAccess";
import type { AccessContext } from "./access";
import {
  RISK_ASSET_MAX,
  RISK_OWNER_MAX,
  RISK_TEXT_MAX,
  RISK_TITLE_MAX,
  isValidRiskFactor,
  riskBand,
  riskCategoryValidator,
  riskScore,
  riskStatusValidator,
} from "../lib/risk";

/**
 * Phase 3B — Batch 1: ICT Risk Register foundation.
 * =================================================
 * Organization-scoped risk records on the EXISTING `risks` table (no parallel
 * risk model). Every read requires `risk.view`, every write `risk.manage`, and
 * the organization always comes from the caller's resolved access context —
 * an id-addressed record is re-checked against it, so a guessed id from
 * another organization is indistinguishable from "not found".
 *
 * Scoring uses the canonical 5×5 model from src/lib/risk.ts (shared with the
 * UI), so inherent/residual bands can never disagree between server and client.
 *
 * Every create/update is one transaction with one immutable audit entry.
 * There is no approval shortcut: status changes are ordinary `risk.manage`
 * edits, and closing a risk does not bypass any permission.
 */

const RISK_LIST_LIMIT = 500;

interface RiskAccess {
  access: AccessContext;
  organizationId: Id<"organizations">;
  userId: Id<"users">;
  label: string;
}

async function requireRiskViewer(ctx: QueryCtx | MutationCtx): Promise<RiskAccess> {
  const access = await requirePermission(ctx, "risk.view");
  if (!access.organizationId || !access.user) {
    throw new Error("No organization context");
  }
  return {
    access,
    organizationId: access.organizationId,
    userId: access.user._id,
    label: access.user.name ?? access.user.email ?? "User",
  };
}

async function requireRiskManager(ctx: MutationCtx): Promise<RiskAccess> {
  const access = await requirePermission(ctx, "risk.manage");
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
    label: access.user.name ?? access.user.email ?? "User",
  };
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

/** Project a risk document into the API shape (scores derived, never stored). */
function presentRisk(risk: Doc<"risks">, now: number) {
  const inherentScore = riskScore(risk.inherentLikelihood, risk.inherentImpact);
  const residualScore = riskScore(risk.residualLikelihood, risk.residualImpact);
  return {
    _id: risk._id,
    code: risk.code,
    title: risk.title,
    description: risk.description,
    category: risk.category,
    assetOrService: risk.assetOrService,
    threat: risk.threat,
    vulnerability: risk.vulnerability,
    inherentLikelihood: risk.inherentLikelihood,
    inherentImpact: risk.inherentImpact,
    inherentScore,
    inherentBand: riskBand(inherentScore),
    residualLikelihood: risk.residualLikelihood,
    residualImpact: risk.residualImpact,
    residualScore,
    residualBand: riskBand(residualScore),
    existingControls: risk.existingControls,
    treatmentRecommendation: risk.treatmentRecommendation,
    status: risk.status,
    ownerUserId: risk.ownerUserId,
    ownerName: risk.ownerName,
    reviewDue: risk.reviewDue,
    reviewOverdue: risk.reviewDue !== undefined && risk.reviewDue < now,
    createdAt: risk.createdAt,
    updatedAt: risk.updatedAt,
  };
}

/** Organization-scoped register list with optional in-page filtering. */
export const listRisks = query({
  args: {
    search: v.optional(v.string()),
    category: v.optional(riskCategoryValidator),
    status: v.optional(riskStatusValidator),
    band: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const org = await requireRiskViewer(ctx);
    const rows = await ctx.db
      .query("risks")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", org.organizationId),
      )
      .take(RISK_LIST_LIMIT);

    const now = Date.now();
    const search = args.search?.trim().toLowerCase();
    return rows
      .map((r) => presentRisk(r, now))
      .filter((r) => {
        if (args.category && r.category !== args.category) return false;
        if (args.status && r.status !== args.status) return false;
        if (args.band && r.residualBand !== args.band) return false;
        if (!search) return true;
        return (
          r.code.toLowerCase().includes(search) ||
          r.title.toLowerCase().includes(search) ||
          (r.ownerName ?? "").toLowerCase().includes(search) ||
          (r.assetOrService ?? "").toLowerCase().includes(search) ||
          (r.category ?? "").toLowerCase().includes(search)
        );
      })
      .sort((a, b) => b.residualScore - a.residualScore);
  },
});

/** One risk with derived scores; null when it belongs to another organization. */
export const getRisk = query({
  args: { riskId: v.id("risks") },
  handler: async (ctx, args) => {
    const org = await requireRiskViewer(ctx);
    const risk = await ctx.db.get(args.riskId);
    if (!risk || risk.organizationId !== org.organizationId) return null;
    const presented = presentRisk(risk, Date.now());
    // Per-record history via the compound index: newest first, bounded, and
    // never dependent on where this record sits in the organization's log.
    const history = await ctx.db
      .query("auditLogs")
      .withIndex("by_organization_entity", (q) =>
        q
          .eq("organizationId", org.organizationId)
          .eq("entityType", "risks")
          .eq("entityId", String(risk._id)),
      )
      .order("desc")
      .take(100);
    return {
      ...presented,
      history: history.map((entry) => ({
        action: entry.action,
        summary: entry.summary,
        actorLabel: entry.actorLabel,
        createdAt: entry.createdAt,
      })),
    };
  },
});

/** Aggregate register posture for the page KPI strip (bounded read). */
export const riskSummary = query({
  args: {},
  handler: async (ctx) => {
    const org = await requireRiskViewer(ctx);
    const rows = await ctx.db
      .query("risks")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", org.organizationId),
      )
      .take(RISK_LIST_LIMIT);
    const now = Date.now();
    const soon = now + 30 * 24 * 60 * 60 * 1000;

    const bands = { critical: 0, high: 0, medium: 0, low: 0 };
    const statuses: Record<string, number> = {};
    let overdueReviews = 0;
    let dueSoon = 0;
    for (const r of rows) {
      const score = riskScore(r.residualLikelihood, r.residualImpact);
      bands[riskBand(score)] += 1;
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      if (r.reviewDue !== undefined) {
        if (r.reviewDue < now) overdueReviews += 1;
        else if (r.reviewDue <= soon) dueSoon += 1;
      }
    }
    return {
      total: rows.length,
      sampled: rows.length === RISK_LIST_LIMIT,
      bands,
      statuses,
      overdueReviews,
      dueSoon,
    };
  },
});

/**
 * Next unique risk identifier for the organization (R-001…). Mutations are
 * serialized by Convex, and the caller re-checks the unique index, so two
 * concurrent creations can never share a code.
 */
async function nextRiskCode(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
): Promise<string> {
  const rows = await ctx.db
    .query("risks")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(RISK_LIST_LIMIT);
  let max = 0;
  for (const r of rows) {
    const match = /^R-(\d+)$/.exec(r.code);
    if (match) max = Math.max(max, Number(match[1]));
  }
  let candidate = `R-${String(max + 1).padStart(3, "0")}`;
  // Defensive: never reuse a code even if the scan missed a high suffix.
  for (let i = 0; i < 1000; i += 1) {
    const clash = await ctx.db
      .query("risks")
      .withIndex("by_organization_code", (q) =>
        q.eq("organizationId", organizationId).eq("code", candidate),
      )
      .unique();
    if (!clash) return candidate;
    max += 1;
    candidate = `R-${String(max + 1).padStart(3, "0")}`;
  }
  throw new Error("Could not allocate a unique risk identifier");
}

/** Create a risk record (organization from the caller's access context only). */
export const createRisk = mutation({
  args: {
    title: v.string(),
    category: riskCategoryValidator,
    description: v.optional(v.string()),
    assetOrService: v.optional(v.string()),
    threat: v.optional(v.string()),
    vulnerability: v.optional(v.string()),
    inherentLikelihood: v.number(),
    inherentImpact: v.number(),
    residualLikelihood: v.number(),
    residualImpact: v.number(),
    existingControls: v.optional(v.string()),
    treatmentRecommendation: v.optional(v.string()),
    ownerName: v.optional(v.string()),
    reviewDue: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const manager = await requireRiskManager(ctx);

    const title = args.title.trim();
    if (title.length < 3 || title.length > RISK_TITLE_MAX) {
      throw new Error(`Title must be between 3 and ${RISK_TITLE_MAX} characters`);
    }
    validateFactors(args.inherentLikelihood, args.inherentImpact, "Inherent");
    validateFactors(args.residualLikelihood, args.residualImpact, "Residual");

    const now = Date.now();
    if (args.reviewDue !== undefined) {
      if (!Number.isFinite(args.reviewDue)) {
        throw new Error("Review date must be a valid date");
      }
      if (args.reviewDue <= now) {
        throw new Error("Review date must be in the future");
      }
    }

    const ownerName = cleanText(args.ownerName, "Owner", RISK_OWNER_MAX);
    const description = cleanText(args.description, "Description", RISK_TEXT_MAX);
    const assetOrService = cleanText(args.assetOrService, "Asset/service", RISK_ASSET_MAX);
    const threat = cleanText(args.threat, "Threat", RISK_TEXT_MAX);
    const vulnerability = cleanText(args.vulnerability, "Vulnerability", RISK_TEXT_MAX);
    const existingControls = cleanText(args.existingControls, "Existing controls", RISK_TEXT_MAX);
    const treatmentRecommendation = cleanText(
      args.treatmentRecommendation,
      "Treatment recommendation",
      RISK_TEXT_MAX,
    );

    const code = await nextRiskCode(ctx, manager.organizationId);
    const riskId = await ctx.db.insert("risks", {
      organizationId: manager.organizationId,
      code,
      title,
      category: args.category,
      description,
      assetOrService,
      threat,
      vulnerability,
      inherentLikelihood: args.inherentLikelihood,
      inherentImpact: args.inherentImpact,
      residualLikelihood: args.residualLikelihood,
      residualImpact: args.residualImpact,
      existingControls,
      treatmentRecommendation,
      status: "open",
      ownerName,
      reviewDue: args.reviewDue,
      createdAt: now,
      updatedAt: now,
    });

    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "risk.created",
      entityType: "risks",
      entityId: String(riskId),
      summary: `${code} "${title}" created (${args.category}); inherent ${args.inherentLikelihood}×${args.inherentImpact}, residual ${args.residualLikelihood}×${args.residualImpact}`,
    });

    return { ok: true as const, riskId, code };
  },
});

/** Update a risk. Only the fields supplied are changed; each is validated. */
export const updateRisk = mutation({
  args: {
    riskId: v.id("risks"),
    title: v.optional(v.string()),
    category: v.optional(riskCategoryValidator),
    description: v.optional(v.string()),
    assetOrService: v.optional(v.string()),
    threat: v.optional(v.string()),
    vulnerability: v.optional(v.string()),
    inherentLikelihood: v.optional(v.number()),
    inherentImpact: v.optional(v.number()),
    residualLikelihood: v.optional(v.number()),
    residualImpact: v.optional(v.number()),
    existingControls: v.optional(v.string()),
    treatmentRecommendation: v.optional(v.string()),
    status: v.optional(riskStatusValidator),
    ownerName: v.optional(v.string()),
    reviewDue: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const manager = await requireRiskManager(ctx);
    const risk = await ctx.db.get(args.riskId);
    if (!risk || risk.organizationId !== manager.organizationId) {
      throw new Error("Risk not found in your organization");
    }

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    const changed: string[] = [];

    if (args.title !== undefined) {
      const title = args.title.trim();
      if (title.length < 3 || title.length > RISK_TITLE_MAX) {
        throw new Error(`Title must be between 3 and ${RISK_TITLE_MAX} characters`);
      }
      if (title !== risk.title) {
        patch.title = title;
        changed.push("title");
      }
    }
    if (args.category !== undefined && args.category !== risk.category) {
      patch.category = args.category;
      changed.push("category");
    }
    if (args.description !== undefined) {
      const v = cleanText(args.description, "Description", RISK_TEXT_MAX);
      if (v !== risk.description) {
        patch.description = v;
        changed.push("description");
      }
    }
    if (args.assetOrService !== undefined) {
      const v = cleanText(args.assetOrService, "Asset/service", RISK_ASSET_MAX);
      if (v !== risk.assetOrService) {
        patch.assetOrService = v;
        changed.push("assetOrService");
      }
    }
    if (args.threat !== undefined) {
      const v = cleanText(args.threat, "Threat", RISK_TEXT_MAX);
      if (v !== risk.threat) {
        patch.threat = v;
        changed.push("threat");
      }
    }
    if (args.vulnerability !== undefined) {
      const v = cleanText(args.vulnerability, "Vulnerability", RISK_TEXT_MAX);
      if (v !== risk.vulnerability) {
        patch.vulnerability = v;
        changed.push("vulnerability");
      }
    }
    if (args.existingControls !== undefined) {
      const v = cleanText(args.existingControls, "Existing controls", RISK_TEXT_MAX);
      if (v !== risk.existingControls) {
        patch.existingControls = v;
        changed.push("existingControls");
      }
    }
    if (args.treatmentRecommendation !== undefined) {
      const v = cleanText(
        args.treatmentRecommendation,
        "Treatment recommendation",
        RISK_TEXT_MAX,
      );
      if (v !== risk.treatmentRecommendation) {
        patch.treatmentRecommendation = v;
        changed.push("treatmentRecommendation");
      }
    }
    if (args.ownerName !== undefined) {
      const v = cleanText(args.ownerName, "Owner", RISK_OWNER_MAX);
      if (v !== risk.ownerName) {
        patch.ownerName = v;
        changed.push("ownerName");
      }
    }
    if (args.reviewDue !== undefined && args.reviewDue !== risk.reviewDue) {
      if (!Number.isFinite(args.reviewDue) || args.reviewDue <= Date.now()) {
        throw new Error("Review date must be in the future");
      }
      patch.reviewDue = args.reviewDue;
      changed.push("reviewDue");
    }
    if (args.status !== undefined && args.status !== risk.status) {
      patch.status = args.status;
      changed.push("status");
    }

    // Scores are validated as a pair so a half-updated cell is impossible.
    const inherentLikelihood = args.inherentLikelihood ?? risk.inherentLikelihood;
    const inherentImpact = args.inherentImpact ?? risk.inherentImpact;
    const residualLikelihood = args.residualLikelihood ?? risk.residualLikelihood;
    const residualImpact = args.residualImpact ?? risk.residualImpact;
    if (args.inherentLikelihood !== undefined || args.inherentImpact !== undefined) {
      validateFactors(inherentLikelihood, inherentImpact, "Inherent");
      if (
        inherentLikelihood !== risk.inherentLikelihood ||
        inherentImpact !== risk.inherentImpact
      ) {
        patch.inherentLikelihood = inherentLikelihood;
        patch.inherentImpact = inherentImpact;
        changed.push("inherentScore");
      }
    }
    if (args.residualLikelihood !== undefined || args.residualImpact !== undefined) {
      validateFactors(residualLikelihood, residualImpact, "Residual");
      if (
        residualLikelihood !== risk.residualLikelihood ||
        residualImpact !== risk.residualImpact
      ) {
        patch.residualLikelihood = residualLikelihood;
        patch.residualImpact = residualImpact;
        changed.push("residualScore");
      }
    }

    if (changed.length === 0) {
      return { ok: true as const, changed: [] as string[] };
    }

    await ctx.db.patch(risk._id, patch);

    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "risk.updated",
      entityType: "risks",
      entityId: String(risk._id),
      summary: `${risk.code} updated (${changed.join(", ")})${args.status && args.status !== risk.status ? ` — status ${risk.status} → ${args.status}` : ""}`,
    });

    return { ok: true as const, changed };
  },
});
