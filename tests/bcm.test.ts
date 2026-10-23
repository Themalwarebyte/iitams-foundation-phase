import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import type { Id } from "../src/convex/_generated/dataModel";
import { api, internal } from "../src/convex/_generated/api";
import {
  BCM_BIA_TRANSITIONS,
  BCM_CRITICALITY_RANK,
  BCM_IMPACT_CATEGORIES,
  canTransitionBia,
  formatMinutes,
  validateRecoveryObjectives,
  type BcmImpacts,
} from "../src/lib/bcm";

/**
 * Phase 4A Batch 4.1 — Business Continuity Management: Business Impact
 * Analysis and recovery objectives.
 *
 * The security properties under test:
 *  - the register, BIA and recovery objectives are organization-scoped;
 *  - writes need bcm.manage + an active membership, reads only bcm.view;
 *  - the preparer cannot approve their own analysis;
 *  - an approved analysis is immutable and revisions preserve earlier versions;
 *  - recovery objectives are normalized (minutes) and validated server-side,
 *    with RTO/RPO treated as independent concepts;
 *  - nothing here claims resilience or invents a readiness score.
 *
 * Structural checks run first (no backend required); runtime checks use
 * isolated fixture organizations and the same OTP bridge as the other suites.
 */

const root = process.cwd();
function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function sampleImpacts(severity: "low" | "severe" = "low"): BcmImpacts {
  return Object.fromEntries(
    BCM_IMPACT_CATEGORIES.map((category) => [
      category,
      { severity, notes: `${category} impact rationale for the exercise` },
    ]),
  ) as BcmImpacts;
}

// ---------------------------------------------------------------------------
// Structural / pure checks
// ---------------------------------------------------------------------------

