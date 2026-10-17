import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api, internal } from "../src/convex/_generated/api";

/**
 * Batch A2 — routine role management + operator recovery boundary
 * =================================================================
 * Verifies the real deployed boundary, not just source text:
 *
 *  1. an administrator holding `admin.manage` can change an ACTIVE member's
 *     ordinary role, and the change is reflected in the directory, the
 *     member's own resolved session/permissions and the audit trail
 *     (actor separated from target, previous → new role recorded);
 *  2. the privileged `admin` role is excluded in both directions, no-op
 *     changes are refused, suspended memberships must be reactivated first,
 *     self-changes and non-administrator callers are refused;
 *  3. the exceptional last-administrator recovery exists ONLY as an internal
 *     mutation (never reachable from a client), is opt-in via
 *     `IITAMS_RECOVERY_ENABLED`, and refuses while an effective administrator
 *     remains;
 *  4. invitation flows and the one-time bootstrap are untouched.
 */

const CONVEX_URL = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const HARNESS = process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";

function testerToken(): string {
  const fromEnv = process.env.IITAMS_TESTER_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    return readFileSync(join(process.cwd(), ".iitams-tester-token"), "utf8").trim();
  } catch {
    return "";
  }
}

const token = testerToken();
const harnessConfigured = Boolean(token);

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CONVEX_URL}/api/query`);
    return res.status < 600;
  } catch {
    return false;
  }
}

async function signInAnonymous(): Promise<ConvexHttpClient> {
  const guest = new ConvexHttpClient(CONVEX_URL);
  const result = (await (guest as unknown as {
    action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
  }).action(api.auth.signIn, { provider: "anonymous", params: {} })) as {
    tokens?: { token?: string; accessToken?: string };
  };
  const jwt = result.tokens?.token ?? result.tokens?.accessToken;
  if (jwt) (guest as unknown as { setAuth: (v: string) => void }).setAuth(jwt);
  return guest;
}

async function harnessGrantAdmin(userId: string): Promise<boolean> {
  const res = await fetch(`${HARNESS}/api/dev-grant-demo-role`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-iitams-tester-token": token,
    },
    body: JSON.stringify({ userId, role: "admin", ttlMinutes: 120 }),
  });
  return res.ok;
}

async function seedVerifiedIdentity(email: string): Promise<boolean> {
  const res = await fetch(`${HARNESS}/api/dev-seed-test-user`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-iitams-tester-token": token,
    },
    body: JSON.stringify({ email }),
  });
  return res.ok;
}

async function signInEmailOtp(email: string): Promise<ConvexHttpClient | null> {
  const c = new ConvexHttpClient(CONVEX_URL);
  try {
    await (c as unknown as {
      action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
    }).action(api.auth.signIn, { provider: "email-otp", params: { email } });
    let code: string | null = null;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      const res = await fetch(`${HARNESS}/api/dev-otp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-iitams-tester-token": token,
        },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        const data = (await res.json()) as { code?: string };
        if (data.code && /^\d{6}$/.test(data.code)) {
          code = data.code;
          break;
        }
      }
    }
    if (!code) return null;
    const finished = (await (c as unknown as {
      action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
    }).action(api.auth.signIn, {
      provider: "email-otp",
      params: { email, code },
    })) as { tokens?: { token?: string; accessToken?: string } };
    const jwt = finished.tokens?.token ?? finished.tokens?.accessToken;
    if (jwt) (c as unknown as { setAuth: (v: string) => void }).setAuth(jwt);
    return c;
  } catch {
    return null;
  }
}

/** Explicit fixture registry: cleanup/revert only ever targets ids this file
 * created through the trusted harness. */
const fixtureUserIds = new Set<string>();

