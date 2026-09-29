import { getAuthUserId } from "@convex-dev/auth/server";
import { QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";

/**
 * IITAMS access control (Phase-1 final)
 * =====================================
 * Invariants (all fail closed):
 *
 *  1. ROLE comes from an explicit validated `role` field on `userProfiles`
 *     (falling back to the auth user's role). Roles are NEVER inferred from
 *     permission strings.
 *  2. ORGANIZATION comes ONLY from an explicit `userProfile.organizationId`.
 *     There is NO fallback to "the first organization" — an unprovisioned
 *     user gets no organization context, no permissions, and no tenant data.
 *  3. GUESTS (anonymous users) resolve only when IITAMS_ALLOW_GUEST_AUTH=true,
 *     and may only attach to an organization explicitly flagged `isDemo`.
 *     A real organization is never selected as a guest fallback.
 *  4. Client permission checks are UX only; server checks are authoritative.
 */

// ---------------------------------------------------------------------------
// Role registry — Phase 2 adds the formal audit-workflow roles from the
// IITAMS specification (audit director / manager / auditor / reviewer /
// management user / executive viewer). Unknown roles continue to fail closed.
// NOTE: engagement-level authority is additionally constrained by audit team
// assignments (src/convex/auditAccess.ts) — a role grants module capability,
// an assignment grants the right to touch a specific engagement.
// ---------------------------------------------------------------------------
export const IITAMS_ROLES = [
  // Platform roles (Phase 1)
  "admin",
  "user",
  "member",
  // Audit workflow roles (Phase 2)
  "audit_director",
  "audit_manager",
  "auditor",
  "audit_reviewer",
  "management_user",
  "executive_viewer",
] as const;
export type IitamsRole = (typeof IITAMS_ROLES)[number];

export type IitamsPermission =
  // Overview
  | "dashboard.view"
  | "workspace.view"
  // Audit Management
  | "audit.view"
  | "audit.manage"
  // ICT Risk
  | "risk.view"
  | "risk.manage"
  // Compliance
  | "compliance.view"
  | "compliance.manage"
  // Cybersecurity Assurance
  | "cyber.view"
  | "cyber.manage"
  // Business Continuity
  | "bcm.view"
  | "bcm.manage"
  // Reports & Analytics
  | "reports.view"
  // Administration
  | "admin.view"
  | "admin.manage";

const OPERATIONAL_VIEW: IitamsPermission[] = [
  "dashboard.view",
  "workspace.view",
  "audit.view",
  "risk.view",
  "compliance.view",
  "cyber.view",
  "bcm.view",
  "reports.view",
];

const ROLE_PERMISSIONS: Record<IitamsRole, IitamsPermission[]> = {
  admin: [
    ...OPERATIONAL_VIEW,
    "audit.manage",
    "risk.manage",
    "compliance.manage",
    "cyber.manage",
    "bcm.manage",
    "admin.view",
    "admin.manage",
  ],
  user: [...OPERATIONAL_VIEW, "audit.manage", "risk.manage"],
  member: [...OPERATIONAL_VIEW],
  // --- Phase 2 audit workflow roles -------------------------------------
  // Audit Director: full audit oversight across the lifecycle.
  audit_director: [
    "dashboard.view",
    "workspace.view",
    "audit.view",
    "audit.manage",
    "reports.view",
  ],
  // Audit Manager: manages engagements, teams and the audit programme.
  audit_manager: [
    "dashboard.view",
    "workspace.view",
    "audit.view",
    "audit.manage",
    "reports.view",
  ],
  // Auditor: performs assigned engagement work (assignments gate the
  // engagement-level authority; see src/convex/auditAccess.ts).
  auditor: ["dashboard.view", "workspace.view", "audit.view"],
  // Audit Reviewer: reviews/approves working papers and findings.
  audit_reviewer: ["dashboard.view", "workspace.view", "audit.view"],
  // Management User: views audit output, responds to findings and owns
  // corrective actions.
  management_user: ["dashboard.view", "workspace.view", "audit.view", "reports.view"],
  // Executive Viewer: dashboards and reports only.
  executive_viewer: ["dashboard.view", "reports.view"],
};

export function roleHasPermission(
  role: IitamsRole | undefined,
  permission: IitamsPermission,
): boolean {
  if (!role) return false; // no role / unknown role → deny (fail closed)
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

// ---------------------------------------------------------------------------
// Identity / tenancy resolution
// ---------------------------------------------------------------------------

export async function getCurrentUserOrNull(
  ctx: QueryCtx,
): Promise<Doc<"users"> | null> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return null;
  return await ctx.db.get(userId);
}

/** Guest (anonymous) sign-in policy — see module docblock. */
export function guestAuthEnabled(): boolean {
  return process.env.IITAMS_ALLOW_GUEST_AUTH === "true";
}

export interface AccessContext {
  user: Doc<"users"> | null;
  /** Effective role; undefined when access must be denied. */
  role: IitamsRole | undefined;
  /** Explicit organization (never a fallback); null when unprovisioned. */
  organizationId: Id<"organizations"> | null;
  /** True when the resolved organization is an explicitly flagged demo org. */
  organizationIsDemo: boolean;
  /** True for anonymous users admitted under the development guest policy. */
  isGuest: boolean;
  /** False when the user is authenticated but has no provisioned org. */
  isProvisioned: boolean;
}

/**
 * Single resolution point for identity + tenancy + role. Denial reasons are
 * explicit so callers can surface precise states (e.g. "awaiting
 * provisioning") instead of silent fallbacks.
 */
export async function resolveAccess(ctx: QueryCtx): Promise<AccessContext> {
  const user = await getCurrentUserOrNull(ctx);
  if (!user) {
    return {
      user: null,
      role: undefined,
      organizationId: null,
      organizationIsDemo: false,
      isGuest: false,
      isProvisioned: false,
    };
  }

  const isGuest = user.isAnonymous === true;
  if (isGuest && !guestAuthEnabled()) {
    // Production: anonymous users resolve nothing at all.
    return {
      user,
      role: undefined,
      organizationId: null,
      organizationIsDemo: false,
      isGuest: true,
      isProvisioned: false,
    };
  }

  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("userId", (q) => q.eq("userId", user._id))
    .unique();

  // Role: explicit validated field only (never inferred from permission
  // strings). Unknown values fail closed to undefined.
  const rawRole = profile?.role ?? user.role;
  let role = IITAMS_ROLES.includes(rawRole as IitamsRole)
    ? (rawRole as IitamsRole)
    : undefined;

  // Organization: ONLY an explicit profile assignment. No first-org fallback.
  let organizationId: Id<"organizations"> | null =
    profile?.organizationId ?? null;
  let organizationIsDemo = false;

  if (organizationId) {
    const org = await ctx.db.get(organizationId);
    if (!org) {
      organizationId = null; // dangling reference → deny
    } else {
      organizationIsDemo = org.isDemo === true;
      // Guests may ONLY attach to explicitly demo-flagged organizations.
      if (isGuest && !organizationIsDemo) {
        organizationId = null;
        organizationIsDemo = false;
      }
    }
  } else if (isGuest && guestAuthEnabled()) {
    // Development guest bootstrap: pick a demo-flagged organization only.
    const demoOrg = await ctx.db
      .query("organizations")
      .withIndex("code", (q) => q.eq("code", "IITAMS-DEMO"))
      .unique();
    if (demoOrg && demoOrg.isDemo === true) {
      organizationId = demoOrg._id;
      organizationIsDemo = true;
    }
  }

  // Guest policy: an anonymous session attached to the demo organization is
  // granted the read-only "member" tier when no explicit role exists. This
  // NEVER applies to real users — unprovisioned/unroled real users stay
  // undefined (deny) until an administrator assigns them a role.
  if (isGuest && organizationId !== null && role === undefined) {
    role = "member";
  }

  return {
    user,
    role,
    organizationId,
    organizationIsDemo,
    isGuest,
    isProvisioned: organizationId !== null,
  };
}

/** Effective role for the caller (undefined = deny). */
export async function getEffectiveRole(
  ctx: QueryCtx,
): Promise<IitamsRole | undefined> {
  return (await resolveAccess(ctx)).role;
}

/**
 * Active organization for the caller. Returns null unless the user has an
 * explicit valid profile assignment (guests: an explicitly demo org).
 */
export async function getActiveOrganizationId(
  ctx: QueryCtx,
): Promise<Id<"organizations"> | null> {
  return (await resolveAccess(ctx)).organizationId;
}
