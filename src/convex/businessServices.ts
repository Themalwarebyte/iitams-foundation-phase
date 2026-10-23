import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  BCM_CRITICALITY_LABELS,
  BCM_SERVICE_STATUS_LABELS,
  BCM_TEXT_MAX,
  bcmCriticalityValidator,
  bcmServiceStatusValidator,
  type BcmCriticality,
  type BcmServiceStatus,
} from "../lib/bcm";
import { effectiveMembershipStatus } from "../lib/membership";
import {
  appendContinuityEvent,
  logBcmAudit,
  nextBcmReference,
  optionalText,
  requireActiveMember,
  requireBcmManager,
  requireNarrative,
  requireOwnedService,
  requireText,
  requireTitle,
  resolveBcmAccess,
  type BcmAccess,
} from "./bcmCore";

/**
 * Business services / processes requiring continuity planning
 * ===========================================================
 * Organization-scoped governed register (Phase 4A — Batch 4.1). These are the
 * services a BIA is written about. There is no ICT asset register, so related
 * systems and dependencies are validated free text, not invented foreign keys.
 */

const SCAN_LIMIT = 2000;
const PAGE_SCAN_LIMIT = 250;
const PAGE_LIMIT_MAX = 100;
const DEPARTMENT_MAX = 160;

type ServiceRow = {
  _id: Id<"businessServices">;
  reference: string;
  name: string;
  description: string;
  department: string;
  ownerUserId: Id<"users">;
  ownerLabel: string;
  operationalStatus: BcmServiceStatus;
  statusLabel: string;
  criticality: BcmCriticality;
  criticalityLabel: string;
  ictDependencies: string | null;
  keyDependencies: string;
  singlePointsOfFailure: string | null;
  createdAt: number;
  updatedAt: number;
};

function presentService(row: {
  _id: Id<"businessServices">;
  reference: string;
  name: string;
  description: string;
  department: string;
  ownerUserId: Id<"users">;
  ownerLabel: string;
  operationalStatus: BcmServiceStatus;
  criticality: BcmCriticality;
  ictDependencies?: string;
  keyDependencies: string;
  singlePointsOfFailure?: string;
  createdAt: number;
  updatedAt: number;
}): ServiceRow {
  return {
    _id: row._id,
    reference: row.reference,
    name: row.name,
    description: row.description,
    department: row.department,
    ownerUserId: row.ownerUserId,
    ownerLabel: row.ownerLabel,
    operationalStatus: row.operationalStatus,
    statusLabel: BCM_SERVICE_STATUS_LABELS[row.operationalStatus],
    criticality: row.criticality,
    criticalityLabel: BCM_CRITICALITY_LABELS[row.criticality],
    ictDependencies: row.ictDependencies ?? null,
    keyDependencies: row.keyDependencies,
    singlePointsOfFailure: row.singlePointsOfFailure ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Active members who may own a service or BIA (bounded directory read). */
export const formOptions = query({
  args: {},
  handler: async (ctx) => {
    const access = await resolveBcmAccess(ctx);
    const profiles = await ctx.db
      .query("userProfiles")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(200);
    const members: Array<{ userId: Id<"users">; label: string }> = [];
    for (const profile of profiles) {
      if (effectiveMembershipStatus(profile.membershipStatus) !== "active") {
        continue;
      }
      const user = await ctx.db.get(profile.userId);
      if (!user) continue;
      members.push({
        userId: profile.userId,
        label: user.name ?? user.email ?? "Member",
      });
    }
    members.sort((a, b) => a.label.localeCompare(b.label));
    return { members, canManage: access.canManage, currentUserId: access.userId };
  },
});

/** Service register with bounded, indexed reads and honest counts. */
export const listServices = query({
  args: {
    search: v.optional(v.string()),
    criticality: v.optional(bcmCriticalityValidator),
    status: v.optional(bcmServiceStatusValidator),
    limit: v.optional(v.number()),
    cursor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access: BcmAccess = await resolveBcmAccess(ctx);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), PAGE_LIMIT_MAX);
    const search = args.search?.trim().toLowerCase() ?? "";
    const scan = await ctx.db
      .query("businessServices")
      .withIndex("by_organization_created", (q) => {
        const scoped = q.eq("organizationId", access.organizationId);
        return args.cursor !== undefined
          ? scoped.lt("createdAt", args.cursor)
          : scoped;
      })
      .order("desc")
      .take(PAGE_SCAN_LIMIT);
    const filtered = scan
      .filter((row) => (args.criticality ? row.criticality === args.criticality : true))
      .filter((row) =>
        args.status ? row.operationalStatus === args.status : true,
      )
      .filter((row) =>
        args.cursor !== undefined ? row.createdAt < args.cursor : true,
      )
      .filter((row) => {
        if (!search) return true;
        return [row.reference, row.name, row.department, row.ownerLabel]
          .join(" ")
          .toLowerCase()
          .includes(search);
      });
    const page = filtered.slice(0, limit);
    const hasMore =
      page.length > 0 &&
      (filtered.length > limit || scan.length === PAGE_SCAN_LIMIT);

    const all = await ctx.db
      .query("businessServices")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(SCAN_LIMIT);

    return {
      rows: page.map(presentService),
      nextCursor: hasMore ? page[page.length - 1].createdAt : null,
      hasMore,
      counts: {
        total: all.length,
        critical: all.filter((row) => row.criticality === "critical").length,
        high: all.filter((row) => row.criticality === "high").length,
        retired: all.filter((row) => row.operationalStatus === "retired").length,
        truncated: all.length === SCAN_LIMIT,
      },
      canManage: access.canManage,
    };
  },
});

