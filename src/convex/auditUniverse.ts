import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  classificationValidator,
  criticalityLevelValidator,
  severityValidator,
  universeCategoryValidator,
  universeItemStatusValidator,
} from "./schema";
import { requirePermission, logAudit } from "./auditAccess";

/**
 * Module 1 — Audit Universe Management.
 * Central repository of auditable ICT entities. All reads and writes are
 * organization-scoped through resolveAccess; create/update/archive require
 * `audit.manage` and write an entry to the immutable audit log.
 */

/** Filterable, searchable, sortable list (Module 1 capabilities). */
export const list = query({
  args: {
    search: v.optional(v.string()),
    category: v.optional(universeCategoryValidator),
    status: v.optional(universeItemStatusValidator),
    criticality: v.optional(criticalityLevelValidator),
    classification: v.optional(classificationValidator),
    sort: v.optional(
      v.union(
        v.literal("name"),
        v.literal("createdAt"),
        v.literal("criticality"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.view");
    if (!access.organizationId) return [];

    let rows = await ctx.db
      .query("auditUniverseItems")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId!),
      )
      .collect();

    if (args.status) rows = rows.filter((r) => (r.status ?? "active") === args.status);
    if (args.category) rows = rows.filter((r) => r.category === args.category);
    if (args.criticality) rows = rows.filter((r) => r.criticality === args.criticality);
    if (args.classification)
      rows = rows.filter((r) => r.dataClassification === args.classification);

    if (args.search) {
      const q = args.search.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.code.toLowerCase().includes(q) ||
          (r.description ?? "").toLowerCase().includes(q) ||
          (r.owner ?? "").toLowerCase().includes(q) ||
          (r.businessUnit ?? "").toLowerCase().includes(q),
      );
    }

    const sort = args.sort ?? "name";
    rows.sort((a, b) => {
      if (sort === "createdAt") return b.createdAt - a.createdAt;
      if (sort === "criticality") {
        const order = ["very_low", "low", "medium", "high", "very_high"];
        return (
          (order.indexOf(b.criticality ?? "medium") -
            order.indexOf(a.criticality ?? "medium"))
        );
      }
      return a.name.localeCompare(b.name);
    });

    return rows;
  },
});

/** Single item (tenant-scoped; other organizations' ids read as absent). */
export const get = query({
  args: { id: v.id("auditUniverseItems") },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.view");
    if (!access.organizationId) return null;
    const item = await ctx.db.get(args.id);
    if (!item || item.organizationId !== access.organizationId) return null;
    return item;
  },
});

/** Audit history for one item — entries from the immutable log. */
export const history = query({
  args: { id: v.id("auditUniverseItems") },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.view");
    if (!access.organizationId) return [];
    const item = await ctx.db.get(args.id);
    if (!item || item.organizationId !== access.organizationId) return [];
    const logs = await ctx.db
      .query("auditLogs")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId!),
      )
      .order("desc")
      .take(200);
    return logs.filter(
      (l) => l.entityType === "auditUniverseItems" && l.entityId === args.id,
    );
  },
});

/** Create an audit universe item (requires audit.manage). */
export const create = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    category: universeCategoryValidator,
    owner: v.optional(v.string()),
    businessUnit: v.optional(v.string()),
    technologyType: v.optional(v.string()),
    criticality: criticalityLevelValidator,
    businessImpact: v.optional(v.string()),
    dataClassification: classificationValidator,
    regulatoryImportance: criticalityLevelValidator,
    securityExposure: v.optional(criticalityLevelValidator),
    inherentRisk: severityValidator,
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.manage");
    if (!access.organizationId) throw new Error("No organization context");

    const existing = await ctx.db
      .query("auditUniverseItems")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId!),
      )
      .collect();
    const code = `AU-${String(existing.length + 1).padStart(3, "0")}`;
    const now = Date.now();

    const id = await ctx.db.insert("auditUniverseItems", {
      organizationId: access.organizationId,
      code,
      name: args.name,
      domain: args.category, // Phase-1 field mirrored from category
      inherentRisk: args.inherentRisk,
      description: args.description,
      category: args.category,
      owner: args.owner,
      businessUnit: args.businessUnit,
      technologyType: args.technologyType,
      criticality: args.criticality,
      businessImpact: args.businessImpact,
      dataClassification: args.dataClassification,
      regulatoryImportance: args.regulatoryImportance,
      securityExposure: args.securityExposure,
      status: "active",
      createdById: access.user?._id,
      createdAt: now,
      updatedAt: now,
    });

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? access.user?.email ?? undefined,
      action: "universe_item.created",
      entityType: "auditUniverseItems",
      entityId: id,
      summary: `${code} ${args.name} added to the audit universe`,
    });

    return { id, code };
  },
});

/** Update an audit universe item (requires audit.manage). */
export const update = mutation({
  args: {
    id: v.id("auditUniverseItems"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    category: v.optional(universeCategoryValidator),
    owner: v.optional(v.string()),
    businessUnit: v.optional(v.string()),
    technologyType: v.optional(v.string()),
    criticality: v.optional(criticalityLevelValidator),
    businessImpact: v.optional(v.string()),
    dataClassification: v.optional(classificationValidator),
    regulatoryImportance: v.optional(criticalityLevelValidator),
    securityExposure: v.optional(criticalityLevelValidator),
    inherentRisk: v.optional(severityValidator),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.manage");
    if (!access.organizationId) throw new Error("No organization context");

    const item = await ctx.db.get(args.id);
    if (!item || item.organizationId !== access.organizationId) {
      throw new Error("Audit universe item not found");
    }

    const { id, ...fields } = args;
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [k, val] of Object.entries(fields)) {
      if (val !== undefined) patch[k] = val;
    }
    if (patch.category) patch.domain = patch.category;

    await ctx.db.patch(args.id, patch);

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? access.user?.email ?? undefined,
      action: "universe_item.updated",
      entityType: "auditUniverseItems",
      entityId: args.id,
      summary: `${item.code} ${patch.name ?? item.name} updated`,
    });

    return { ok: true };
  },
});

/** Archive / restore an item (soft lifecycle; records are never destroyed). */
export const setStatus = mutation({
  args: {
    id: v.id("auditUniverseItems"),
    status: universeItemStatusValidator,
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.manage");
    if (!access.organizationId) throw new Error("No organization context");

    const item = await ctx.db.get(args.id);
    if (!item || item.organizationId !== access.organizationId) {
      throw new Error("Audit universe item not found");
    }

    await ctx.db.patch(args.id, {
      status: args.status,
      updatedAt: Date.now(),
    });

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? access.user?.email ?? undefined,
      action:
        args.status === "archived"
          ? "universe_item.archived"
          : "universe_item.status_changed",
      entityType: "auditUniverseItems",
      entityId: args.id,
      summary: `${item.code} ${item.name} → ${args.status}`,
    });

    return { ok: true };
  },
});
