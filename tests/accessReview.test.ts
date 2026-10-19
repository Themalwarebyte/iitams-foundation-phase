import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api, internal } from "../src/convex/_generated/api";

/**
 * Phase 3A — Batch A3: access reviews & recertification foundation.
 * =================================================================
 * Two layers, like the rest of the Phase 3A suites:
 *
 *  1. STRUCTURAL guards (no deployment needed) — every operation is gated on
 *     admin permissions and re-checks the caller's organization, snapshots are
 *     insert-only, self-review of administrator access is refused, and
 *     remediation routes THROUGH the existing authorized mutations rather
 *     than writing roles/statuses itself.
 *
 *  2. RUNTIME flow (deployed backend + trusted harness) — a real cycle is
 *     created, snapshots are captured, decisions are attributed to their
 *     reviewer, a snapshot survives a later role change, self-certification of
 *     administrator access is refused, and a recommendation only reports as
 *     applied after the existing authorized mutation succeeds.
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

function devAdminKey(): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(process.cwd(), ".convex/local/default/config.json"), "utf8"),
    ) as { adminKey?: unknown };
    return typeof parsed.adminKey === "string" && parsed.adminKey.length > 0
      ? parsed.adminKey
      : null;
  } catch {
    return null;
  }
}

/**
 * Retire the synthetic `bulk-*@check.example` memberships this suite provisions.
 * Each run adds ~205 real demo-organization members to exercise >200-member
 * capture; suspending them afterwards (reversible, audited, nothing deleted)
 * keeps the shared demo organization from inflating every later scan.
 */
async function retireBulkMemberships(): Promise<void> {
  const key = devAdminKey();
  if (!key || !(await serverUp())) return;
  const admin = new ConvexHttpClient(CONVEX_URL);
  (admin as unknown as { setAdminAuth: (v: string) => void }).setAdminAuth(key);
  let cursor: string | undefined;
  for (let i = 0; i < 100; i += 1) {
    const result = (await admin.mutation(
      internal.devTenantFixtures.retireBulkTestMemberships,
      { maxRecords: 400, ...(cursor ? { cursor } : {}) },
    )) as { suspended: number; isDone: boolean; continueCursor: string | null };
    if (result.isDone) return;
    if (!result.continueCursor) return;
    cursor = result.continueCursor;
  }
}

beforeAll(async () => {
  await retireBulkMemberships();
}, 180000);

afterAll(async () => {
  await retireBulkMemberships();
}, 180000);

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

