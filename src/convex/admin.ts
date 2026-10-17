import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { logAudit, requirePermission } from "./auditAccess";
import {
  countActiveAdministrators,
  hasPendingAdministratorGrant,
} from "./adminLifecycle";
import { applyInitialMembership } from "./membershipCore";
import { IITAMS_ROLES, permissionsForRole } from "./access";
import {
  DIRECTORY_ROW_LIMIT,
  MEMBERSHIP_STATUS_LABELS,
  PROVISIONABLE_INITIAL_ROLES,
  canChangeMembershipStatus,
  effectiveMembershipStatus,
  lastAdminGuardMessage,
  provisioningSafeRefusal,
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
  /** Row creation time (from the profile document) — used by the directory's
   * bounded render window so newly provisioned members are never hidden by
   * an activity recency cut. */
  createdAt: number;
}

/**
 * Read-only user directory for the caller's organization.
 *
 * BOUNDED BY DESIGN. The shared demo organization accumulates thousands of
 * profiles, and a full-table collect plus one identity lookup per row exceeded
 * Convex's per-function read budget (it started returning "too many system
 * operations" and the directory — and anything waiting on it — stalled).
 * The query therefore pages the organization index newest-first and returns at
 * most `limit` rows (default and max `DIRECTORY_ROW_LIMIT`), which always
 * includes memberships created or updated most recently. Small organizations
 * are unaffected: they still receive their complete directory.
 *
 * Identity lookups for the page run in PARALLEL; profile reads + user reads
 * stay far below the function read budget.
 */
export const listUsers = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<DirectoryEntry[]> => {
    const access = await requirePermission(ctx, "admin.view");
    if (!access.organizationId) return [];

    const requested = Math.floor(args.limit ?? DIRECTORY_ROW_LIMIT);
    const limit = Math.max(1, Math.min(DIRECTORY_ROW_LIMIT, requested));

    const page = await ctx.db
      .query("userProfiles")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId!),
      )
      .order("desc")
      .take(limit);

    const users = await Promise.all(
      page.map((profile) => ctx.db.get(profile.userId)),
    );
    const entries: DirectoryEntry[] = page.map((profile, i) => {
      const user = users[i];
      return {
        _id: profile._id,
        name: user?.name ?? user?.email ?? "Unnamed user",
        email: user?.email ?? null,
        isAnonymous: user?.isAnonymous === true,
        role: profile.role ?? user?.role ?? "member",
        provisioned: profile.organizationId != null,
        membershipStatus: effectiveMembershipStatus(profile.membershipStatus),
        jobTitle: profile.jobTitle,
        lastSeenAt: profile.lastSeenAt,
        createdAt: profile._creationTime,
      };
    });
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

    // Last-active-administrator guard — ONE shared server-side helper
    // (countActiveAdministrators in adminLifecycle.ts) is used for EVERY
    // transition that can remove the org's last effective administrator
    // (suspend, deactivate, revoke). The count excludes admin profiles
    // whose trusted demo-role grant has already expired, so an expired
    // grant never qualifies as the "remaining" administrator that would
    // let a suspension/deactivation strand the organization.
    if (
      current === "active" &&
      (target.role ?? undefined) === "admin" &&
      (await countActiveAdministrators(ctx, access.organizationId!, target._id)) === 0
    ) {
      throw new Error(lastAdminGuardMessage());
    }

    await ctx.db.patch(target._id, { membershipStatus: args.status });

    // Audit integrity: the entry separates the ACTOR (administrative caller,
    // actorId/actorLabel) from the TARGET (the affected member, userId and
    // their display label in the human-readable summary).
    const targetUser = await ctx.db.get(target.userId);
    const targetLabel = targetUser?.name ?? targetUser?.email ?? "Unknown member";
    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: target.userId,
      actorId: access.user._id,
      actorLabel: access.user.name ?? access.user.email ?? "Administrator",
      action: MEMBERSHIP_ACTION[args.status],
      entityType: "userProfiles",
      entityId: target._id,
      summary: `${targetLabel}'s membership ${args.status === "active" ? "reactivated" : args.status} by administrator`,
    });

    return { ok: true, status: args.status };
  },
});

