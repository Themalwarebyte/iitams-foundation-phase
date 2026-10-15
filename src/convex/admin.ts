import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { logAudit, requirePermission } from "./auditAccess";
import { IITAMS_ROLES, permissionsForRole } from "./access";
import {
  MEMBERSHIP_STATUS_LABELS,
  canChangeMembershipStatus,
  effectiveMembershipStatus,
  lastAdminGuardMessage,
} from "../lib/membership";

/**
 * Phase 3A — Administration modules.
 * =========================================================
 * Batch 1: READ-ONLY administrative views, all gated on the existing
 * `admin.view` permission (only the platform `admin` role holds it today).
 *
 * Batch 2A: one administrative mutation — `setMembershipStatus` — gated on
 * `admin.manage`. It changes an ORGANIZATION MEMBERSHIP lifecycle state
 * (never a global user status) with explicit anti-lockout and anti-error
 * guards. Invitations, role editing and provisioning workflows remain
 * explicitly out of scope.
 *
 * Tenant rule (unchanged from the Phase-1 invariant): every function is scoped
 * to the caller's resolved organization. No super-admin bypass is introduced
 * — a cross-organization system-administrator capability does not exist in
 * the access model, so the UI cannot show one either.
 *
 * The log viewer reads the immutable auditLogs table via indexes only and
 * never writes to it (insert-only invariant is untouched).
 */

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/** One reactive query powering the Administration Dashboard tiles. */
export const adminOverview = query({
  args: {},
  handler: async (ctx) => {
    const access = await requirePermission(ctx, "admin.view");
    if (!access.organizationId) return null;

    const [org, profiles, auditCount, pending, recentLogs] = await Promise.all([
      ctx.db.get(access.organizationId),
      ctx.db
        .query("userProfiles")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId!),
        )
        .collect(),
      ctx.db
        .query("auditEngagements")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId!),
        )
        .collect(),
      ctx.db
        .query("correctiveActions")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId!),
        )
        .collect(),
      ctx.db
        .query("auditLogs")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId!),
        )
        .order("desc")
        .take(10),
    ]);

    // Directory members = provisioned profiles in this organization.
    // "Active" is real signal only (lastSeenAt), not an invented fallback.
    const seenRecently = profiles.filter(
      (p) => p.lastSeenAt !== undefined && Date.now() - p.lastSeenAt < 30 * 86_400_000,
    ).length;

    const openPending = pending.filter(
      (a) =>
        a.status === "open" ||
        a.status === "in_progress" ||
        a.status === "not_started" ||
        a.status === "overdue",
    );

    return {
      organization: org
        ? { name: org.name, code: org.code, type: org.type, isDemo: org.isDemo ?? false }
        : null,
      generatedAt: Date.now(),
      directory: {
        totalMembers: profiles.length,
        activeMembers: seenRecently,
      },
      audit: {
        totalEngagements: auditCount.length,
        activeEngagements: auditCount.filter(
          (e) => e.status !== "completed" && e.status !== "cancelled",
        ).length,
      },
      pendingActions: openPending.length,
      recentAdministrativeActivity: recentLogs.map((l) => ({
        id: l._id,
        action: l.action,
        summary: l.summary ?? l.action,
        actor: l.actorLabel ?? "System",
        createdAt: l.createdAt,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// Organizations (tenant-scoped: own organization only)
// ---------------------------------------------------------------------------

/** The caller's own organization record with computed usage counters. */
export const listOrganizations = query({
  args: {},
  handler: async (ctx) => {
    const access = await requirePermission(ctx, "admin.view");
    if (!access.organizationId) return [];

    const org = await ctx.db.get(access.organizationId);
    if (!org) return []; // dangling reference → nothing to show

    const [profiles, engagements] = await Promise.all([
      ctx.db
        .query("userProfiles")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId!),
        )
        .collect(),
      ctx.db
        .query("auditEngagements")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId!),
        )
        .collect(),
    ]);

    return [
      {
        _id: org._id,
        name: org.name,
        code: org.code,
        type: org.type,
        description: org.description,
        isDemo: org.isDemo ?? false,
        createdAt: org.createdAt,
        status: org.isDemo === true ? ("demo" as const) : ("active" as const),
        userCount: profiles.length,
        auditCount: engagements.length,
      },
    ];
  },
});