describe("BCM structure and vocabulary", () => {
  test("continuity lifecycle is a closed transition table", () => {
    expect(canTransitionBia("draft", "in_review")).toBe(true);
    expect(canTransitionBia("in_review", "approved")).toBe(true);
    expect(canTransitionBia("in_review", "draft")).toBe(true);
    expect(canTransitionBia("approved", "superseded")).toBe(true);
    // No path back from approved to editable states, and superseded is terminal.
    expect(canTransitionBia("approved", "draft")).toBe(false);
    expect(canTransitionBia("approved", "in_review")).toBe(false);
    expect(BCM_BIA_TRANSITIONS.superseded).toEqual([]);
    expect(canTransitionBia("draft", "approved")).toBe(false);
  });

  test("recovery objectives require an RTO and reject non-positive values", () => {
    expect(() =>
      validateRecoveryObjectives({
        minimumServiceLevel: "Payments continue in manual mode within two hours",
        recoveryPriority: "p1",
        objectiveRationale: "Regulatory settlement window cannot be missed",
      }),
    ).toThrow(/recovery time objective \(RTO\) is required/i);

    expect(() =>
      validateRecoveryObjectives({
        rtoMinutes: 0,
        minimumServiceLevel: "Payments continue in manual mode within two hours",
        recoveryPriority: "p1",
        objectiveRationale: "Regulatory settlement window cannot be missed",
      }),
    ).toThrow(/positive whole number of minutes/i);
  });

  test("RTO above MTPD needs a documented exception, and RPO is independent", () => {
    const base = {
      rtoMinutes: 480,
      mtpdMinutes: 240,
      minimumServiceLevel: "Manual reconciliation continues for critical payments",
      recoveryPriority: "p1" as const,
      objectiveRationale: "Settlement cut-off drives the recovery requirement",
    };
    expect(() => validateRecoveryObjectives(base)).toThrow(/MTPD|maximum tolerable/i);

    const accepted = validateRecoveryObjectives({
      ...base,
      mtpdExceptionJustification:
        "The regulator permits a documented four-hour breach during quarter end.",
    });
    expect(accepted.rtoMinutes).toBe(480);
    expect(accepted.mtpdMinutes).toBe(240);

    // RPO longer than RTO is a legitimate combination (data loss tolerance and
    // restoration speed are different questions).
    const independent = validateRecoveryObjectives({
      rtoMinutes: 60,
      rpoMinutes: 480,
      minimumServiceLevel: "Read-only access to the last settlement batch",
      recoveryPriority: "p2",
      objectiveRationale: "Restore service fast; replay from the archive later",
    });
    expect(independent.rtoMinutes).toBe(60);
    expect(independent.rpoMinutes).toBe(480);
  });

  test("durations render from normalized minutes", () => {
    expect(formatMinutes(30)).toBe("30 min");
    expect(formatMinutes(120)).toBe("2 hour(s)");
    expect(formatMinutes(2880)).toBe("2 day(s)");
    expect(formatMinutes(undefined)).toBe("Not recorded");
    expect(BCM_CRITICALITY_RANK.critical).toBeGreaterThan(
      BCM_CRITICALITY_RANK.medium,
    );
  });

  test("the module never derives a readiness or resilience score", () => {
    const schema = read("src/convex/schema.ts");
    const bia = read("src/convex/businessImpactAnalyses.ts");
    const services = read("src/convex/businessServices.ts");
    const library = read("src/lib/bcm.ts");
    for (const source of [bia, services, library]) {
      expect(source).not.toMatch(/readinessScore/);
      expect(source).not.toMatch(/resilienceScore/);
      expect(source).not.toMatch(/maturityScore/);
    }
    // The legacy seeded dashboard fixture (`criticalServices`) carries a
    // pre-computed readiness score and is deliberately NOT reused as a
    // governance record. The new continuity tables must stay score-free.
    const governanceBlock = schema.slice(
      schema.indexOf("businessServices: defineTable"),
      schema.indexOf("riskTrendSnapshots"),
    );
    expect(governanceBlock.length).toBeGreaterThan(1000);
    expect(governanceBlock).not.toMatch(/readinessScore/);
    expect(governanceBlock).not.toMatch(/resilienceScore/);
    expect(services).not.toContain("criticalServices");
    expect(schema).toContain("bcmReferenceCounters");
  });

  test("server-side authorization uses the canonical registry", () => {
    const core = read("src/convex/bcmCore.ts");
    expect(core).toContain('requirePermission(ctx, "bcm.view")');
    expect(core).toContain('requirePermission(ctx, "bcm.manage")');
    expect(core).toContain("Caller membership is not active");
    expect(core).toContain("effectiveMembershipStatus");
    const access = read("src/convex/access.ts");
    expect(access).toContain('"bcm.view"');
    expect(access).toContain('"bcm.manage"');
  });

  test("the frontend routes are real pages, not placeholders", () => {
    const main = read("src/main.tsx");
    for (const page of ["BcmServicesPage", "BcmBiaPage", "BcmRecoveryPage"]) {
      expect(main).toContain(page);
    }
    expect(main).not.toMatch(/"\/bcm\/bia",\s*\n\s*"\/bcm\/rto-rpo"/);
    const nav = read("src/lib/nav.ts");
    expect(nav).toContain('path: "/bcm/bia"');
  });
});

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

const CONVEX_URL = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const HARNESS = process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const RUN_TAG = `BCM-${Date.now().toString(36).toUpperCase().slice(-6)}`;

const MANAGER_EMAIL = "compliance-manager-m@iitams.test";
const REVIEWER_EMAIL = "compliance-reviewer-m@iitams.test";
const READ_ONLY_EMAIL = "risk-tenant-m@iitams.test";
const OTHER_TENANT_EMAIL = "cyber-manager-a@iitams.test";

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