// ---------------------------------------------------------------------------
// Batch 2B — administrative member provisioning (admin.manage)
// ---------------------------------------------------------------------------

/** Initial role is validated against the registered RBAC roles, excluding the
 * privileged platform admin role (Batch 2B restriction). */
const initialRoleArg = v.union(...PROVISIONABLE_INITIAL_ROLES.map((r) => v.literal(r)));

/**
 * Provision an EXISTING, VERIFIED IITAMS account into the caller's
 * organization with an explicitly selected initial role (Batch 2B).
 *
 * Security structure (all server-side; the UI is never authoritative):
 *  - caller must hold `admin.manage` and resolve an ACTIVE membership;
 *  - the organization comes ONLY from the server-side access context —
 *    there is no client-supplied organization argument (no cross-tenant
 *    provisioning, no transfers);
 *  - the target is resolved through their VERIFIED EMAIL identity in the
 *    existing Convex Auth user table (indexed lookup). No accounts are
 *    created, no OTP verification is bypassed, no email is marked verified;
 *  - anonymous (guest) accounts and accounts whose email is not verified are
 *    refused;
 *  - the platform `admin` role is NOT assignable here (separate later flow);
 *    unknown roles are rejected by the typed validator itself;
 *  - users with ANY existing organization membership (active, suspended or
 *    deactivated, in ANY organization) are refused with a UNIFORM safe
 *    message that never discloses cross-organization membership data;
 *  - an existing userProfiles row WITHOUT an organization assignment is
 *    completed in place (no duplicate profiles — one profile per user via
 *    the userId index); a row that already carries a role is refused for
 *    manual review rather than silently overwritten;
 *  - the caller can never provision their own email (anti self-provisioning;
 *    also covered by the existing-membership refusal);
 *  - writes are a single transaction: concurrent duplicate requests see the
 *    first result and refuse (atomic under Convex serialization);
 *  - global auth-owned user fields are never modified, and role assignment
 *    is written to the organization-scoped userProfiles.role only.
 */
export const provisionMember = mutation({
  args: {
    email: v.string(),
    initialRole: initialRoleArg,
    jobTitle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "admin.manage");
    if (!access.organizationId || !access.user) {
      throw new Error("No organization context");
    }
    if (!access.isProvisioned) {
      throw new Error("Caller membership is not active");
    }

    // Canonical email identity (Convex Auth stores identifiers lower-cased).
    const email = args.email.trim().toLowerCase();
    if (!email.includes("@")) {
      throw new Error("Enter a valid email address");
    }

    // Resolve the target through the existing identity system. This tells the
    // administrator only that the address is or is not a provisionable,
    // verified account — never its membership state in another organization.
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .unique();
    if (
      !user ||
      user.isAnonymous === true ||
      !user.emailVerificationTime
    ) {
      throw new Error(provisioningSafeRefusal());
    }

    // No self-provisioning (the caller is by definition already a member).
    if (user._id === access.user._id) {
      throw new Error(provisioningSafeRefusal());
    }

    // NOTE (Batch 2C): the profile-write rules now live in ONE shared helper
    // (src/convex/membershipCore.ts) that invitation acceptance also uses,
    // so both paths keep identical membership invariants and refusals.
    await applyInitialMembership(ctx, {
      user,
      organizationId: access.organizationId,
      initialRole: args.initialRole,
      ...(args.jobTitle !== undefined ? { jobTitle: args.jobTitle } : {}),
      preserveExistingJobTitle: false,
      conflictRefusal: provisioningSafeRefusal,
    });

    const storedProfile = (await ctx.db
      .query("userProfiles")
      .withIndex("userId", (q) => q.eq("userId", user._id))
      .unique())!;

    const targetLabel = user.name ?? user.email;

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: user._id,
      actorId: access.user._id,
      actorLabel: access.user.name ?? access.user.email ?? "Administrator",
      action: "user.membership_provisioned",
      entityType: "userProfiles",
      entityId: storedProfile._id,
      summary: `${targetLabel} provisioned into the organization with initial role ${args.initialRole} by administrator`,
    });

    return { ok: true, profileId: storedProfile._id, role: args.initialRole };
  },
});