// ---------------------------------------------------------------------------
// User directory
// ---------------------------------------------------------------------------

interface DirectoryEntry {
  _id: Id<"userProfiles">;
  name: string;
  email: string | null;
  isAnonymous: boolean;
  role: string;
  provisioned: boolean;
  membershipStatus: "active" | "suspended" | "deactivated";
  jobTitle?: string;
  lastSeenAt?: number;
}

/** Read-only user directory for the caller's organization. */
export const listUsers = query({
  args: {},
  handler: async (ctx): Promise<DirectoryEntry[]> => {
    const access = await requirePermission(ctx, "admin.view");
    if (!access.organizationId) return [];

    const profiles = await ctx.db
      .query("userProfiles")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId!),
      )
      .collect();

    const entries: DirectoryEntry[] = [];
    for (const profile of profiles) {
      // Compose the per-user display fields from both identity tables.
      const user = await ctx.db.get(profile.userId);
      entries.push({
        _id: profile._id,
        name: user?.name ?? user?.email ?? "Unnamed user",
        email: user?.email ?? null,
        isAnonymous: user?.isAnonymous === true,
        role: profile.role ?? user?.role ?? "member",
        provisioned: profile.organizationId != null,
        membershipStatus: effectiveMembershipStatus(profile.membershipStatus),
        jobTitle: profile.jobTitle,
        lastSeenAt: profile.lastSeenAt,
      });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  },
});

// ---------------------------------------------------------------------------
// Role registry (visibility only — static data from the access model)
// ---------------------------------------------------------------------------

/** Roles with their effective permission sets, for the read-only roles page. */
export const listRoles = query({
  args: {},
  handler: async (ctx) => {
    // Uniformly gated like every other admin query: the registry ships in the
    // client bundle anyway, but the endpoint stays fail-closed for consistency.
    await requirePermission(ctx, "admin.view");
    return IITAMS_ROLES.map((role) => ({
      role,
      permissions: permissionsForRole(role),
    }));
  },
});

// ---------------------------------------------------------------------------
// Audit log viewer (read-only)
// ---------------------------------------------------------------------------

/**
 * Filterable, read-only audit log viewer for the caller's organization.
 * Supports: action substring, user, date range, and paginated retrieval.
 * The organization filter is structural: the query is always scoped to the
 * caller's own organization, so the UI never offers a cross-tenant picker.
 */
export const listAuditLogs = query({
  args: {
    search: v.optional(v.string()),
    action: v.optional(v.string()),
    userId: v.optional(v.id("users")),
    from: v.optional(v.number()), // epoch ms (inclusive)
    to: v.optional(v.number()), // epoch ms (inclusive)
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "admin.view");
    if (!access.organizationId) return [];

    const limit = Math.min(Math.max(args.limit ?? 200, 1), 500);
    const logs = await ctx.db
      .query("auditLogs")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId!),
      )
      .order("desc")
      .take(limit);

    let rows = logs;
    if (args.action) {
      const needle = args.action.toLowerCase();
      rows = rows.filter((l) => l.action.toLowerCase().includes(needle));
    }
    if (args.userId) rows = rows.filter((l) => l.userId === args.userId);
    if (args.from !== undefined) rows = rows.filter((l) => l.createdAt >= args.from!);
    if (args.to !== undefined) rows = rows.filter((l) => l.createdAt <= args.to!);
    if (args.search) {
      const needle = args.search.toLowerCase();
      rows = rows.filter(
        (l) =>
          (l.summary ?? "").toLowerCase().includes(needle) ||
          (l.actorLabel ?? "").toLowerCase().includes(needle) ||
          l.action.toLowerCase().includes(needle),
      );
    }
    return rows;
  },
});