/** One service, its BIA versions and its append-only history. */
export const getService = query({
  args: { serviceId: v.id("businessServices") },
  handler: async (ctx, args) => {
    const access = await resolveBcmAccess(ctx);
    const service = await requireOwnedService(
      ctx,
      access.organizationId,
      args.serviceId,
    );
    const biaRows = await ctx.db
      .query("businessImpactAnalyses")
      .withIndex("by_organization_service", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("serviceId", args.serviceId),
      )
      .take(100);
    const events = await ctx.db
      .query("continuityEvents")
      .withIndex("by_organization_service", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("serviceId", args.serviceId),
      )
      .take(200);
    return {
      service: presentService(service),
      bias: biaRows
        .map((row) => ({
          _id: row._id,
          reference: row.reference,
          title: row.title,
          version: row.version,
          status: row.status,
          approvedAt: row.approvedAt ?? null,
          reviewDueAt: row.reviewDueAt,
          rtoMinutes: row.rtoMinutes,
          rpoMinutes: row.rpoMinutes ?? null,
        }))
        .sort((a, b) => b.version - a.version),
      history: events
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((event) => ({
          _id: event._id,
          type: event.type,
          summary: event.summary,
          reason: event.reason ?? null,
          actorLabel: event.actorLabel,
          createdAt: event.createdAt,
        })),
      canManage: access.canManage,
    };
  },
});

/** Register a business service or process. */
export const createService = mutation({
  args: {
    name: v.string(),
    description: v.string(),
    department: v.string(),
    ownerUserId: v.id("users"),
    operationalStatus: bcmServiceStatusValidator,
    criticality: bcmCriticalityValidator,
    ictDependencies: v.optional(v.string()),
    keyDependencies: v.string(),
    singlePointsOfFailure: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const ownerLabel = await requireActiveMember(
      ctx,
      access.organizationId,
      args.ownerUserId,
      "Service owner",
    );
    const reference = await nextBcmReference(
      ctx,
      "businessServices",
      access.organizationId,
      "BS",
    );
    const now = Date.now();
    const serviceId = await ctx.db.insert("businessServices", {
      organizationId: access.organizationId,
      reference,
      name: requireTitle(args.name, "Service name"),
      description: requireNarrative(args.description, "Service description"),
      department: requireText(
        args.department,
        "Department or business function",
        DEPARTMENT_MAX,
        2,
      ),
      ownerUserId: args.ownerUserId,
      ownerLabel,
      operationalStatus: args.operationalStatus,
      criticality: args.criticality,
      ictDependencies: optionalText(
        args.ictDependencies,
        "Related ICT systems",
        BCM_TEXT_MAX,
      ),
      keyDependencies: requireNarrative(
        args.keyDependencies,
        "Key operational dependencies",
      ),
      singlePointsOfFailure: optionalText(
        args.singlePointsOfFailure,
        "Single points of failure",
        BCM_TEXT_MAX,
      ),
      createdAt: now,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      serviceId,
      type: "service_registered",
      toStatus: args.operationalStatus,
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Business service ${reference} registered`,
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.service_created",
      entityType: "businessServices",
      entityId: String(serviceId),
      summary: `Registered business service ${reference}`,
    });
    return { serviceId, reference };
  },
});

/** Amend a service's descriptive record (history keeps who changed it). */
export const updateService = mutation({
  args: {
    serviceId: v.id("businessServices"),
    name: v.string(),
    description: v.string(),
    department: v.string(),
    ownerUserId: v.id("users"),
    operationalStatus: bcmServiceStatusValidator,
    criticality: bcmCriticalityValidator,
    ictDependencies: v.optional(v.string()),
    keyDependencies: v.string(),
    singlePointsOfFailure: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const service = await requireOwnedService(
      ctx,
      access.organizationId,
      args.serviceId,
    );
    const ownerLabel = await requireActiveMember(
      ctx,
      access.organizationId,
      args.ownerUserId,
      "Service owner",
    );
    await ctx.db.patch(service._id, {
      name: requireTitle(args.name, "Service name"),
      description: requireNarrative(args.description, "Service description"),
      department: requireText(
        args.department,
        "Department or business function",
        DEPARTMENT_MAX,
        2,
      ),
      ownerUserId: args.ownerUserId,
      ownerLabel,
      operationalStatus: args.operationalStatus,
      criticality: args.criticality,
      ictDependencies: optionalText(
        args.ictDependencies,
        "Related ICT systems",
        BCM_TEXT_MAX,
      ),
      keyDependencies: requireNarrative(
        args.keyDependencies,
        "Key operational dependencies",
      ),
      singlePointsOfFailure: optionalText(
        args.singlePointsOfFailure,
        "Single points of failure",
        BCM_TEXT_MAX,
      ),
      updatedAt: Date.now(),
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      serviceId: service._id,
      type: "service_updated",
      fromStatus: service.operationalStatus,
      toStatus: args.operationalStatus,
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Business service ${service.reference} updated`,
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.service_updated",
      entityType: "businessServices",
      entityId: String(service._id),
      summary: `Updated business service ${service.reference}`,
    });
    return { serviceId: service._id };
  },
});
