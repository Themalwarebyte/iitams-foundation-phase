import { getAuthUserId } from "@convex-dev/auth/server";
import { QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";

/**
 * Permission model (Phase 1 scope)
 * --------------------------------
 * - `admin`  : full access to every module and administration functions
 * - `user`   : all operational modules (audit, risk, compliance, cyber, BCM)
 * - `member` / demo accounts : read-only operational modules, no administration
 *
 * Permission-aware navigation on the client maps onto this same model via
 * `src/lib/permissions.ts` so users only see modules they can actually open.
 */
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

const ROLE_PERMISSIONS: Record<RoleName, IitamsPermission[]> = {
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
};

type RoleName = "admin" | "user" | "member";
type Role = RoleName | undefined;

/**
 * Guest (anonymous) sign-in policy
 * --------------------------------
 * Guest login is a development convenience ONLY. It is disabled for all
 * server-side authorization when the deployment is marked production via the
 * `IITAMS_ALLOW_GUEST_AUTH` deployment variable (set with
 * `npx convex env set IITAMS_ALLOW_GUEST_AUTH false` — default is disabled).
 *
 * Anonymous users therefore fail every permission check in production and can
 * reach no protected data; in development (variable explicitly "true") they
 * resolve to the read-only `member` role so demo environments work.
 */
export function guestAuthEnabled(): boolean {
  return process.env.IITAMS_ALLOW_GUEST_AUTH === "true";
}

export async function getCurrentUserOrNull(
  ctx: QueryCtx,
): Promise<Doc<"users"> | null> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return null;
  return await ctx.db.get(userId);
}

/**
 * Resolve the acting user's role. Provisioned profiles may override the auth
 * role; everything else falls back to the auth table's role field.
 */
export async function getEffectiveRole(ctx: QueryCtx): Promise<Role> {
  const user = await getCurrentUserOrNull(ctx);
  if (!user) return undefined;

  // Production-safe guest policy: anonymous users only resolve a role when
  // guest auth is explicitly enabled on the deployment (development).
  if (user.isAnonymous === true && !guestAuthEnabled()) {
    return undefined; // fail closed — every permission check denies
  }

  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("userId", (q) => q.eq("userId", user._id))
    .unique();
  return (profile?.permissions?.[0] as Role | undefined) ?? user.role ?? "member";
}

export function roleHasPermission(
  role: Role,
  permission: IitamsPermission,
): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/**
 * Active organization for the current user. Falls back to the first seeded
 * organization so demo environments work out of the box.
 */
export async function getActiveOrganizationId(
  ctx: QueryCtx,
): Promise<Id<"organizations"> | null> {
  const user = await getCurrentUserOrNull(ctx);
  if (user) {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("userId", (q) => q.eq("userId", user._id))
      .unique();
    if (profile?.organizationId) return profile.organizationId;
  }
  const first = await ctx.db.query("organizations").first();
  return first?._id ?? null;
}