/** Distinct actions + users seen in the caller's log, for filter dropdowns. */
export const auditLogFacets = query({
  args: {},
  handler: async (ctx) => {
    const access = await requirePermission(ctx, "admin.view");
    if (!access.organizationId) return { actions: [], users: [] };

    const logs = await ctx.db
      .query("auditLogs")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId!),
      )
      .order("desc")
      .take(500);

    const actions = [...new Set(logs.map((l) => l.action))].sort();
    const userIds = [...new Set(logs.map((l) => l.userId).filter((u): u is Id<"users"> => u !== undefined))];

    const users = await Promise.all(
      userIds.map(async (id) => {
        const u = await ctx.db.get(id);
        return u
          ? { id, label: u.name ?? u.email ?? id }
          : null;
      }),
    );

    return {
      actions,
      users: users.filter((u): u is { id: Id<"users">; label: string } => u !== null),
    };
  },
});

// ---------------------------------------------------------------------------
// Batch 2A — membership lifecycle control (admin.manage)
// ---------------------------------------------------------------------------

const membershipStatusArg = v.union(
  v.literal("active"),
  v.literal("suspended"),
  v.literal("deactivated"),
);

const MEMBERSHIP_ACTION: Record<"active" | "suspended" | "deactivated", string> = {
  active: "user.membership_activated",
  suspended: "user.membership_suspended",
  deactivated: "user.membership_deactivated",
};

/**
 * Administer an ORGANIZATION MEMBERSHIP's lifecycle state (Batch 2A).
 *
 * Authorization and safety structure:
 *  - the caller must hold `admin.manage` (fail closed);
 *  - the target profile must belong to the CALLER'S organization (tenant
 *    isolation is re-checked against the resolved org, never trusted from
 *    the client);
 *  - an administrator can never change their OWN membership status (no
 *    self-lockout, no self-escalation);
 *  - the requested transition must be legal per the membership state
 *    machine (src/lib/membership.ts) — no-op writes are rejected;
 *  - the organization's LAST ACTIVE administrator can be suspended or
 *    deactivated only if another active administrator exists;
 *  - every accepted change appends an immutable audit-log entry.
 *
 * Memberships are suspended/deactivated — never deleted. Users and audit
 * histories are untouched.
 */
export const setMembershipStatus = mutation({
  args: {
    profileId: v.id("userProfiles"),
    status: membershipStatusArg,
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "admin.manage");
    if (!access.organizationId || !access.user) {
      throw new Error("No organization context");
    }

    // Tenant isolation: resolve the target and require it to be a REAL,
    // PROVISIONED membership of the caller's own organization. Lookups go
    // by id but the organization match is structural.
    const target = await ctx.db.get(args.profileId);
    if (!target || target.organizationId !== access.organizationId) {
      throw new Error("Member not found in your organization");
    }

    // Anti-lockout / anti-escalation: no administrator changes their own
    // membership status.
    if (target.userId === access.user._id) {
      throw new Error("Administrators cannot change their own membership status");
    }

    const current = effectiveMembershipStatus(target.membershipStatus);
    if (!canChangeMembershipStatus(current, args.status)) {
      throw new Error(
        `Membership is already ${MEMBERSHIP_STATUS_LABELS[current].toLowerCase()} — transition to ${MEMBERSHIP_STATUS_LABELS[args.status].toLowerCase()} is not permitted`,
      );
    }

    // Last-active-administrator guard: suspending or deactivating an active
    // admin must leave at least one other ACTIVE admin in the organization.
    if (
      current === "active" &&
      (target.role ?? undefined) === "admin"
    ) {
      const profiles = await ctx.db
        .query("userProfiles")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId!),
        )
        .collect();
      const otherActiveAdmins = profiles.filter(
        (p) =>
          p._id !== target._id &&
          p.role === "admin" &&
          effectiveMembershipStatus(p.membershipStatus) === "active",
      );
      if (otherActiveAdmins.length === 0) {
        throw new Error(lastAdminGuardMessage());
      }
    }

    await ctx.db.patch(target._id, { membershipStatus: args.status });

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: target.userId,
      actorLabel: access.user.name ?? access.user.email ?? "Administrator",
      action: MEMBERSHIP_ACTION[args.status],
      entityType: "userProfiles",
      entityId: target._id,
      summary: `Membership ${args.status === "active" ? "reactivated" : args.status} for ${
        MEMBERSHIP_STATUS_LABELS[args.status]
      } member by administrator`,
    });

    return { ok: true, status: args.status };
  },
});