async function adminClientWithGrant(): Promise<ConvexHttpClient | null> {
  const admin = await signInAnonymous();
  await admin.mutation(api.session.joinDemoOrganization, {});
  const session = (await admin.query(api.session.getSession, {})) as {
    userId?: string;
  } | null;
  if (!session?.userId) return null;
  if (!(await harnessGrantAdmin(session.userId))) return null;
  fixtureUserIds.add(session.userId);
  return admin;
}

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 99999)}`;

type DirectoryRow = {
  _id: string;
  name: string;
  email: string | null;
  role: string;
  isAnonymous?: boolean;
  membershipStatus: string;
  provisioned?: boolean;
};

type Session = {
  userId?: string;
  role?: string | null;
  permissions?: { auditManage?: boolean };
} | null;

// ============================================================================
// Structural guards (no deployment required)
// ============================================================================

describe("Batch A2 — role management structural guards", () => {
  const adminSrc = readFileSync("src/convex/admin.ts", "utf8");
  const lifecycleSrc = readFileSync("src/convex/adminLifecycle.ts", "utf8");
  const membershipSrc = readFileSync("src/lib/membership.ts", "utf8");
  const invitationsSrc = readFileSync("src/convex/invitations.ts", "utf8");
  const httpSrc = readFileSync("src/convex/http.ts", "utf8");
  const usersPageSrc = readFileSync(
    "src/components/iitams/admin/AdminUsersPage.tsx",
    "utf8",
  );

  test("role changes are a public mutation gated on admin.manage and org-scoped", () => {
    const idx = adminSrc.indexOf("export const changeMemberRole = mutation({");
    expect(idx).toBeGreaterThan(-1);
    const body = adminSrc.slice(idx, idx + 3600);
    expect(body).toContain('requirePermission(ctx, "admin.manage")');
    expect(body).toContain("target.organizationId !== access.organizationId");
    expect(body).toContain("target.userId === access.user._id");
    expect(body).toContain('target.role === "admin"');
    expect(body).toContain("admin.member_role_changed");
  });

  test("the administrator role is excluded from every assignable role list", () => {
    const listStart = membershipSrc.indexOf(
      "export const PROVISIONABLE_INITIAL_ROLES = [",
    );
    const listDef = membershipSrc.slice(
      listStart,
      membershipSrc.indexOf("] as const;", listStart),
    );
    expect(listDef).not.toContain('"admin"');
    expect(listDef).toContain('"auditor"');
    // The role editor offers exactly this server-validated list.
    expect(usersPageSrc).toContain("PROVISIONABLE_INITIAL_ROLES.filter");
    // No hard-coded admin option in the role picker.
    expect(usersPageSrc).not.toMatch(/<SelectItem value="admin"/);
  });

  test("the role editor requires an explicit confirmation step and re-checks permissions server-side", () => {
    expect(usersPageSrc).toContain("api.admin.changeMemberRole");
    expect(usersPageSrc).toContain("Confirm role change");
    // The UI only renders controls for admins — but the server is authoritative.
    expect(usersPageSrc).toContain("session?.permissions?.adminManage === true");
  });

  test("operator recovery is an internal mutation, never a client or HTTP surface", () => {
    expect(
      lifecycleSrc.includes(
        "export const recoverOrganizationAdministrator = internalMutation({",
      ),
    ).toBe(true);
    // Not a public query/mutation of the same name.
    expect(lifecycleSrc).not.toMatch(
      /export const recoverOrganizationAdministrator = (mutation|query)\(/,
    );
    // Not wired into the HTTP router.
    expect(httpSrc).not.toContain("recoverOrganizationAdministrator");
    // Gated on an explicit operator opt-in and on zero effective admins.
    const idx = lifecycleSrc.indexOf(
      "recoverOrganizationAdministrator = internalMutation({",
    );
    const body = lifecycleSrc.slice(idx, idx + 4200);
    expect(body).toContain('process.env.IITAMS_RECOVERY_ENABLED !== "true"');
    expect(body).toContain("countActiveAdministrators(ctx, org._id)");
    expect(body).toContain("Deployment operator (CLI recovery)");
    expect(body).toContain("admin.administrator_recovered");
    // Recovery never touches the one-time bootstrap or invitation tables.
    expect(body).not.toContain("initialBootstraps");
    expect(body).not.toContain("invitations");
  });

  test("a pending administrator grant blocks role editing (no grant row is touched)", () => {
    const idx = adminSrc.indexOf("export const changeMemberRole = mutation({");
    const body = adminSrc.slice(idx, idx + 3400);
    expect(body).toContain("hasPendingAdministratorGrant(");
    expect(body).not.toContain("administratorGrants");
    expect(
      lifecycleSrc.includes("export async function hasPendingAdministratorGrant("),
    ).toBe(true);
    // The helper only READS the grant table (index query + filter) — it never
    // patches, deletes or replaces a grant row.
    const helperIdx = lifecycleSrc.indexOf(
      "export async function hasPendingAdministratorGrant(",
    );
    const helper = lifecycleSrc.slice(helperIdx, helperIdx + 900);
    expect(helper).not.toContain("ctx.db.patch");
    expect(helper).not.toContain("ctx.db.insert");
    expect(helper).not.toContain("ctx.db.delete");
  });

  test("invitation flows are untouched by routine role management", () => {
    expect(invitationsSrc).not.toContain("changeMemberRole");
    expect(invitationsSrc).not.toContain("member_role_changed");
    // Invitation acceptance still applies its own recorded role through the
    // shared membership helper.
    expect(invitationsSrc).toContain("applyInitialMembership");
  });
});

// ============================================================================
// Runtime guards (deployed backend)
// ============================================================================

describe("Batch A2 — routine role management (runtime)", () => {
  test("internal recovery is unreachable from a client and refuses without an explicit organization", async () => {
    if (!(await serverUp())) {
      throw new Error("[test:PREREQ-FAILED] convex backend unreachable");
    }
    const client = new ConvexHttpClient(CONVEX_URL);
    // The routine path is a public mutation; the recovery path only exists as
    // an internal reference, which the deployment refuses for clients.
    expect(api.admin.changeMemberRole).toBeDefined();

    const attempt = client
      .mutation(internal.adminLifecycle.recoverOrganizationAdministrator, {
        organizationCode: "DOES-NOT-MATTER",
        email: "operator@check.example",
      })
      .then((r) => JSON.stringify(r));
    await expect(attempt).rejects.toThrow();
  }, 30000);

  test(
    "authorized role change updates role, session permissions and audit trail; unsafe changes are refused",
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const admin = await adminClientWithGrant();
      if (!admin) {
        throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
      }
      const suffix = uniq();
      const email = `rolechange-${suffix}@check.example`;
      expect(await seedVerifiedIdentity(email)).toBe(true);

      // Baseline: provision as auditor (ordinary, non-admin).
      const provisioned = (await admin.mutation(api.admin.provisionMember, {
        email,
        initialRole: "auditor",
      })) as { ok?: boolean; profileId?: string };
      if (!provisioned.ok || !provisioned.profileId) {
        throw new Error("[test:PREREQ-FAILED] member provisioning unavailable");
      }
      const profileId = provisioned.profileId as never;

      const member = await signInEmailOtp(email);
      if (!member) {
        throw new Error("[test:PREREQ-FAILED] member sign-in unavailable");
      }
      const before = (await member.query(api.session.getSession, {})) as Session;
      expect(before?.role).toBe("auditor");
      expect(before?.permissions?.auditManage).toBe(false);

      // 1. Non-administrator callers are refused.
      await expect(
        member
          .mutation(api.admin.changeMemberRole, {
            profileId,
            role: "audit_manager",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/Permission denied/i);

      // 2. Invalid / privileged targets are rejected by the typed validator.
      await expect(
        admin
          .mutation(api.admin.changeMemberRole, {
            profileId,
            role: "admin" as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow();
      await expect(
        admin
          .mutation(api.admin.changeMemberRole, {
            profileId,
            role: "super_admin" as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow();

      // 3. Authorized change succeeds and reports the previous role.
      const changed = (await admin.mutation(api.admin.changeMemberRole, {
        profileId,
        role: "audit_manager",
      })) as { ok?: boolean; role?: string; previousRole?: string };
      expect(changed.ok).toBe(true);
      expect(changed.previousRole).toBe("auditor");
      expect(changed.role).toBe("audit_manager");

      // 4. The directory reflects the new role immediately.
      const rows = (await admin.query(api.admin.listUsers, {})) as DirectoryRow[];
      const row = rows.find((r) => r._id === (profileId as unknown as string));
      expect(row?.role).toBe("audit_manager");

      // 5. Recalculation is immediate: the member's own session resolves the
      //    new role's permissions without any re-provisioning step.
      const after = (await member.query(api.session.getSession, {})) as Session;
      expect(after?.role).toBe("audit_manager");
      expect(after?.permissions?.auditManage).toBe(true);

      // 6. No-op changes are refused instead of writing.
      await expect(
        admin
          .mutation(api.admin.changeMemberRole, {
            profileId,
            role: "audit_manager",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/already holds that role/i);

      // 7. Suspended memberships must be reactivated before a role change.
      await admin.mutation(api.admin.setMembershipStatus, {
        profileId,
        status: "suspended",
      });
      await expect(
        admin
          .mutation(api.admin.changeMemberRole, {
            profileId,
            role: "auditor",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/reactivate/i);
      await admin.mutation(api.admin.setMembershipStatus, {
        profileId,
        status: "active",
      });

      // 8. Audit trail: actor ≠ target, previous → new role recorded once.
      const logs = (await admin.query(api.admin.listAuditLogs, {
        action: "admin.member_role_changed",
        limit: 50,
      })) as Array<{
        action: string;
        summary?: string;
        actorLabel?: string;
        userId?: string;
        entityId?: string;
      }>;
      const entry = logs.find((l) => l.entityId === (profileId as unknown as string));
      expect(entry).toBeDefined();
      expect(entry!.summary ?? "").toContain("auditor to audit_manager");
      expect(entry!.userId).toBe(before?.userId ?? entry!.userId);
      expect(entry!.actorLabel ?? "").not.toBe("");

      // 8b. A queued administrator promotion blocks role editing until the
      //     grant is resolved; the grant row itself stays untouched and the
      //     role change succeeds once the grant is cancelled.
      const grant = (await admin.mutation(api.adminLifecycle.grantAdministrator, {
        profileId,
      })) as { ok?: boolean; grantId?: string };
      expect(grant.ok).toBe(true);
      const grantId = grant.grantId as never;
      await expect(
        admin
          .mutation(api.admin.changeMemberRole, { profileId, role: "auditor" })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/administrator grant is pending/i);
      // The directory row is unchanged (the refused call wrote nothing).
      const unchanged = (await admin.query(api.admin.listUsers, {})) as DirectoryRow[];
      expect(
        unchanged.find((r) => r._id === (profileId as unknown as string))?.role,
      ).toBe("audit_manager");
      await admin.mutation(api.adminLifecycle.cancelAdministratorGrant, { grantId });
      const afterCancel = (await admin.mutation(api.admin.changeMemberRole, {
        profileId,
        role: "auditor",
      })) as { ok?: boolean; previousRole?: string };
      expect(afterCancel.ok).toBe(true);
      expect(afterCancel.previousRole).toBe("audit_manager");

      // 9. A profile that already holds `admin` cannot be edited here.
      const adminSession = (await admin.query(api.session.getSession, {})) as Session;
      if (adminSession?.userId) {
        const selfRow = rows.find(
          (r) => r.isAnonymous && r.membershipStatus === "active" && r.role === "admin",
        );
        if (selfRow) {
          await expect(
            admin
              .mutation(api.admin.changeMemberRole, {
                profileId: selfRow._id as never,
                role: "member",
              })
              .then((r) => JSON.stringify(r)),
          ).rejects.toThrow(/cannot change their own role|administrator lifecycle/i);
        }
      }
    },
    150000,
  );
});
