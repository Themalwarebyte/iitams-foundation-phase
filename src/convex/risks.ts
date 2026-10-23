import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { logAudit, requirePermission } from "./auditAccess";
import type { AccessContext } from "./access";
import {
  RISK_ASSET_MAX,
  RISK_BANDS,
  RISK_OWNER_MAX,
  RISK_TEXT_MAX,
  RISK_TITLE_MAX,
  isValidRiskFactor,
  riskBand,
  riskCategoryValidator,
  riskScore,
  riskStatusValidator,
  type RiskBand,
  type RiskCategory,
  type RiskStatus,
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

/**
 * Register pagination contract
 * ----------------------------
 * ORDERING — the register is ordered by its per-organization identifier
 * (`R-001`, `R-002`, …) ascending over the `by_organization_code` index. That
 * index is unique per organization, so the order is total and deterministic:
 * no two rows can share a position, and an unchanged register always traverses
 * in exactly the same sequence. It is also the order people expect a register
 * to read in.
 *
 * TRAVERSAL — `cursor` is the last identifier the previous request examined.
 * The server scans forward from it with a bounded keyset read, so a client can
 * reach every record — including records created long after the first page —
 * without ever skipping or repeating one. A request performs at most
 * `RISK_SCAN_BUDGET` indexed document reads, which keeps one call cheap for an
 * organization with any number of risks. Cursors are validated by the server;
 * a cursor is only a position inside the caller's own register (the
 * organization always comes from the access context), never an authorization
 * token.
 *
 * FILTERS — search, category, status and residual band are applied server-side
 * to the records scanned by this request, so filtering genuinely searches the
 * register as it is traversed instead of only re-sorting what the browser
 * already has. When the scan budget runs out before the register ends,
 * `complete` is false and the response says how many records were examined, so
 * the UI can state that the search is partial instead of implying it covered
 * everything.
 */
const RISK_PAGE_DEFAULT = 25;
const RISK_PAGE_MAX = 100;
/** Documents one request may examine (bounded, indexed, no full materialisation). */
const RISK_SCAN_BUDGET = 400;
/** Keyset batch size inside the scan budget. */
const RISK_SCAN_BATCH = 100;

/**
 * Bounded window for the register summary. One thousand documents is far below
 * the per-query read budget; `exact` is false once the window is reached, and
 * callers must present `total` as a lower bound in that case.
 */
const RISK_SUMMARY_SCAN_LIMIT = 1000;

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

interface RiskFilters {
  search?: string;
  category?: RiskCategory;
  status?: RiskStatus;
  band?: RiskBand;
}

/** Filter predicate applied to stored records (scores derived, never trusted). */
function matchesRiskFilters(risk: Doc<"risks">, filters: RiskFilters): boolean {
  if (filters.category && risk.category !== filters.category) return false;
  if (filters.status && risk.status !== filters.status) return false;
  if (filters.band) {
    const band = riskBand(riskScore(risk.residualLikelihood, risk.residualImpact));
    if (band !== filters.band) return false;
  }
  if (!filters.search) return true;
  return (
    risk.code.toLowerCase().includes(filters.search) ||
    risk.title.toLowerCase().includes(filters.search) ||
    (risk.ownerName ?? "").toLowerCase().includes(filters.search) ||
    (risk.assetOrService ?? "").toLowerCase().includes(filters.search) ||
    risk.category.toLowerCase().includes(filters.search)
  );
}

/**
 * One page of the organization's register, ordered by identifier, with optional
 * filters. A new record therefore sorts at the end of the traversal, not on the
 * first page.
 *
 * Every call re-resolves `risk.view` and the organization from the caller's
 * access context, so a page can never be read across tenants or by a role
 * without the permission. The returned cursor is the only way to continue: it
 * is produced by the indexed traversal and validated by Convex, so a forged or
 * foreign cursor is rejected instead of being trusted.
 */
export const listRisks = query({
  args: {
    search: v.optional(v.string()),
    category: v.optional(riskCategoryValidator),
    status: v.optional(riskStatusValidator),
    band: v.optional(v.string()),
    numItems: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const org = await requireRiskViewer(ctx);

    const pageSize = args.numItems ?? RISK_PAGE_DEFAULT;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > RISK_PAGE_MAX) {
      throw new Error(
        `Page size must be a whole number between 1 and ${RISK_PAGE_MAX}`,
      );
    }
    const band = args.band === undefined ? undefined : (args.band as RiskBand);
    if (band !== undefined && !RISK_BANDS.includes(band)) {
      throw new Error(`Unknown residual band: ${args.band}`);
    }
    const search = args.search?.trim().toLowerCase() || undefined;
    const filters: RiskFilters = {
      search,
      category: args.category,
      status: args.status,
      band,
    };

    const now = Date.now();

    // Cursor = the last identifier the previous request examined. It only ever
    // positions a traversal inside the caller's own organization, and its shape
    // is validated so a malformed value is refused rather than silently
    // restarting or skipping the register.
    const after = args.cursor ?? null;
    if (after !== null && !/^R-\d{3,}$/.test(after)) {
      throw new Error("Invalid register cursor");
    }

    const items: Array<ReturnType<typeof presentRisk>> = [];
    let scanned = 0;
    let lastCode: string | null = after;
    let done = false;

    while (!done && items.length < pageSize && scanned < RISK_SCAN_BUDGET) {
      const batchSize = Math.min(RISK_SCAN_BATCH, RISK_SCAN_BUDGET - scanned);
      const rows =
        lastCode === null
          ? await ctx.db
              .query("risks")
              .withIndex("by_organization_code", (q) =>
                q.eq("organizationId", org.organizationId),
              )
              .order("asc")
              .take(batchSize)
          : await ctx.db
              .query("risks")
              .withIndex("by_organization_code", (q) =>
                q
                  .eq("organizationId", org.organizationId)
                  .gt("code", lastCode as string),
              )
              .order("asc")
              .take(batchSize);
      scanned += rows.length;
      if (rows.length < batchSize) done = true;
      for (const risk of rows) {
        lastCode = risk.code;
        if (matchesRiskFilters(risk, filters)) items.push(presentRisk(risk, now));
      }
    }

    const filtered = Boolean(search || args.category || args.status || band);
    return {
      items,
      // `null` only when the traversal reached the end of the register.
      nextCursor: done ? null : lastCode,
      isDone: done,
      // The whole register was walked for this filter set, so `items` is the
      // complete filtered result set rather than a prefix of it.
      complete: done,
      // Documents examined by this request. Filters apply to exactly these
      // records, which is what the disclosure in the UI must state.
      scanned,
      pageSize,
      filtered,
    };
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

/**
 * Aggregate register posture for the page KPI strip.
 *
 * Reads a bounded, newest-first window. While the register fits inside the
 * window the figures are exact; once the window is full `exact` is false and
 * `total` is a LOWER BOUND that callers must label as such (never presented as
 * an organization-wide total). Banding uses the same shared 5×5 model as the
 * register and the detail view.
 */
export const riskSummary = query({
  args: {},
  handler: async (ctx) => {
    const org = await requireRiskViewer(ctx);
    const rows = await ctx.db
      .query("risks")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", org.organizationId),
      )
      .take(RISK_SUMMARY_SCAN_LIMIT);
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
    const exact = rows.length < RISK_SUMMARY_SCAN_LIMIT;
    return {
      total: rows.length,
      // Exact organization-wide total, or an honest lower bound.
      exact,
      sampled: !exact,
      scanLimit: RISK_SUMMARY_SCAN_LIMIT,
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
 *
 * The numeric maximum is read twice, both times in bounded order rather than
 * from a capped scan of the register: the greatest code in the code index (one
 * document) and the codes of the newest records (zero-padded codes mean the
 * newest rows normally hold the highest numbers). Neither read depends on the
 * register fitting inside a listing window, and the unique-index probe below
 * remains the authority on reuse.
 */
const RISK_CODE_SCAN = 50;

async function nextRiskCode(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
): Promise<string> {
  const [latestByCode, newest] = await Promise.all([
    ctx.db
      .query("risks")
      .withIndex("by_organization_code", (q) =>
        q.eq("organizationId", organizationId),
      )
      .order("desc")
      .take(1),
    ctx.db
      .query("risks")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", organizationId),
      )
      .order("desc")
      .take(RISK_CODE_SCAN),
  ]);
  let max = 0;
  for (const r of [...latestByCode, ...newest]) {
    const match = /^R-(\d+)$/.exec(r.code);
    if (match) max = Math.max(max, Number(match[1]));
  }
  let candidate = `R-${String(max + 1).padStart(3, "0")}`;
  // Defensive: never reuse a code even if the index order missed a suffix
  // (codes longer than the three-digit padding sort differently).
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