async function harnessPost(
  path: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  const res = await fetch(`${HARNESS}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-iitams-tester-token": token,
    },
    body: JSON.stringify(body),
  });
  return res.ok;
}

async function harnessGrantAdmin(userId: string): Promise<boolean> {
  return await harnessPost("/api/dev-grant-demo-role", {
    userId,
    role: "admin",
    ttlMinutes: 120,
  });
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

async function adminClientWithGrant(): Promise<ConvexHttpClient | null> {
  const admin = await signInAnonymous();
  await admin.mutation(api.session.joinDemoOrganization, {});
  const session = (await admin.query(api.session.getSession, {})) as {
    userId?: string;
  } | null;
  if (!session?.userId) return null;
  if (!(await harnessGrantAdmin(session.userId))) return null;
  return admin;
}

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 99999)}`;
const DAY = 24 * 60 * 60 * 1000;

type ReviewItem = {
  _id: string;
  targetProfileId: string;
  targetLabel: string;
  targetEmail?: string;
  roleSnapshot?: string;
  membershipStatusSnapshot: string;
  latestDecision: {
    decision: string;
    reviewerLabel: string;
    notes?: string;
  } | null;
  decisions: Array<{ decision: string; reviewerLabel: string }>;
  remediations: Array<{
    _id: string;
    recommendation: string;
    targetRole?: string;
    status: string;
    roleBefore?: string;
    roleAfter?: string;
    proposedByLabel: string;
  }>;
  latestRemediation: { _id: string; status: string } | null;
};

type CycleDetail = {
  cycle: {
    _id: string;
    title: string;
    status: string;
    overdue: boolean;
    dueAt: number;
    captureScanComplete: boolean;
    membersEligible: number;
    membersScanned: number;
    outstanding: number;
  };
  items: ReviewItem[];
} | null;

type CaptureResult = {
  scannedThisPage: number;
  capturedThisPage: number;
  capturedTotal: number;
  eligibleTotal: number;
  outstanding: number;
  scanComplete: boolean;
};

type CyclePage = {
  rows: Array<{
    _id: string;
    title: string;
    status: string;
    createdAt: number;
    itemCount: number;
    captureScanComplete: boolean;
  }>;
  continueCursor: string;
  isDone: boolean;
};

// ============================================================================
// Structural guards (no deployment required)
// ============================================================================

describe("Batch A3 — access review structural guards", () => {
  const src = readFileSync("src/convex/accessReview.ts", "utf8");
  const schemaSrc = readFileSync("src/convex/schema.ts", "utf8");
  const httpSrc = readFileSync("src/convex/http.ts", "utf8");
  const pageSrc = readFileSync(
    "src/components/iitams/admin/AdminAccessReviewsPage.tsx",
    "utf8",
  );
  const libSrc = readFileSync("src/lib/accessReview.ts", "utf8");

  test("every exported operation independently enforces authorization", () => {
    const fns = [...src.matchAll(/export const (\w+) = (query|mutation)\(\{/g)];
    expect(fns.length).toBeGreaterThanOrEqual(8);
    for (const fn of fns) {
      const start = fn.index ?? 0;
      const body = src.slice(start, start + 900);
      expect(
        body.includes("requireAdminContext(") ||
          body.includes("requireViewerContext("),
      ).toBe(true);
    }
    // Writes require admin.manage, reads admin.view — never a client flag.
    expect(src).toContain('requirePermission(ctx, "admin.manage")');
    expect(src).toContain('requirePermission(ctx, "admin.view")');
    expect(src).toContain("access.isProvisioned");
  });

  test("every id-addressed lookup re-checks the caller's organization", () => {
    expect(src).toContain("cycle.organizationId !== organizationId");
    expect(src).toContain("item.organizationId !== organizationId");
    expect(src).toContain("remediation.organizationId !== admin.organizationId");
    expect(src).toContain("profile.organizationId !== admin.organizationId");
    // The snapshot queries resolve the cycle first and return null for a
    // foreign organization instead of leaking existence.
    expect(src).toContain("if (!cycle || cycle.organizationId !== org.organizationId) return null");
  });

  test("snapshots are insert-only review evidence", () => {
    // The reviewed membership state is captured, never rewritten.
    for (const field of [
      "roleSnapshot",
      "membershipStatusSnapshot",
      "lastActivityAt",
      "targetProfileId",
      "capturedAt",
    ]) {
      expect(schemaSrc).toContain(field);
    }
    const patches = [...src.matchAll(/ctx\.db\.patch\(([^,]+),/g)].map((m) =>
      (m[1] ?? "").trim(),
    );
    expect(patches.length).toBeGreaterThan(0);
    for (const target of patches) {
      expect(["cycle._id", "remediation._id"]).toContain(target);
    }
    // No function updates or deletes a snapshot row.
    expect(src).not.toMatch(/ctx\.db\.(patch|delete)\(item\._id/);
  });

  test("a reviewer cannot certify their own administrator access", () => {
    const idx = src.indexOf("export const recordDecision = mutation({");
    const body = src.slice(idx, idx + 2600);
    expect(body).toContain("item.targetUserId === admin.userId");
    expect(body).toContain('item.roleSnapshot === "admin"');
    expect(body).toContain("independent reviewer");
  });

  test("remediation routes through the existing authorized mutations", () => {
    // The only access-changing calls in this module are the existing admin
    // mutations — no new role/status write path exists.
    expect(src).toContain("ctx.runMutation(api.admin.changeMemberRole");
    expect(src).toContain("ctx.runMutation(api.admin.setMembershipStatus");
    expect(src).not.toMatch(/ctx\.db\.patch\([^)]*(role|membershipStatus)\s*:/);
    // "applied" is written only after the authorized mutation succeeds.
    const applyIdx = src.indexOf("export const applyRemediation = mutation({");
    const applyBody = src.slice(applyIdx);
    const switchIdx = applyBody.indexOf("switch (remediation.recommendation)");
    const markIdx = applyBody.indexOf('status: "applied"');
    expect(switchIdx).toBeGreaterThan(-1);
    expect(markIdx).toBeGreaterThan(switchIdx);
  });

  test("review evidence and operations are not exposed on the HTTP router", () => {
    expect(httpSrc).not.toContain("accessReview");
    expect(httpSrc).not.toContain("recordDecision");
  });

  test("review vocabulary is centralised and excludes privileged/admin roles", () => {
    expect(libSrc).toContain("ACCESS_REVIEW_DECISIONS");
    expect(libSrc).toContain("ACCESS_REVIEW_RECOMMENDATIONS");
    expect(libSrc).toContain("isCycleOverdue");
    // Recommendations may only request ordinary organization roles.
    expect(src).toContain("PROVISIONABLE_INITIAL_ROLES as readonly string[]");
  });

  test("the Administration UI mirrors, never replaces, server enforcement", () => {
    expect(pageSrc).toContain("api.accessReview.listCycles");
    expect(pageSrc).toContain("api.accessReview.recordDecision");
    expect(pageSrc).toContain("api.accessReview.applyRemediation");
    expect(pageSrc).toContain("session?.permissions?.adminManage === true");
    // Self-review is visibly blocked in the UI as well.
    expect(pageSrc).toContain("independent review required");
    // The UI never mutates a role or membership status directly.
    expect(pageSrc).not.toContain("api.admin.changeMemberRole");
    expect(pageSrc).not.toContain("api.admin.setMembershipStatus");
  });

  test("capture is resumable and cannot report a partial snapshot as complete", () => {
    // Page-bounded scan with a persisted cursor (no fixed 200-member cap).
    expect(libSrc).toContain("ACCESS_REVIEW_CAPTURE_PAGE_SIZE");
    expect(src).toContain(".paginate({");
    expect(src).toContain("cursor: cycle.captureCursor ?? null");
    expect(src).toContain("captureCursor: page.isDone ? undefined : page.continueCursor");
    // Completion is gated on an exhausted scan AND zero outstanding members.
    const completeIdx = src.indexOf("export const completeCycle = mutation({");
    const completeBody = src.slice(completeIdx, completeIdx + 2200);
    expect(completeBody).toContain("cycle.captureScanComplete !== true");
    expect(completeBody).toContain("eligible member(s) were not captured");
    // Duplicate prevention is structural: one snapshot per (cycle, member).
    expect(schemaSrc).toContain('by_cycle_target');
    expect(src).toContain("alreadyCaptured");
  });

  test("the cycle list is cursor-paginated instead of silently truncated", () => {
    const listIdx = src.indexOf("export const listCycles = query({");
    const listBody = src.slice(listIdx, listIdx + 2400);
    // Indexed, newest-first pagination — not an in-memory slice of a full scan.
    expect(listBody).toContain(".order(\"desc\")");
    expect(listBody).toContain(".paginate({");
    expect(listBody).toContain("cursor: args.cursor ?? null");
    expect(listBody).toContain("continueCursor: page.continueCursor");
    expect(listBody).not.toContain(".collect()");
    // The UI exposes the remaining history rather than hiding it.
    expect(pageSrc).toContain("continueCursor");
    expect(pageSrc).toContain("Load older cycles");
  });
});

// ============================================================================
// Runtime flow (deployed backend + harness)
// ============================================================================

describe("Batch A3 — access review runtime", () => {
  test(
    "cycles snapshot memberships, attribute decisions, refuse self-review and apply remediation only through authorized paths",
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const admin = await adminClientWithGrant();
      if (!admin) {
        throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
      }

      const suffix = uniq();
      const reviewerEmail = `reviewer-${suffix}@check.example`;
      const targetEmail = `remediate-${suffix}@check.example`;
      expect(await harnessPost("/api/dev-seed-test-user", { email: reviewerEmail })).toBe(
        true,
      );
      expect(await harnessPost("/api/dev-seed-test-user", { email: targetEmail })).toBe(
        true,
      );

      const reviewerProfile = (await admin.mutation(api.admin.provisionMember, {
        email: reviewerEmail,
        initialRole: "auditor",
      })) as { ok?: boolean; profileId?: string };
      const targetProfile = (await admin.mutation(api.admin.provisionMember, {
        email: targetEmail,
        initialRole: "member",
      })) as { ok?: boolean; profileId?: string };
      if (
        !reviewerProfile.ok ||
        !reviewerProfile.profileId ||
        !targetProfile.ok ||
        !targetProfile.profileId
      ) {
        throw new Error("[test:PREREQ-FAILED] member provisioning unavailable");
      }

      // Due dates must be forward-looking.
      await expect(
        admin
          .mutation(api.accessReview.createCycle, {
            title: "past due review",
            dueAt: Date.now() - DAY,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/future/i);

      // 1. Cycle creation snapshots the reviewed memberships.
      const created = (await admin.mutation(api.accessReview.createCycle, {
        title: `Access review ${suffix}`,
        dueAt: Date.now() + 7 * DAY,
      })) as {
        cycleId: string;
        capturedTotal: number;
        scanComplete: boolean;
      };
      expect(created.capturedTotal).toBeGreaterThan(0);

      const detail = (await admin.query(api.accessReview.getCycle, {
        cycleId: created.cycleId as never,
      })) as CycleDetail;
      expect(detail).not.toBeNull();
      const targetItem = detail!.items.find((i) => i.targetEmail === targetEmail);
      expect(targetItem).toBeDefined();
      expect(targetItem!.roleSnapshot).toBe("member");
      expect(targetItem!.membershipStatusSnapshot).toBe("active");
      expect(detail!.cycle.overdue).toBe(false);

      // 2. A reviewer who is not an administrator cannot record anything.
      const reviewer = await signInEmailOtp(reviewerEmail);
      if (!reviewer) throw new Error("[test:PREREQ-FAILED] reviewer sign-in unavailable");
      await expect(
        reviewer
          .mutation(api.accessReview.recordDecision, {
            cycleId: created.cycleId as never,
            itemId: targetItem!._id as never,
            decision: "access_confirmed",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/Permission denied/i);

      // 3. Reviewer attribution + note requirement.
      await expect(
        admin
          .mutation(api.accessReview.recordDecision, {
            cycleId: created.cycleId as never,
            itemId: targetItem!._id as never,
            decision: "remediation_required",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/requires a reviewer note/i);

      await admin.mutation(api.accessReview.recordDecision, {
        cycleId: created.cycleId as never,
        itemId: targetItem!._id as never,
        decision: "remediation_required",
        notes: "Role exceeds least privilege for this function.",
      });
      const afterDecision = (await admin.query(api.accessReview.getCycle, {
        cycleId: created.cycleId as never,
      })) as CycleDetail;
      const decidedItem = afterDecision!.items.find(
        (i) => i.targetEmail === targetEmail,
      )!;
      expect(decidedItem.latestDecision?.decision).toBe("remediation_required");
      expect(decidedItem.latestDecision?.reviewerLabel.length).toBeGreaterThan(0);
      expect(decidedItem.decisions.length).toBe(1);

      // 4. Recommendation is recorded separately and changes nothing yet.
      const proposed = (await admin.mutation(api.accessReview.proposeRemediation, {
        cycleId: created.cycleId as never,
        itemId: decidedItem._id as never,
        recommendation: "change_role",
        targetRole: "auditor",
        notes: "Move to the auditor role after review.",
      })) as { remediationId: string };

      const rowsAfterProposal = (await admin.query(api.admin.listUsers, {})) as Array<{
        _id: string;
        role: string;
      }>;
      expect(
        rowsAfterProposal.find((r) => r._id === targetProfile.profileId)?.role,
      ).toBe("member");

      // 5. Applying goes through the existing authorized mutation and only
      //    then reports "applied" with before/after evidence.
      const applied = (await admin.mutation(api.accessReview.applyRemediation, {
        remediationId: proposed.remediationId as never,
      })) as { ok?: boolean; roleBefore?: string; roleAfter?: string };
      expect(applied.ok).toBe(true);
      expect(applied.roleBefore).toBe("member");
      expect(applied.roleAfter).toBe("auditor");

      const rowsAfterApply = (await admin.query(api.admin.listUsers, {})) as Array<{
        _id: string;
        role: string;
      }>;
      expect(
        rowsAfterApply.find((r) => r._id === targetProfile.profileId)?.role,
      ).toBe("auditor");

      const detailAfterApply = (await admin.query(api.accessReview.getCycle, {
        cycleId: created.cycleId as never,
      })) as CycleDetail;
      const appliedRemediation = detailAfterApply!.items
        .find((i) => i.targetEmail === targetEmail)!
        .remediations.find((r) => r._id === proposed.remediationId)!;
      expect(appliedRemediation.status).toBe("applied");
      expect(appliedRemediation.roleBefore).toBe("member");
      expect(appliedRemediation.roleAfter).toBe("auditor");

      // The snapshot still records the role seen at capture time.
      expect(
        detailAfterApply!.items.find((i) => i.targetEmail === targetEmail)!
          .roleSnapshot,
      ).toBe("member");

      // Applying twice is refused (nothing to re-apply).
      await expect(
        admin
          .mutation(api.accessReview.applyRemediation, {
            remediationId: proposed.remediationId as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/only a proposed recommendation/i);

      // 6. Audit integrity: the applied action is recorded against the target
      //    with the administrator as actor.
      const logs = (await admin.query(api.admin.listAuditLogs, {
        action: "access_review.remediation_applied",
        limit: 20,
      })) as Array<{ action: string; summary?: string }>;
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].summary ?? "").toContain("auditor");

      // 7. Completion requires a finished snapshot AND a decision on every
      //    reviewed membership. Finish the (resumable) capture first.
      let snap = (await admin.mutation(api.accessReview.captureMembers, {
        cycleId: created.cycleId as never,
      })) as CaptureResult;
      // The demo organization keeps suspended synthetic members from earlier
      // runs, so the profile scan spans many bounded pages; the bound only
      // guards against an infinite loop.
      for (let i = 0; i < 120 && !snap.scanComplete; i += 1) {
        snap = (await admin.mutation(api.accessReview.captureMembers, {
          cycleId: created.cycleId as never,
        })) as CaptureResult;
      }
      expect(snap.scanComplete).toBe(true);
      await expect(
        admin
          .mutation(api.accessReview.completeCycle, {
            cycleId: created.cycleId as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/still have no decision/i);

      // An empty cycle (capture disabled) can be completed immediately.
      const empty = (await admin.mutation(api.accessReview.createCycle, {
        title: `Empty review ${suffix}`,
        dueAt: Date.now() + 3 * DAY,
        captureMembers: false,
      })) as { cycleId: string; capturedTotal: number; scanComplete: boolean };
      expect(empty.capturedTotal).toBe(0);
      expect(empty.scanComplete).toBe(true);
      await admin.mutation(api.accessReview.completeCycle, {
        cycleId: empty.cycleId as never,
      });
      const completed = (await admin.query(api.accessReview.getCycle, {
        cycleId: empty.cycleId as never,
      })) as CycleDetail;
      expect(completed!.cycle.status).toBe("completed");

      // 8. Self-review of administrator access needs an independent reviewer:
      //    promote the reviewer through the existing lifecycle, then create a
      //    cycle whose snapshot shows that administrator role.
      await admin.mutation(api.adminLifecycle.grantAdministrator, {
        profileId: reviewerProfile.profileId as never,
      });
      const pending = (await reviewer.query(
        api.adminLifecycle.myPendingAdministratorGrants,
        {},
      )) as Array<{ _id: string }>;
      expect(pending.length).toBeGreaterThan(0);
      await reviewer.mutation(api.adminLifecycle.acceptAdministratorGrant, {
        grantId: pending[0]._id as never,
      });

      const adminCycle = (await admin.mutation(api.accessReview.createCycle, {
        title: `Admin recertification ${suffix}`,
        dueAt: Date.now() + 5 * DAY,
      })) as { cycleId: string };
      const adminDetail = (await admin.query(api.accessReview.getCycle, {
        cycleId: adminCycle.cycleId as never,
      })) as CycleDetail;
      const selfItem = adminDetail!.items.find(
        (i) => i.targetEmail === reviewerEmail,
      );
      expect(selfItem).toBeDefined();
      expect(selfItem!.roleSnapshot).toBe("admin");

      await expect(
        reviewer
          .mutation(api.accessReview.recordDecision, {
            cycleId: adminCycle.cycleId as never,
            itemId: selfItem!._id as never,
            decision: "access_confirmed",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/independent reviewer/i);

      // An independent administrator records it successfully.
      await admin.mutation(api.accessReview.recordDecision, {
        cycleId: adminCycle.cycleId as never,
        itemId: selfItem!._id as never,
        decision: "access_confirmed",
        notes: "Confirmed as organization owner by independent administrator.",
      });
      const finalDetail = (await admin.query(api.accessReview.getCycle, {
        cycleId: adminCycle.cycleId as never,
      })) as CycleDetail;
      expect(
        finalDetail!.items.find((i) => i.targetEmail === reviewerEmail)!
          .latestDecision?.decision,
      ).toBe("access_confirmed");

      // 9. Snapshot evidence outlives later role changes: the first cycle still
      //    shows the reviewer's original auditor snapshot.
      const firstCycle = (await admin.query(api.accessReview.getCycle, {
        cycleId: created.cycleId as never,
      })) as CycleDetail;
      const earlySnapshot = firstCycle!.items.find(
        (i) => i.targetEmail === reviewerEmail,
      );
      if (earlySnapshot) {
        expect(earlySnapshot.roleSnapshot).toBe("auditor");
      }

      // 10. Reviewers below admin.view get nothing at all — the tenant-scoped
      //     query is not a data dump for ordinary members.
      const nonAdmin = await signInEmailOtp(targetEmail);
      if (nonAdmin) {
        await expect(
          nonAdmin
            .query(api.accessReview.listCycles, {})
            .then((r) => JSON.stringify(r)),
        ).rejects.toThrow(/Permission denied/i);
      }
    },
    120000,
  );

  test(
    "resumable capture covers an organization with more than 200 memberships without duplicates or lost evidence",
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const admin = await adminClientWithGrant();
      if (!admin) {
        throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
      }

      const suffix = uniq();
      const MEMBERS = 205; // deliberately exceeds the 200-profile capture page
      const emails = Array.from(
        { length: MEMBERS },
        (_, i) => `bulk-${suffix}-${i}@check.example`,
      );

      // Seed and provision real (non-anonymous) memberships in bounded
      // batches so the fixture load itself stays inside request limits.
      const batches: string[][] = [];
      for (let i = 0; i < emails.length; i += 25) {
        batches.push(emails.slice(i, i + 25));
      }
      let provisioned = 0;
      for (const batch of batches) {
        const seeded = await Promise.all(
          batch.map((email) =>
            harnessPost("/api/dev-seed-test-user", { email }),
          ),
        );
        expect(seeded.every(Boolean)).toBe(true);
        const results = await Promise.all(
          batch.map((email) =>
            admin.mutation(api.admin.provisionMember, {
              email,
              initialRole: "member",
            }),
          ),
        );
        provisioned += results.filter(
          (r) => (r as { ok?: boolean }).ok === true,
        ).length;
      }
      expect(provisioned).toBe(MEMBERS);

      // A partial capture must never be completable.
      const cycle = (await admin.mutation(api.accessReview.createCycle, {
        title: `Large recertification ${suffix}`,
        dueAt: Date.now() + 10 * DAY,
      })) as {
        cycleId: string;
        capturedTotal: number;
        scanComplete: boolean;
      };
      if (!cycle.scanComplete) {
        await expect(
          admin
            .mutation(api.accessReview.completeCycle, {
              cycleId: cycle.cycleId as never,
            })
            .then((r) => JSON.stringify(r)),
        ).rejects.toThrow(/snapshot is still being captured/i);
      }

      // Snapshot one member mid-scan, then change their role; the captured
      // evidence must not follow the later change.
      const probeEmail = emails[0];
      const beforeScan = (await admin.query(api.accessReview.getCycle, {
        cycleId: cycle.cycleId as never,
      })) as CycleDetail;
      const probe = beforeScan!.items.find((i) => i.targetEmail === probeEmail);

      let pages = 1;
      let latest = cycle as unknown as CaptureResult;
      // The shared demo organization retains the SUSPENDED synthetic members
      // earlier runs provisioned (fixture hygiene suspends them; nothing is
      // deleted), so the full profile scan legitimately spans many bounded
      // pages. The bound only stops an infinite loop; the completeness
      // assertions below still require every eligible member to be captured.
      while (!latest.scanComplete && pages < 120) {
        latest = (await admin.mutation(api.accessReview.captureMembers, {
          cycleId: cycle.cycleId as never,
        })) as CaptureResult;
        pages += 1;
        expect(latest.capturedTotal).toBeGreaterThanOrEqual(
          cycle.capturedTotal,
        );
      }
      expect(latest.scanComplete).toBe(true);
      expect(pages).toBeGreaterThan(1); // multiple bounded pages were required
      expect(latest.capturedTotal).toBeGreaterThan(200);
      expect(latest.eligibleTotal).toBe(latest.capturedTotal);
      expect(latest.outstanding).toBe(0);

      const detail = (await admin.query(api.accessReview.getCycle, {
        cycleId: cycle.cycleId as never,
      })) as CycleDetail;
      expect(detail!.cycle.captureScanComplete).toBe(true);

      // Every one of the 205 new memberships is represented exactly once.
      const capturedEmails = new Set(
        detail!.items.map((i) => i.targetEmail).filter(Boolean),
      );
      expect(emails.every((e) => capturedEmails.has(e))).toBe(true);
      const profileIds = detail!.items.map((i) => i.targetProfileId);
      expect(new Set(profileIds).size).toBe(profileIds.length);
      expect(detail!.items.length).toBe(latest.capturedTotal);

      // Resuming after completion is a no-op: no duplicates, no new rows.
      const again = (await admin.mutation(api.accessReview.captureMembers, {
        cycleId: cycle.cycleId as never,
      })) as CaptureResult;
      expect(again.scanComplete).toBe(true);
      expect(again.capturedThisPage).toBe(0);
      expect(again.capturedTotal).toBe(latest.capturedTotal);
      const afterResume = (await admin.query(api.accessReview.getCycle, {
        cycleId: cycle.cycleId as never,
      })) as CycleDetail;
      expect(afterResume!.items.length).toBe(latest.capturedTotal);

      // Role changes after capture do not rewrite historical evidence.
      if (probe) {
        const probeProfile = detail!.items.find(
          (i) => i.targetEmail === probeEmail,
        )!;
        await admin.mutation(api.admin.changeMemberRole, {
          profileId: probeProfile.targetProfileId as never,
          role: "auditor",
        });
        const afterChange = (await admin.query(api.accessReview.getCycle, {
          cycleId: cycle.cycleId as never,
        })) as CycleDetail;
        expect(
          afterChange!.items.find((i) => i.targetEmail === probeEmail)!
            .roleSnapshot,
        ).toBe(probe.roleSnapshot);
      }

      // Complete capture is still not a completed review: 200+ undecided
      // items block it.
      await expect(
        admin
          .mutation(api.accessReview.completeCycle, {
            cycleId: cycle.cycleId as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/still have no decision/i);
    },
    180000,
  );

  test(
    "cursor pagination keeps every historical cycle reachable beyond one page",
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const admin = await adminClientWithGrant();
      if (!admin) {
        throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
      }

      const suffix = uniq();
      // 30 cycles deliberately exceeds the 25-row default page. Empty-scope
      // cycles keep the fixture cheap (no membership snapshots needed).
      const createdIds: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        const created = (await admin.mutation(api.accessReview.createCycle, {
          title: `Pagination cycle ${suffix}-${i}`,
          dueAt: Date.now() + (7 + i) * DAY,
          captureMembers: false,
        })) as { cycleId: string };
        createdIds.push(created.cycleId);
      }

      // Page 1: newest first, exactly the default page size, more available.
      const first = (await admin.query(api.accessReview.listCycles, {})) as CyclePage;
      expect(first.rows).toHaveLength(25);
      expect(first.isDone).toBe(false);
      expect(typeof first.continueCursor).toBe("string");
      expect(first.continueCursor.length).toBeGreaterThan(0);
      for (let i = 1; i < first.rows.length; i += 1) {
        expect(first.rows[i - 1].createdAt).toBeGreaterThanOrEqual(
          first.rows[i].createdAt,
        );
      }

      // Walk the remaining pages: every cycle is reachable, none duplicated.
      const seen: string[] = first.rows.map((r) => r._id);
      let cursor: string | null = first.continueCursor;
      let pages = 1;
      while (cursor && pages < 40) {
        const next = (await admin.query(api.accessReview.listCycles, {
          cursor,
        })) as CyclePage;
        pages += 1;
        expect(next.rows.length).toBeLessThanOrEqual(25);
        for (const row of next.rows) seen.push(row._id);
        cursor = next.isDone ? null : next.continueCursor;
      }
      expect(cursor).toBeNull();
      expect(pages).toBeGreaterThan(1);
      expect(new Set(seen).size).toBe(seen.length);
      for (const id of createdIds) {
        expect(seen).toContain(id);
      }

      // Page size is clamped server-side: a caller cannot request the world.
      const clamped = (await admin.query(api.accessReview.listCycles, {
        numItems: 10_000,
      })) as CyclePage;
      expect(clamped.rows.length).toBeLessThanOrEqual(50);

      // A non-administrator still gets nothing, cursor or not.
      const member = await signInAnonymous();
      await expect(
        member
          .query(api.accessReview.listCycles, { cursor: first.continueCursor })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/Permission denied/i);
    },
    180000,
  );
});
