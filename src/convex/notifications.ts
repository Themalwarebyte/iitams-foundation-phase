import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  getActiveOrganizationId,
  getCurrentUserOrNull,
} from "./access";

/** Notifications visible to the current user (org-wide + personal). */
export const listForUser = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];
    const organizationId = await getActiveOrganizationId(ctx);

    const personal = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(30);

    const orgWide = organizationId
      ? await ctx.db
          .query("notifications")
          .withIndex("by_organization", (q) =>
            q.eq("organizationId", organizationId),
          )
          .order("desc")
          .take(30)
      : [];

    const seen = new Set<string>();
    const merged = [...personal, ...orgWide].filter((n) => {
      if (seen.has(n._id)) return false;
      seen.add(n._id);
      return true;
    });

    return merged
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 25)
      .map((n) => ({
        id: n._id,
        title: n.title,
        body: n.body ?? null,
        severity: n.severity,
        href: n.href ?? null,
        readAt: n.readAt ?? null,
        createdAt: n.createdAt,
      }));
  },
});

/** Mark a notification as read (no-op if already read or not found). */
export const markRead = mutation({
  args: { id: v.id("notifications") },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Not authenticated");
    const existing = await ctx.db.get(args.id);
    if (!existing) return;
    await ctx.db.patch(args.id, { readAt: Date.now() });
  },
});

/** Mark all of the current user's notifications as read. */
export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Not authenticated");
    const organizationId = await getActiveOrganizationId(ctx);
    const personal = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const orgWide = organizationId
      ? await ctx.db
          .query("notifications")
          .withIndex("by_organization", (q) =>
            q.eq("organizationId", organizationId),
          )
          .collect()
      : [];
    const now = Date.now();
    for (const n of [...personal, ...orgWide]) {
      if (n.readAt === undefined) {
        await ctx.db.patch(n._id, { readAt: now });
      }
    }
  },
});

/** Append an entry to the immutable audit log. */
export const logAction = mutation({
  args: {
    organizationId: v.optional(v.id("organizations")),
    action: v.string(),
    entityType: v.string(),
    entityId: v.optional(v.string()),
    summary: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    const organizationId =
      args.organizationId ?? (await getActiveOrganizationId(ctx)) ?? undefined;
    await ctx.db.insert("auditLogs", {
      organizationId,
      userId: user?._id,
      actorLabel: user?.name ?? user?.email ?? "Anonymous",
      action: args.action,
      entityType: args.entityType,
      entityId: args.entityId,
      summary: args.summary,
      createdAt: Date.now(),
    });
  },
});