function devAdminKey(): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(
        join(process.cwd(), ".convex/local/default/config.json"),
        "utf8",
      ),
    ) as { adminKey?: unknown };
    return typeof parsed.adminKey === "string" && parsed.adminKey.length > 0
      ? parsed.adminKey
      : null;
  } catch {
    return null;
  }
}

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CONVEX_URL}/api/query`);
    return res.status < 600;
  } catch {
    return false;
  }
}

async function signInEmailOtp(email: string): Promise<ConvexHttpClient | null> {
  const c = new ConvexHttpClient(CONVEX_URL);
  const auth = c as unknown as {
    action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
    setAuth: (value: string) => void;
  };
  try {
    await auth.action(api.auth.signIn, {
      provider: "email-otp",
      params: { email },
    });
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
    const finished = (await auth.action(api.auth.signIn, {
      provider: "email-otp",
      params: { email, code },
    })) as { tokens?: { token?: string; accessToken?: string } };
    const jwt = finished.tokens?.token ?? finished.tokens?.accessToken;
    if (jwt) auth.setAuth(jwt);
    return c;
  } catch {
    return null;
  }
}

async function prepareFixtures(): Promise<boolean> {
  const adminKey = devAdminKey();
  if (!adminKey || !(await serverUp())) return false;
  const admin = new ConvexHttpClient(CONVEX_URL);
  (admin as unknown as { setAdminAuth: (v: string) => void }).setAdminAuth(
    adminKey,
  );
  try {
    await admin.mutation(internal.devTenantFixtures.ensureTenantFixtures, {});
    return true;
  } catch {
    return false;
  }
}

const fixturesReady = await prepareFixtures();
const runtime = fixturesReady ? describe : describe.skip;

const DAY = 86_400_000;

function serviceInput(name: string, ownerUserId: string) {
  return {
    name,
    description:
      "Citizen-facing payment intake and reconciliation for the revenue service.",
    department: "Revenue operations",
    ownerUserId: ownerUserId as Id<"users">,
    operationalStatus: "active" as const,
    criticality: "critical" as const,
    ictDependencies:
      "Payment switch (vendor-hosted), core banking API, SMTP relay",
    keyDependencies:
      "Revenue operations staff, payment switch supplier, banking interface and the nightly reconciliation batch.",
    singlePointsOfFailure: "Single vendor-hosted payment switch instance",
  };
}

function biaInput(
  serviceId: Id<"businessServices">,
  ownerUserId: Id<"users">,
  title: string,
) {
  return {
    serviceId,
    title,
    ownerUserId,
    assessmentDate: Date.now() - 2 * DAY,
    reviewDueAt: Date.now() + 180 * DAY,
    disruptionScenario:
      "Loss of the primary payment switch for an extended period, including the reconciliation batch.",
    scope: "Citizen payment intake and the nightly reconciliation feed",
    impacts: sampleImpacts("severe"),
    keyDependencies: "Payment switch supplier and the core banking interface",
    singlePointsOfFailure: "Vendor-hosted switch has no active-active pair",
    existingRecoveryArrangements:
      "Nightly database backups and a documented manual receipting workaround.",
    assumptions:
      "Staff can reach the alternate site and the supplier honours its support window.",
    limitations:
      "No recovery exercise has been performed, so the objectives are untested.",
    criticalityRationale:
      "Revenue collection stops and statutory settlement deadlines are missed.",
    rtoMinutes: 240,
    rpoMinutes: 60,
    mtpdMinutes: 480,
    minimumServiceLevel:
      "Manual receipting continues for critical payments with daily reconciliation.",
    recoveryPriority: "p1" as const,
    objectiveRationale:
      "Statutory settlement cut-off requires restoration within the same business day.",
    mtpdExceptionJustification: undefined,
  };
}

runtime("business continuity register and BIA lifecycle (runtime)", () => {
  const managerPromise = signInEmailOtp(MANAGER_EMAIL);
  const reviewerPromise = signInEmailOtp(REVIEWER_EMAIL);
  const readOnlyPromise = signInEmailOtp(READ_ONLY_EMAIL);
  const otherTenantPromise = signInEmailOtp(OTHER_TENANT_EMAIL);

  let serviceId: Id<"businessServices">;
  let biaId: Id<"businessImpactAnalyses">;
  let approvedBiaId: Id<"businessImpactAnalyses">;
  // Filled by the first test; the empty initial value makes the guards below
  // honest when a fixture identity could not sign in.
  let reviewerUserId = "" as Id<"users">;

  test("an authorized manager registers a business service", async () => {
    const manager = await managerPromise;
    const reviewer = await reviewerPromise;
    expect(manager).not.toBeNull();
    expect(reviewer).not.toBeNull();
    if (!manager || !reviewer) return;

    const options = await manager.query(api.businessServices.formOptions, {});
    reviewerUserId =
      options.members.find((m) => m.label.includes("compliance"))?.userId ??
      options.members[0].userId;
    expect(options.canManage).toBe(true);

    const created = await manager.mutation(api.businessServices.createService, {
      ...serviceInput(`${RUN_TAG} citizen payments`, reviewerUserId),
    });
    expect(created.reference).toMatch(/^BS-\d{3,}$/);
    serviceId = created.serviceId;

    const detail = await manager.query(api.businessServices.getService, {
      serviceId,
    });
    expect(detail.service.reference).toBe(created.reference);
    expect(detail.history[0].summary).toContain("registered");
    expect(detail.canManage).toBe(true);
  });

  test("concurrent registrations receive distinct references", async () => {
    const manager = await managerPromise;
    if (!manager || !reviewerUserId) return;
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        manager.mutation(api.businessServices.createService, {
          ...serviceInput(`${RUN_TAG} concurrent service ${n}`, reviewerUserId),
          criticality: "medium" as const,
        }),
      ),
    );
    const references = results.map((r) => r.reference);
    expect(new Set(references).size).toBe(3);
  });

  test("a read-only member can read but cannot write", async () => {
    const readOnly = await readOnlyPromise;
    expect(readOnly).not.toBeNull();
    if (!readOnly) return;

    const list = await readOnly.query(api.businessServices.listServices, {});
    expect(list.canManage).toBe(false);
    expect(list.rows.length).toBeGreaterThan(0);

    await expect(
      readOnly.mutation(api.businessServices.createService, {
        ...serviceInput(`${RUN_TAG} forbidden service`, reviewerUserId),
      }),
    ).rejects.toThrow();

    const summary = await readOnly.query(
      api.businessImpactAnalyses.continuitySummary,
      {},
    );
    expect(summary.canManage).toBe(false);
    expect(summary.services.total).toBeGreaterThan(0);
    expect(summary).not.toHaveProperty("readinessScore");
  });

  test("another organization cannot read or write this tenant's continuity data", async () => {
    const other = await otherTenantPromise;
    if (!other) return;

    await expect(
      other.query(api.businessServices.getService, { serviceId }),
    ).rejects.toThrow(/not found in your organization/i);

    await expect(
      other.mutation(api.businessServices.updateService, {
        serviceId,
        ...serviceInput(`${RUN_TAG} hijacked`, reviewerUserId),
      }),
    ).rejects.toThrow();

    const otherList = await other.query(api.businessServices.listServices, {});
    expect(otherList.rows.some((row) => row._id === serviceId)).toBe(false);
  });

  test("a BIA is created as a draft with normalized objectives", async () => {
    const manager = await managerPromise;
    if (!manager) return;

    const created = await manager.mutation(
      api.businessImpactAnalyses.createBia,
      biaInput(serviceId, reviewerUserId, `${RUN_TAG} payments BIA`),
    );
    expect(created.reference).toMatch(/^BIA-\d{3,}$/);
    biaId = created.biaId;

    const detail = await manager.query(api.businessImpactAnalyses.getBia, {
      biaId,
    });
    expect(detail.bia.status).toBe("draft");
    expect(detail.bia.version).toBe(1);
    expect(detail.bia.rtoMinutes).toBe(240);
    expect(detail.bia.rpoLabel).toBe("1 hour(s)");
    expect(detail.bia.mtpdLabel).toBe("8 hour(s)");
    expect(detail.bia.impacts.financial.severity).toBe("severe");
    expect(detail.service.reference).toBeTruthy();
  });

  test("impact and recovery-objective validation is enforced server-side", async () => {
    const manager = await managerPromise;
    if (!manager) return;

    await expect(
      manager.mutation(api.businessImpactAnalyses.createBia, {
        ...biaInput(serviceId, reviewerUserId, `${RUN_TAG} bad impacts`),
        impacts: {
          ...sampleImpacts("low"),
          financial: { severity: "low", notes: "short" },
        },
      }),
    ).rejects.toThrow(/rationale must be at least/i);

    await expect(
      manager.mutation(api.businessImpactAnalyses.createBia, {
        ...biaInput(serviceId, reviewerUserId, `${RUN_TAG} contradictory`),
        rtoMinutes: 600,
        mtpdMinutes: 240,
      }),
    ).rejects.toThrow(/maximum tolerable/i);

    await expect(
      manager.mutation(api.businessImpactAnalyses.createBia, {
        ...biaInput(serviceId, reviewerUserId, `${RUN_TAG} no rto`),
        rtoMinutes: undefined as unknown as number,
      }),
    ).rejects.toThrow();
  });

  test("the preparer cannot approve their own analysis", async () => {
    const manager = await managerPromise;
    if (!manager) return;

    await manager.mutation(api.businessImpactAnalyses.submitBia, { biaId });
    const submitted = await manager.query(api.businessImpactAnalyses.getBia, {
      biaId,
    });
    expect(submitted.bia.status).toBe("in_review");
    expect(submitted.bia.submittedByLabel).toBeTruthy();

    await expect(
      manager.mutation(api.businessImpactAnalyses.reviewBia, {
        biaId,
        decision: "approved",
        reviewNotes:
          "Attempting self-approval must be refused by the server, not hidden by the UI.",
      }),
    ).rejects.toThrow(/preparer cannot review their own/i);

    // A submitted BIA is also no longer editable.
    await expect(
      manager.mutation(api.businessImpactAnalyses.updateBia, {
        ...biaInput(serviceId, reviewerUserId, `${RUN_TAG} late edit`),
        biaId,
      }),
    ).rejects.toThrow(/draft BIA can be edited/i);
  });

  test("an independent reviewer approves and the record is frozen", async () => {
    const reviewer = await reviewerPromise;
    if (!reviewer) return;

    const approved = await reviewer.mutation(
      api.businessImpactAnalyses.reviewBia,
      {
        biaId,
        decision: "approved",
        reviewNotes:
          "Impacts, dependencies and recovery objectives are consistent with the recorded scope.",
      },
    );
    expect(approved.status).toBe("approved");
    approvedBiaId = biaId;

    const detail = await reviewer.query(api.businessImpactAnalyses.getBia, {
      biaId,
    });
    expect(detail.bia.status).toBe("approved");
    expect(detail.bia.approvedAt).toBeTruthy();
    expect(detail.bia.reviewedByLabel).toBeTruthy();
    expect(detail.history.some((e) => e.type === "bia_approved")).toBe(true);

    // Approval is not repeatable: a second decision on an approved BIA is
    // refused, so concurrent approvals cannot both succeed.
    await expect(
      reviewer.mutation(api.businessImpactAnalyses.reviewBia, {
        biaId,
        decision: "approved",
        reviewNotes:
          "A duplicate approval attempt must be refused because the record is already approved.",
      }),
    ).rejects.toThrow(/submitted for review/i);
  });

  test("an approved BIA cannot be edited or returned to draft", async () => {
    const manager = await managerPromise;
    if (!manager) return;

    await expect(
      manager.mutation(api.businessImpactAnalyses.updateBia, {
        ...biaInput(serviceId, reviewerUserId, `${RUN_TAG} rewritten`),
        biaId: approvedBiaId,
      }),
    ).rejects.toThrow(/draft BIA can be edited/i);

    await expect(
      manager.mutation(api.businessImpactAnalyses.submitBia, {
        biaId: approvedBiaId,
      }),
    ).rejects.toThrow(/draft BIA can be submitted/i);
  });

  test("a revision preserves the approved version and supersedes it only on approval", async () => {
    const manager = await managerPromise;
    const reviewer = await reviewerPromise;
    if (!manager || !reviewer) return;

    const revision = await manager.mutation(
      api.businessImpactAnalyses.reviseBia,
      { biaId: approvedBiaId },
    );
    expect(revision.version).toBe(2);
    expect(revision.reference).not.toBe("");

    const original = await manager.query(api.businessImpactAnalyses.getBia, {
      biaId: approvedBiaId,
    });
    // Opening a revision does not rewrite or supersede the approved record.
    expect(original.bia.status).toBe("approved");
    expect(original.bia.version).toBe(1);

    const draft = await manager.query(api.businessImpactAnalyses.getBia, {
      biaId: revision.biaId,
    });
    expect(draft.bia.status).toBe("draft");
    expect(draft.bia.revisionOf).toBe(approvedBiaId);

    await manager.mutation(api.businessImpactAnalyses.submitBia, {
      biaId: revision.biaId,
    });
    await reviewer.mutation(api.businessImpactAnalyses.reviewBia, {
      biaId: revision.biaId,
      decision: "approved",
      reviewNotes:
        "The revision updates the objectives and is independently approved on its own merits.",
    });

    const superseded = await manager.query(api.businessImpactAnalyses.getBia, {
      biaId: approvedBiaId,
    });
    expect(superseded.bia.status).toBe("superseded");
    expect(superseded.bia.supersededByBiaId).toBe(revision.biaId);
    // The earlier version and its review history remain readable.
    expect(superseded.bia.reviewedByLabel).toBeTruthy();
    expect(superseded.history.some((e) => e.type === "bia_approved")).toBe(true);
    expect(superseded.versions.length).toBeGreaterThanOrEqual(2);
  });

  test("a rejected analysis returns to draft with the decision recorded", async () => {
    const manager = await managerPromise;
    const reviewer = await reviewerPromise;
    if (!manager || !reviewer) return;

    const created = await manager.mutation(
      api.businessImpactAnalyses.createBia,
      biaInput(serviceId, reviewerUserId, `${RUN_TAG} returned BIA`),
    );
    await manager.mutation(api.businessImpactAnalyses.submitBia, {
      biaId: created.biaId,
    });
    await reviewer.mutation(api.businessImpactAnalyses.reviewBia, {
      biaId: created.biaId,
      decision: "rejected",
      reviewNotes:
        "The stated recovery arrangements are not evidenced; revise the assumptions.",
    });

    const detail = await manager.query(api.businessImpactAnalyses.getBia, {
      biaId: created.biaId,
    });
    expect(detail.bia.status).toBe("draft");
    expect(detail.bia.reviewDecision).toBe("rejected");
    expect(detail.bia.reviewedByLabel).toBeTruthy();
    expect(detail.history.some((e) => e.type === "bia_returned")).toBe(true);

    // A refused analysis is never approved, so it cannot be superseded.
    expect(detail.bia.approvedAt).toBeNull();
  });

  test("recovery objectives reflect the latest analysis per service", async () => {
    const manager = await managerPromise;
    if (!manager) return;
    const result = await manager.query(
      api.businessImpactAnalyses.recoveryObjectives,
      {},
    );
    const row = result.objectives.find((o) => o.serviceId === serviceId);
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.rtoMinutes).toBe(240);
    expect(row.rpoMinutes).toBe(60);
    expect(row.recoveryPriority).toBe("p1");
    expect(result.counts.rpoRecorded).toBeGreaterThan(0);
  });

  test("the continuity summary separates coverage from assurance", async () => {
    const manager = await managerPromise;
    if (!manager) return;
    const summary = await manager.query(
      api.businessImpactAnalyses.continuitySummary,
      {},
    );
    expect(summary.services.total).toBeGreaterThan(0);
    expect(summary.coverage.withApprovedBia).toBeGreaterThan(0);
    expect(summary.coverage.missingBia).toBeGreaterThanOrEqual(0);
    expect(summary.review.awaitingReview).toBeGreaterThanOrEqual(0);
    expect(summary.truncated.services).toBe(false);
    expect(summary).not.toHaveProperty("readiness");
    expect(summary).not.toHaveProperty("resilience");
  });

  test("pagination is bounded and keyset-stable", async () => {
    const manager = await managerPromise;
    if (!manager) return;
    const first = await manager.query(api.businessServices.listServices, {
      limit: 2,
    });
    expect(first.rows.length).toBeLessThanOrEqual(2);
    expect(first.counts.total).toBeGreaterThan(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    if (!first.nextCursor) return;

    const second = await manager.query(api.businessServices.listServices, {
      limit: 2,
      cursor: first.nextCursor,
    });
    const firstIds = new Set(first.rows.map((row) => row._id));
    expect(second.rows.every((row) => !firstIds.has(row._id))).toBe(true);
    expect(second.rows[0].createdAt).toBeLessThan(first.nextCursor);
  });

  test("foreign BIA and service ids are refused", async () => {
    const other = await otherTenantPromise;
    const manager = await managerPromise;
    if (!other || !manager) return;

    // Tenant A has its own identity; the tenant-M fixture owner is not a
    // member there, so the foreign service must be registered by a local owner.
    const options = await other.query(api.businessServices.formOptions, {});
    const foreignOwner = options.currentUserId;
    const foreignService = await other.mutation(
      api.businessServices.createService,
      serviceInput(`${RUN_TAG} tenant A service`, foreignOwner),
    );

    await expect(
      manager.mutation(
        api.businessImpactAnalyses.createBia,
        biaInput(foreignService.serviceId, foreignOwner, `${RUN_TAG} cross`),
      ),
    ).rejects.toThrow(/not found in your organization/i);

    const ownDetail = await manager.query(api.businessImpactAnalyses.getBia, {
      biaId: approvedBiaId,
    });
    expect(ownDetail.bia.status).toBe("superseded");
    await expect(
      other.query(api.businessImpactAnalyses.getBia, { biaId: approvedBiaId }),
    ).rejects.toThrow(/not found in your organization/i);
  });

  test("two concurrent approvals cannot both be recorded", async () => {
    const manager = await managerPromise;
    const reviewer = await reviewerPromise;
    if (!manager || !reviewer) return;

    const created = await manager.mutation(
      api.businessImpactAnalyses.createBia,
      biaInput(serviceId, reviewerUserId, `${RUN_TAG} concurrent approval`),
    );
    await manager.mutation(api.businessImpactAnalyses.submitBia, {
      biaId: created.biaId,
    });

    const notes =
      "Independent approval attempted twice in the same tick to prove the lifecycle cannot be bypassed.";
    const results = await Promise.allSettled([
      reviewer.mutation(api.businessImpactAnalyses.reviewBia, {
        biaId: created.biaId,
        decision: "approved",
        reviewNotes: notes,
      }),
      reviewer.mutation(api.businessImpactAnalyses.reviewBia, {
        biaId: created.biaId,
        decision: "approved",
        reviewNotes: notes,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const detail = await manager.query(api.businessImpactAnalyses.getBia, {
      biaId: created.biaId,
    });
    expect(detail.bia.status).toBe("approved");
    // Exactly one approval transition exists in the append-only history.
    expect(detail.history.filter((e) => e.type === "bia_approved")).toHaveLength(1);
    expect(detail.history.filter((e) => e.type === "bia_submitted")).toHaveLength(1);
  }, 120000);

  test("approval is attributed to the reviewer, never the preparer", async () => {
    const manager = await managerPromise;
    const reviewer = await reviewerPromise;
    if (!manager || !reviewer) return;

    const created = await manager.mutation(
      api.businessImpactAnalyses.createBia,
      biaInput(serviceId, reviewerUserId, `${RUN_TAG} attribution`),
    );
    await manager.mutation(api.businessImpactAnalyses.submitBia, {
      biaId: created.biaId,
    });
    await reviewer.mutation(api.businessImpactAnalyses.reviewBia, {
      biaId: created.biaId,
      decision: "approved",
      reviewNotes:
        "Objectives and impacts are consistent with the recorded scope and dependencies.",
    });

    const detail = await manager.query(api.businessImpactAnalyses.getBia, {
      biaId: created.biaId,
    });
    expect(detail.bia.preparedByUserId).not.toBe(detail.bia.reviewedByUserId);
    expect(detail.bia.reviewedByLabel).toBeTruthy();

    const approval = detail.history.find((e) => e.type === "bia_approved");
    expect(approval).toBeDefined();
    // The audit/event trail names the reviewer who acted, not the preparer.
    expect(approval!.actorLabel).toBe(detail.bia.reviewedByLabel);
    expect(approval!.actorLabel).not.toBe(detail.bia.preparedByLabel);
    const submission = detail.history.find((e) => e.type === "bia_submitted");
    expect(submission!.actorLabel).toBe(detail.bia.preparedByLabel);
  }, 120000);
});