// ---------------------------------------------------------------------------
// Batch A2 — routine administrator role management (admin.manage)
// ---------------------------------------------------------------------------

/**
 * Change an ACTIVE member's ordinary organization role (Batch A2).
 *
 * This is ROUTINE administrator management — distinct from the exceptional,
 * operator-controlled recovery described in docs/ADMINISTRATOR_RECOVERY.md.
 *
 * Security structure (server-side; the UI is never authoritative):
 *  - caller must hold `admin.manage` and resolve an ACTIVE membership;
 *  - the organization comes only from the access context — the target is
 *    resolved by id and re-checked against that organization (no tenant
 *    crossing, no transfers);
 *  - an administrator can never change their OWN role (no self-escalation,
 *    no self-lockout);
 *  - target memberships must be ACTIVE — suspended/deactivated rows are
 *    managed through the membership lifecycle first;
 *  - the privileged `admin` role is excluded in BOTH directions: rows that
 *    already hold it are refused (use revoke/grant), and it can never be the
 *    requested role. The typed validator rejects any non-ordinary role;
 *  - a no-op request (same role) is refused instead of writing;
 *  - a member with an UNEXPIRED PENDING administrator grant is refused: the
 *    queued grant records the role to restore on revocation, and changing the
 *    role underneath it would make that restoration stale. Neither grant nor
 *    invitation rows are ever modified here;
 *  - the write is a single transaction and appends one immutable audit entry
 *    separating the ACTOR from the TARGET (with previous → new role).
 *
 * Two-step administrator grants and invitation flows are untouched by this
 * mutation: an accepted administrator grant keeps restoring its recorded
 * `previousRole`, and pending invitations keep their own recorded role.
 */
export const changeMemberRole = mutation({
  args: {
    profileId: v.id("userProfiles"),
    role: initialRoleArg,
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "admin.manage");
    if (!access.organizationId || !access.user) {
      throw new Error("No organization context");
    }
    if (!access.isProvisioned) {
      throw new Error("Caller membership is not active");
    }

    // Tenant isolation: id lookup, but the organization match is structural.
    const target = await ctx.db.get(args.profileId);
    if (!target || target.organizationId !== access.organizationId) {
      throw new Error("Member not found in your organization");
    }

    if (target.userId === access.user._id) {
      throw new Error("Administrators cannot change their own role");
    }

    const current = effectiveMembershipStatus(target.membershipStatus);
    if (current !== "active") {
      throw new Error(
        `Membership is ${MEMBERSHIP_STATUS_LABELS[current].toLowerCase()} — reactivate it before changing the role`,
      );
    }

    // Administrator status is governed by the two-step lifecycle, never by
    // this routine role editor (anti self-escalation / anti-lockout).
    if (target.role === "admin") {
      throw new Error(
        "Administrator roles are managed through the administrator lifecycle (grant/revoke), not the role editor",
      );
    }
    if (target.role === args.role) {
      throw new Error("The member already holds that role");
    }
    if (!(PROVISIONABLE_INITIAL_ROLES as readonly string[]).includes(args.role)) {
      throw new Error("That role cannot be assigned here");
    }

    // A queued administrator promotion records the role to restore if it is
    // later revoked. Editing the role underneath it would make that recorded
    // restoration stale, so the pending grant must be resolved first: this
    // mutation never touches grant or invitation rows.
    if (
      await hasPendingAdministratorGrant(
        ctx,
        access.organizationId,
        target.userId,
      )
    ) {
      throw new Error(
        "An administrator grant is pending for this member — resolve it (or cancel it) before changing their role",
      );
    }

    const previousRole = target.role ?? "member";
    await ctx.db.patch(target._id, { role: args.role });

    const targetUser = await ctx.db.get(target.userId);
    const targetLabel = targetUser?.name ?? targetUser?.email ?? "Unknown member";
    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: target.userId,
      actorId: access.user._id,
      actorLabel: access.user.name ?? access.user.email ?? "Administrator",
      action: "admin.member_role_changed",
      entityType: "userProfiles",
      entityId: target._id,
      summary: `${targetLabel}'s role changed from ${previousRole} to ${args.role} by administrator`,
    });

    return { ok: true, role: args.role, previousRole };
  },
});
