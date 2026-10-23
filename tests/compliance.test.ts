import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api, internal } from "../src/convex/_generated/api";

/**
 * Phase 3C — Batch 1: compliance framework catalogue and control register.
 * =====================================================================
 * Structural guards (permission-gated reads/writes, active-membership
 * enforcement, organization from the access context, identifier uniqueness,
 * bounded paginated reads, append-only audit logging, no fabricated scores)
 * plus runtime checks against the development backend:
 *
 *  - tenant M is the disposable fixture organization this suite writes to
 *    (risky-manage roles are NOT given to tenants A and B, whose read-only
 *    assertions the risk suites rely on);
 *  - tenants A and B can read their own (empty) compliance registers and can
 *    never see tenant M's frameworks or controls;
 *  - identifiers are validated and unique per organization (frameworks) and
 *    per framework (controls);
 *  - read-only roles and unauthenticated callers are refused writes;
 *  - every write lands in the immutable audit trail with actor + framework
 *    attribution;
 *  - implementation status is never presented as a test result.
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

function devAdminKey(): string | null {
  try {
    const raw = readFileSync(
      join(process.cwd(), ".convex/local/default/config.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { adminKey?: unknown };
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
    if (jwt) (c as unknown as { setAuth: (value: string) => void }).setAuth(jwt);
    return c;
  } catch {
    return null;
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

type Fixture = {
  organizationId: string;
  organizationCode: string;
  userId: string;
  email: string;
  riskId: string;
};

type FrameworkPage = {
  rows: Array<{
    _id: string;
    code: string;
    name: string;
    status: string;
    counts: { controls: number; implemented: number };
  }>;
  continueCursor: string;
  isDone: boolean;
  summary: { total: number; active: number; planned: number; retired: number };
};

type ControlPage = {
  rows: Array<{
    _id: string;
    code: string;
    title: string;
    implementationStatus: string;
    effectiveness: string;
    ownerName: string | null;
    frameworkId: string | null;
  }>;
  continueCursor: string;
  isDone: boolean;
  summary: { total: number; byStatus: Record<string, number> };
};

let fixtureA: Fixture | null = null;
let fixtureB: Fixture | null = null;
let fixtureM: Fixture | null = null;
let complianceManagerEmail: string | null = null;
let asManager: ConvexHttpClient | null = null;
let asViewerA: ConvexHttpClient | null = null;
let asViewerB: ConvexHttpClient | null = null;
let asReadOnlyM: ConvexHttpClient | null = null;

const RUN_TAG = `IIT-${Date.now().toString(36).toUpperCase()}`;
const suffix = Date.now().toString(36);

/**
 * Delete this suite's fixture records again: scoped server-side to the
 * disposable IITAMS-TEST-M tenant, batched, and it never touches auditLogs.
 * Best-effort — teardown must not turn a real verification result into an
 * error.
 */
async function resetComplianceFixtureData(): Promise<void> {
  try {
    const adminKey = devAdminKey();
    if (!adminKey || !(await serverUp())) return;
    const admin = new ConvexHttpClient(CONVEX_URL);
    (admin as unknown as { setAdminAuth: (v: string) => void }).setAdminAuth(
      adminKey,
    );
    for (let i = 0; i < 40; i += 1) {
      const result = (await admin.mutation(
        internal.devTenantFixtures.resetComplianceFixtures,
        { maxRecords: 50 },
      )) as { remaining: number };
      if (result.remaining === 0) return;
    }
  } catch (e) {
    console.warn(`[compliance:WARN] fixture cleanup skipped: ${String(e).slice(0, 200)}`);
  }
}

beforeAll(async () => {
  if (!(await serverUp()) || !token) return;
  const adminKey = devAdminKey();
  if (!adminKey) return;
  const admin = new ConvexHttpClient(CONVEX_URL);
  (admin as unknown as { setAdminAuth: (v: string) => void }).setAdminAuth(adminKey);
  const result = (await admin.mutation(internal.devTenantFixtures.ensureTenantFixtures, {})) as {
    organizations: Fixture[];
    complianceAdmin: {
      organizationId: string;
      organizationCode: string;
      userId: string;
      email: string;
    } | null;
  };
  fixtureA = result.organizations.find((o) => o.organizationCode === "IITAMS-TEST-A") ?? null;
  fixtureB = result.organizations.find((o) => o.organizationCode === "IITAMS-TEST-B") ?? null;
  fixtureM = result.organizations.find((o) => o.organizationCode === "IITAMS-TEST-M") ?? null;
  complianceManagerEmail = result.complianceAdmin?.email ?? null;
  if (!fixtureA || !fixtureB || !fixtureM || !complianceManagerEmail) return;
  asManager = await signInEmailOtp(complianceManagerEmail);
  asViewerA = await signInEmailOtp(fixtureA.email);
  asViewerB = await signInEmailOtp(fixtureB.email);
  // Tenant M's ordinary member holds no compliance.manage → read-only.
  asReadOnlyM = await signInEmailOtp(fixtureM.email);
  // Fixture provisioning plus four OTP sign-ins is not a 5-second operation.
}, 180000);

afterAll(async () => {
  await resetComplianceFixtureData();
}, 120000);

// ============================================================================
// Structural
// ============================================================================

describe("Compliance — structural guards", () => {
  const src = readFileSync("src/convex/compliance.ts", "utf8");
  const schemaSrc = readFileSync("src/convex/schema.ts", "utf8");
  const libSrc = readFileSync("src/lib/compliance.ts", "utf8");
  const frameworksPage = readFileSync(
    "src/components/iitams/compliance/ComplianceFrameworksPage.tsx",
    "utf8",
  );
  const controlsPage = readFileSync(
    "src/components/iitams/compliance/ComplianceControlsPage.tsx",
    "utf8",
  );
  const mainSrc = readFileSync("src/main.tsx", "utf8");

  test("reads require compliance.view and writes require compliance.manage with active membership", () => {
    const queries = [...src.matchAll(/export const (\w+) = query\(\{/g)];
    expect(queries.length).toBeGreaterThanOrEqual(4);
    for (const fn of queries) {
      const body = src.slice(fn.index ?? 0, (fn.index ?? 0) + 700);
      expect(body).toContain("requireViewer(ctx)");
    }
    expect(src).toContain('requirePermission(ctx, "compliance.view")');
    expect(src).toContain('requirePermission(ctx, "compliance.manage")');
    // Active membership is a write precondition, not a UI concern.
    expect(src).toContain(
      'if (!access.isProvisioned) {\n    throw new Error("Caller membership is not active");',
    );
    const mutations = [...src.matchAll(/export const (\w+) = mutation\(\{/g)];
    expect(mutations.length).toBe(4); // create/update framework, create/update control
    for (const fn of mutations) {
      const body = src.slice(fn.index ?? 0);
      const nextExport = body.indexOf("\nexport const", 10);
      const scoped = nextExport === -1 ? body : body.slice(0, nextExport);
      expect(scoped).toContain("requireManager(ctx)");
    }
  });

  test("the organization always comes from the access context, never from arguments", () => {
    expect(src).not.toContain('organizationId: v.id("organizations")');
    expect(src).not.toContain("organizationCode: v.string()");
    expect(src).toContain('q.eq("organizationId", viewer.organizationId)');
    expect(src).toContain('q.eq("organizationId", manager.organizationId)');
    // Every id-addressed write re-checks the record's organization.
    expect(src).toContain("Framework not found in your organization");
    expect(src).toContain("Control not found in your organization");
  });

  test("every write appends one immutable audit entry naming actor and framework", () => {
    const mutations = [...src.matchAll(/export const (\w+) = mutation\(\{/g)];
    for (const fn of mutations) {
      const body = src.slice(fn.index ?? 0);
      const nextExport = body.indexOf("\nexport const", 10);
      const scoped = nextExport === -1 ? body : body.slice(0, nextExport);
      expect(scoped).toContain("logAudit(ctx, {");
      expect(scoped).toContain("actorId: manager.userId");
      expect(scoped).toContain("actorLabel: manager.label");
      expect(scoped).toContain("organizationId: manager.organizationId");
    }
    expect(src).toContain('"compliance.framework_created"');
    expect(src).toContain('"compliance.framework_updated"');
    expect(src).toContain('"compliance.control_created"');
    expect(src).toContain('"compliance.control_updated"');
    // Control entries name the framework they belong to.
    expect(src).toContain("relatedEntityType: \"complianceFrameworks\"");
  });

  test("no fabricated compliance score or test result is produced", () => {
    // Implementation is operational state; effectiveness stays untested.
    expect(src).toContain('effectiveness: "not_tested"');
    expect(src).not.toContain("complianceScorePct:");
    expect(src).not.toContain("totalControls:");
    expect(src).not.toContain("implementedControls:");
    // The register page never renders a percentage for a framework.
    expect(frameworksPage).not.toContain("complianceScorePct");
    expect(controlsPage).not.toContain("complianceScorePct");
    // Legacy demo aggregates are exposed only when they already exist.
    expect(src).toContain("legacyDemoScorePct");
  });

  test("reads are bounded, paginated and index-backed", () => {
    expect(src).toContain("CONTROL_PAGE_DEFAULT");
    expect(src).toContain("CONTROL_PAGE_MAX");
    // Two paginated queries; the control register has one cursor per index
    // branch (framework-scoped and organization-wide), never more than one
    // paginate call per execution.
    expect(src.match(/\.paginate\(/g)?.length).toBe(3);
    expect(src).toContain("cursor: args.cursor ?? null");
    expect(src).toContain("continueCursor: page.continueCursor");
    expect(src).toContain("CONTROL_SCAN_LIMIT");
    expect(src).toContain("FRAMEWORK_CONTROL_SCAN");
    expect(frameworksPage).toContain("Load older frameworks");
    expect(controlsPage).toContain("Load more controls");
  });

  test("schema reuses the existing compliance tables with uniqueness indexes", () => {
    // Extended in place: still exactly one framework table and one control table.
    expect(schemaSrc.match(/complianceFrameworks: defineTable\(/g)?.length).toBe(1);
    expect(schemaSrc.match(/^\s+controls: defineTable\(/gm)?.length).toBe(1);
    expect(schemaSrc).toContain('.index("by_organization_code", ["organizationId", "code"])');
    expect(schemaSrc).toContain('.index("by_organization_framework_code", [');
    // The Phase-1 aggregates are optional now: no score is required anywhere.
    expect(schemaSrc).toContain("complianceScorePct: v.optional(v.number())");
    expect(schemaSrc).toContain("totalControls: v.optional(v.number())");
    expect(schemaSrc).toContain("implementedControls: v.optional(v.number())");
    expect(schemaSrc).toContain("implementationStatus: v.optional(controlImplementationStatusValidator)");
    // Vocabulary lives in the shared lib, not duplicated in the schema.
    expect(libSrc).toContain("export function isValidFrameworkIdentifier");
    expect(libSrc).toContain("export function isValidControlIdentifier");
  });

  test("fixture cleanup is dev-gated, fixture-tenant-scoped and never touches audit history", () => {
    const fixturesSrc = readFileSync("src/convex/devTenantFixtures.ts", "utf8");
    const resetIdx = fixturesSrc.indexOf("export const resetComplianceFixtures");
    expect(resetIdx).toBeGreaterThan(-1);
    const resetEnd = fixturesSrc.indexOf("\nexport const", resetIdx + 10);
    const resetBody = fixturesSrc.slice(resetIdx, resetEnd === -1 ? undefined : resetEnd);
    expect(resetBody).toContain("internalMutation(");
    expect(resetBody).toContain("guestAuthEnabled()");
    expect(resetBody).toContain('fixtureOrganization(ctx, "IITAMS-TEST-M")');
    // A framework is only removed once it has no controls left, so the
    // cleanup can never orphan register rows.
    expect(resetBody).toContain("remainingControls");
    // Audit history survives: no cleanup path queries or deletes auditLogs
    // (the quoted table name only appears where the table is actually used),
    // and the shared demo organization is never targeted.
    expect(resetBody).not.toContain('"auditLogs"');
    // Every row the cleanup can see comes from a compliance table of the
    // fixture organization, and every deletion targets one of those rows —
    // never a user, risk, audit or engagement record.
    const queriedTables = new Set(
      [...resetBody.matchAll(/\.query\("([^"]+)"\)/g)].map((m) => m[1]),
    );
    expect(queriedTables).toEqual(
      new Set([
        // Batch 4 (findings & remediation) additions.
        "complianceFindingEvents",
        "complianceRemediationActions",
        "complianceFindings",
        "complianceAssessmentEvidence",
        "complianceAssessmentItems",
        "complianceAssessments",
        "complianceEvidenceMappings",
        "complianceEvidence",
        "complianceControlTests",
        "controls",
        "complianceFrameworks",
      ]),
    );
    for (const deletion of resetBody.matchAll(/ctx\.db\.delete\(([\w.]+)\)/g)) {
      expect(deletion[1]).toMatch(
        /^(mapping|record|test|control|framework|link|item|assessment|event|action|finding)\._id$/,
      );
    }
    expect(resetBody).not.toContain("userProfiles");
    expect(resetBody).not.toContain('"risks"');
    expect(resetBody).not.toContain('"auditEngagements"');
    expect(resetBody).not.toContain("IITAMS-DEMO");
    expect(fixturesSrc).toContain('"IITAMS-TEST-M": ["R-001"]');
  });

  test("framework identifiers are immutable once created", () => {
    const updateIdx = src.indexOf("export const updateFramework = mutation({");
    const nextExport = src.indexOf("\nexport const", updateIdx + 10);
    const updateBody = src.slice(updateIdx, nextExport === -1 ? undefined : nextExport);
    // An update can never re-key a framework: the identifier is not accepted at
    // all, so a duplicate identifier cannot be introduced by an edit.
    expect(updateBody).not.toContain("identifier");
    expect(updateBody).not.toContain("code:");
    // …and the schema index the create path relies on is not bypassed.
    expect(src).toContain("by_organization_code");
  });

  test("the dashboard reports unassessed frameworks honestly instead of 0%", () => {
    const dashboardSrc = readFileSync("src/convex/dashboard.ts", "utf8");
    const dashboardPage = readFileSync("src/pages/Dashboard.tsx", "utf8");
    // Only rows that already carry a legacy demo score contribute…
    expect(dashboardSrc).toContain("scoredFrameworks");
    expect(dashboardSrc).toContain('typeof f.complianceScorePct === "number"');
    // …and with none, the KPI is null rather than a fabricated 0.
    expect(dashboardSrc).toContain(": null;");
    expect(dashboardPage).toContain('data.kpis.complianceScorePct ?? "—"');
    expect(dashboardPage).toContain("No assessed framework yet");
  });

  test("both compliance pages are routed, permission-gated and offer read-only access", () => {
    expect(mainSrc).toContain('path="/compliance/frameworks"');
    expect(mainSrc).toContain('path="/compliance/controls"');
    expect(mainSrc).toContain("ComplianceFrameworksPage");
    expect(mainSrc).toContain("ComplianceControlsPage");
    for (const page of [frameworksPage, controlsPage]) {
      expect(page).toContain("canView");
      expect(page).toContain("canManage");
      expect(page).toContain("ListSkeleton");
      expect(page).toContain("EmptyState");
      expect(page).toContain("ComplianceUnauthorized");
    }
  });
});

// ============================================================================
// Runtime
// ============================================================================

describe("Compliance — runtime", () => {
  test(
    "frameworks validate their fields and stay unique within the organization",
    async () => {
      if (!(await serverUp()) || !token) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      if (!asManager) {
        throw new Error("[test:PREREQ-FAILED] compliance fixture sign-in unavailable");
      }
      const client = asManager;

      const created = (await client.mutation(api.compliance.createFramework, {
        name: `Fixture framework ${suffix}`,
        identifier: `${RUN_TAG}-F1`,
        version: "2026.1",
        issuingAuthority: "Test authority",
        description: "Compliance batch 1 fixture framework",
        scope: "Sandbox systems only",
        effectiveDate: Date.now(),
        status: "active",
      })) as { frameworkId: string };
      expect(created.frameworkId).toBeTruthy();

      // A second framework with the same identifier is refused, whatever the
      // case or spacing, because identifiers are canonicalized.
      await expect(
        client
          .mutation(api.compliance.createFramework, {
            name: "Duplicate framework",
            identifier: `${RUN_TAG.toLowerCase()}-f1`,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/already exists in your organization/i);

      // Malformed identifiers and over-long fields are refused server-side.
      await expect(
        client
          .mutation(api.compliance.createFramework, {
            name: "Bad identifier",
            identifier: "no spaces allowed!",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/identifier/i);
      await expect(
        client
          .mutation(api.compliance.createFramework, {
            name: "x".repeat(201),
            identifier: `${RUN_TAG}-LONG`,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/at most 200 characters/i);

      // The register reports it with no control count invented.
      const page = (await client.query(api.compliance.listFrameworks, {
        search: `${RUN_TAG}-F1`,
      })) as FrameworkPage;
      const row = page.rows.find((r) => r.code === `${RUN_TAG}-F1`);
      expect(row).toBeDefined();
      expect(row!.counts.controls).toBe(0);
      expect(row!.counts.implemented).toBe(0);
      expect(page.summary.total).toBeGreaterThanOrEqual(1);
    },
    120000,
  );

  test(
    "controls link to a framework with identifiers unique inside that framework",
    async () => {
      if (!asManager) {
        throw new Error("[test:PREREQ-FAILED] compliance fixture sign-in unavailable");
      }
      const client = asManager;

      const f1 = (await client.mutation(api.compliance.createFramework, {
        name: `Control host A ${suffix}`,
        identifier: `${RUN_TAG}-C1`,
      })) as { frameworkId: string };
      const f2 = (await client.mutation(api.compliance.createFramework, {
        name: `Control host B ${suffix}`,
        identifier: `${RUN_TAG}-C2`,
      })) as { frameworkId: string };

      const control = (await client.mutation(api.compliance.createControl, {
        frameworkId: f1.frameworkId as never,
        identifier: "A.5.1",
        title: "Policies for information security",
        description: "Fixture control",
        domain: "governance",
        objective: "Provide management direction for information security",
        sourceReference: "Clause 5.1 of the framework text",
        applicability: "applicable",
        implementationStatus: "in_progress",
      })) as { controlId: string };
      expect(control.controlId).toBeTruthy();

      // Duplicate identifier inside the SAME framework is refused…
      await expect(
        client
          .mutation(api.compliance.createControl, {
            frameworkId: f1.frameworkId as never,
            identifier: "A.5.1",
            title: "Duplicate control",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/already exists in framework/i);

      // …but the same clause code in a DIFFERENT framework is legitimate.
      const other = (await client.mutation(api.compliance.createControl, {
        frameworkId: f2.frameworkId as never,
        identifier: "A.5.1",
        title: "Equivalent clause in another framework",
      })) as { controlId: string };
      expect(other.controlId).toBeTruthy();

      // Validation: malformed identifier, missing title, foreign owner.
      await expect(
        client
          .mutation(api.compliance.createControl, {
            frameworkId: f1.frameworkId as never,
            identifier: "@@bad@@",
            title: "Bad identifier",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/identifier/i);
      await expect(
        client
          .mutation(api.compliance.createControl, {
            frameworkId: f1.frameworkId as never,
            identifier: "A.5.2",
            title: "   ",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/title is required/i);
      await expect(
        client
          .mutation(api.compliance.createControl, {
            frameworkId: f1.frameworkId as never,
            identifier: "A.5.3",
            title: "Foreign owner",
            ownerUserId: fixtureA!.userId as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/not an active member of your organization/i);

      // Detail view reports the linked controls without asserting assurance.
      const detail = (await client.query(api.compliance.getFramework, {
        frameworkId: f1.frameworkId as never,
      })) as {
        code: string;
        counts: { controls: number; inProgress: number; implemented: number };
        controls: Array<{ code: string; effectiveness: string }>;
      } | null;
      expect(detail).not.toBeNull();
      expect(detail!.counts.controls).toBe(1);
      expect(detail!.counts.inProgress).toBe(1);
      expect(detail!.counts.implemented).toBe(0);
      expect(detail!.controls[0].effectiveness).toBe("not_tested");

      // The register can be filtered by framework, domain and status.
      const filtered = (await client.query(api.compliance.listControls, {
        frameworkId: f1.frameworkId as never,
      })) as ControlPage;
      expect(filtered.rows.map((r) => r.code)).toEqual(["A.5.1"]);
      const byStatus = (await client.query(api.compliance.listControls, {
        implementationStatus: "implemented",
        search: "A.5.1",
      })) as ControlPage;
      expect(byStatus.rows.some((r) => r.code === "A.5.1")).toBe(false);
      const byDomain = (await client.query(api.compliance.listControls, {
        domain: "governance",
        search: "A.5.1",
      })) as ControlPage;
      expect(byDomain.rows.some((r) => r.code === "A.5.1")).toBe(true);
    },
    120000,
  );

  test(
    "read-only roles cannot write and unauthenticated callers get nothing",
    async () => {
      if (!asReadOnlyM || !fixtureM) {
        throw new Error("[test:PREREQ-FAILED] read-only fixture sign-in unavailable");
      }

      // Tenant M's ordinary member holds compliance.view only: reads succeed…
      const readable = (await asReadOnlyM.query(
        api.compliance.listFrameworks,
        {},
      )) as FrameworkPage;
      expect(Array.isArray(readable.rows)).toBe(true);

      // …while every write is refused by the server, not merely hidden. The
      // target framework is a real record in the read-only member's OWN
      // organization, so the refusal is the permission check — not an
      // unknown-id shortcut.
      if (!asManager) {
        throw new Error("[test:PREREQ-FAILED] compliance fixture sign-in unavailable");
      }
      const existing = (await asManager.mutation(api.compliance.createFramework, {
        name: `Read-only target ${suffix}`,
        identifier: `${RUN_TAG}-RO`,
      })) as { frameworkId: string };
      await expect(
        asReadOnlyM
          .mutation(api.compliance.createFramework, {
            name: "Read-only attempt",
            identifier: `${RUN_TAG}-RO2`,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/Permission denied/i);
      await expect(
        asReadOnlyM
          .mutation(api.compliance.updateFramework, {
            frameworkId: existing.frameworkId as never,
            status: "retired",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/Permission denied/i);
      await expect(
        asReadOnlyM
          .mutation(api.compliance.createControl, {
            frameworkId: existing.frameworkId as never,
            identifier: "RO-1",
            title: "Read-only control attempt",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/Permission denied/i);
      // The refused attempts changed nothing.
      const untouched = (await asManager.query(api.compliance.getFramework, {
        frameworkId: existing.frameworkId as never,
      })) as { status: string; counts: { controls: number } } | null;
      expect(untouched!.status).toBe("active");
      expect(untouched!.counts.controls).toBe(0);

      // No session at all → fails closed on every entry point.
      const stranger = new ConvexHttpClient(CONVEX_URL);
      for (const queryRef of [
        api.compliance.listFrameworks,
        api.compliance.listControls,
        api.compliance.controlOwners,
      ]) {
        await expect(
          stranger.query(queryRef, {}).then((r) => JSON.stringify(r)),
        ).rejects.toThrow(/not authenticated/i);
      }

      // A role without compliance.view (executive viewer) is refused reads.
      const viewerEmail = `compliance-viewer-${suffix}@check.example`;
      expect(
        await harnessPost("/api/dev-seed-test-user", { email: viewerEmail }),
      ).toBe(true);
      const demoAdmin = await signInAnonymous();
      await demoAdmin.mutation(api.session.joinDemoOrganization, {});
      const demoSession = (await demoAdmin.query(api.session.getSession, {})) as {
        userId?: string;
      } | null;
      if (demoSession?.userId) {
        expect(
          await harnessPost("/api/dev-grant-demo-role", {
            userId: demoSession.userId,
            role: "admin",
            ttlMinutes: 60,
          }),
        ).toBe(true);
        const provisioned = (await demoAdmin.mutation(api.admin.provisionMember, {
          email: viewerEmail,
          initialRole: "member",
        })) as { ok?: boolean; profileId?: string };
        if (provisioned.ok && provisioned.profileId) {
          await demoAdmin.mutation(api.admin.changeMemberRole, {
            profileId: provisioned.profileId as never,
            role: "executive_viewer",
          });
          const viewer = await signInEmailOtp(viewerEmail);
          if (viewer) {
            await expect(
              viewer
                .query(api.compliance.listFrameworks, {})
                .then((r) => JSON.stringify(r)),
            ).rejects.toThrow(/Permission denied/i);
          }
        }
      }
    },
    120000,
  );

  test(
    "frameworks and controls never cross the organization boundary",
    async () => {
      if (!asManager || !asViewerA || !asViewerB || !fixtureA) {
        throw new Error("[test:PREREQ-FAILED] fixture clients unavailable");
      }
      const mine = (await asManager.mutation(api.compliance.createFramework, {
        name: `Isolation framework ${suffix}`,
        identifier: `${RUN_TAG}-ISO`,
      })) as { frameworkId: string };
      await asManager.mutation(api.compliance.createControl, {
        frameworkId: mine.frameworkId as never,
        identifier: "IS-1",
        title: "Isolation control",
      });

      // Reads from other tenants never see tenant M's records.
      for (const viewer of [asViewerA, asViewerB]) {
        const page = (await viewer.query(api.compliance.listFrameworks, {})) as FrameworkPage;
        expect(page.rows.some((r) => r._id === mine.frameworkId)).toBe(false);
        expect(
          await viewer.query(api.compliance.getFramework, {
            frameworkId: mine.frameworkId as never,
          }),
        ).toBeNull();
        const controls = (await viewer.query(api.compliance.listControls, {
          frameworkId: mine.frameworkId as never,
        })) as ControlPage;
        expect(controls.rows).toHaveLength(0);
        expect(controls.framework).toBeNull();
      }

      // Cross-tenant WRITES: the demo organization's administrator (a real
      // compliance manager elsewhere) cannot touch tenant M's framework.
      const demoAdmin = await signInAnonymous();
      await demoAdmin.mutation(api.session.joinDemoOrganization, {});
      const demoSession = (await demoAdmin.query(api.session.getSession, {})) as {
        userId?: string;
      } | null;
      if (!demoSession?.userId) {
        throw new Error("[test:PREREQ-FAILED] demo session unavailable");
      }
      expect(
        await harnessPost("/api/dev-grant-demo-role", {
          userId: demoSession.userId,
          role: "admin",
          ttlMinutes: 60,
        }),
      ).toBe(true);

      await expect(
        demoAdmin
          .mutation(api.compliance.createControl, {
            frameworkId: mine.frameworkId as never,
            identifier: "XS-1",
            title: "Cross-tenant control attempt",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/not found in your organization/i);
      await expect(
        demoAdmin
          .mutation(api.compliance.updateFramework, {
            frameworkId: mine.frameworkId as never,
            status: "retired",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/not found in your organization/i);

      // Tenant M's record is untouched by the refused attempts.
      const detail = (await asManager.query(api.compliance.getFramework, {
        frameworkId: mine.frameworkId as never,
      })) as { status: string; counts: { controls: number } } | null;
      expect(detail!.status).toBe("active");
      expect(detail!.counts.controls).toBe(1);

      // Cross-tenant owner assignment is refused in both directions.
      await expect(
        asManager
          .mutation(api.compliance.createControl, {
            frameworkId: mine.frameworkId as never,
            identifier: "IS-2",
            title: "Owner from another tenant",
            ownerUserId: fixtureA!.userId as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/not an active member of your organization/i);
    },
    120000,
  );

  test(
    "every write lands in the immutable audit trail with actor and framework attribution",
    async () => {
      if (!asManager) {
        throw new Error("[test:PREREQ-FAILED] compliance fixture sign-in unavailable");
      }
      const marker = `AUDIT-${suffix}`;
      const framework = (await asManager.mutation(api.compliance.createFramework, {
        name: `Audited framework ${marker}`,
        identifier: `AUD-${suffix.toUpperCase().slice(-8)}`,
      })) as { frameworkId: string };
      const control = (await asManager.mutation(api.compliance.createControl, {
        frameworkId: framework.frameworkId as never,
        identifier: "AU-1",
        title: `Audited control ${marker}`,
        implementationStatus: "planned",
      })) as { controlId: string };
      await asManager.mutation(api.compliance.updateControl, {
        controlId: control.controlId as never,
        implementationStatus: "implemented",
      });

      // The tenant M compliance manager holds admin.view, so the audit query
      // is available exactly as it is to a real administrator.
      const frameworkLogs = (await asManager.query(api.admin.listAuditLogs, {
        action: "compliance.framework_created",
      })) as Array<{
        action: string;
        entityType: string;
        entityId?: string;
        actorLabel?: string;
        relatedEntityType?: string;
      }>;
      const frameworkEntry = frameworkLogs.find(
        (l) => l.entityId === framework.frameworkId,
      );
      expect(frameworkEntry).toBeDefined();
      expect(frameworkEntry!.entityType).toBe("complianceFrameworks");
      expect(frameworkEntry!.actorLabel).toBeTruthy();

      const controlLogs = (await asManager.query(api.admin.listAuditLogs, {
        action: "compliance.control_created",
      })) as Array<{
        entityId?: string;
        relatedEntityId?: string;
        relatedEntityType?: string;
        summary?: string;
      }>;
      const controlEntry = controlLogs.find((l) => l.entityId === control.controlId);
      expect(controlEntry).toBeDefined();
      expect(controlEntry!.relatedEntityType).toBe("complianceFrameworks");
      expect(controlEntry!.relatedEntityId).toBe(framework.frameworkId);

      // The implementation change is recorded as its own entry — history is
      // appended, never rewritten.
      const updateLogs = (await asManager.query(api.admin.listAuditLogs, {
        action: "compliance.control_updated",
      })) as Array<{ entityId?: string; summary?: string }>;
      const updateEntry = updateLogs.find((l) => l.entityId === control.controlId);
      expect(updateEntry).toBeDefined();
      expect(updateEntry!.summary).toContain("implementationStatus");
      expect(controlLogs.some((l) => l.entityId === control.controlId)).toBe(true);
      // The original creation entry still reads "planned".
      const creationEntry = controlLogs.find((l) => l.entityId === control.controlId);
      expect(creationEntry!.summary).toContain("Planned");
    },
    120000,
  );

  test(
    "identifier uniqueness holds under concurrent creation",
    async () => {
      if (!asManager) {
        throw new Error("[test:PREREQ-FAILED] compliance fixture sign-in unavailable");
      }
      const client = asManager;
      const sharedIdentifier = `RACE-${suffix.toUpperCase().slice(-6)}`;

      // Four concurrent attempts at the SAME framework identifier. Convex
      // serialises the transactions and retries conflicting ones, so the
      // losing writers must observe the winner's row and refuse — exactly one
      // framework may exist at the end.
      const frameworkResults = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          client.mutation(api.compliance.createFramework, {
            name: `Concurrent framework ${suffix}`,
            identifier: sharedIdentifier,
          }),
        ),
      );
      const frameworkWinners = frameworkResults.filter(
        (r) => r.status === "fulfilled",
      );
      expect(frameworkWinners).toHaveLength(1);
      for (const rejected of frameworkResults.filter(
        (r) => r.status === "rejected",
      )) {
        expect(String((rejected as PromiseRejectedResult).reason)).toMatch(
          /already exists in your organization/i,
        );
      }
      const frameworkPage = (await client.query(api.compliance.listFrameworks, {
        search: sharedIdentifier,
      })) as FrameworkPage;
      expect(
        frameworkPage.rows.filter((r) => r.code === sharedIdentifier),
      ).toHaveLength(1);

      // The same guarantee inside one framework for a control identifier.
      const frameworkId = (frameworkWinners[0] as PromiseFulfilledResult<{
        frameworkId: string;
      }>).value.frameworkId;
      const controlResults = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          client.mutation(api.compliance.createControl, {
            frameworkId: frameworkId as never,
            identifier: "RACE.1",
            title: `Concurrent control ${suffix}`,
          }),
        ),
      );
      expect(controlResults.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const rejected of controlResults.filter((r) => r.status === "rejected")) {
        expect(String((rejected as PromiseRejectedResult).reason)).toMatch(
          /already exists in framework/i,
        );
      }
      const controlPage = (await client.query(api.compliance.listControls, {
        frameworkId: frameworkId as never,
      })) as ControlPage;
      expect(controlPage.rows.filter((r) => r.code === "RACE.1")).toHaveLength(1);
    },
    120000,
  );

  test(
    "an edit can never introduce a duplicate framework identifier",
    async () => {
      if (!asManager) {
        throw new Error("[test:PREREQ-FAILED] compliance fixture sign-in unavailable");
      }
      const client = asManager;
      const first = (await client.mutation(api.compliance.createFramework, {
        name: `Immutable A ${suffix}`,
        identifier: `IMM-A-${suffix.toUpperCase().slice(-6)}`,
      })) as { frameworkId: string };
      const second = (await client.mutation(api.compliance.createFramework, {
        name: `Immutable B ${suffix}`,
        identifier: `IMM-B-${suffix.toUpperCase().slice(-6)}`,
      })) as { frameworkId: string };

      // Attempting to re-key framework A onto B's identifier is refused by
      // argument validation: identifiers are not an editable field.
      await expect(
        client
          .mutation(api.compliance.updateFramework, {
            frameworkId: first.frameworkId as never,
            identifier: `IMM-B-${suffix.toUpperCase().slice(-6)}`,
          } as never)
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/ArgumentValidationError|does not match validator/i);

      // Both records keep their own identifiers.
      const a = (await client.query(api.compliance.getFramework, {
        frameworkId: first.frameworkId as never,
      })) as { code: string } | null;
      const b = (await client.query(api.compliance.getFramework, {
        frameworkId: second.frameworkId as never,
      })) as { code: string } | null;
      expect(a!.code).toBe(`IMM-A-${suffix.toUpperCase().slice(-6)}`);
      expect(b!.code).toBe(`IMM-B-${suffix.toUpperCase().slice(-6)}`);
    },
    120000,
  );

  test(
    "large control registers paginate without duplicates or omissions, and cleanup is scoped",
    async () => {
      if (!asManager) {
        throw new Error("[test:PREREQ-FAILED] compliance fixture sign-in unavailable");
      }
      const framework = (await asManager.mutation(api.compliance.createFramework, {
        name: `Pagination framework ${suffix}`,
        identifier: `PAG-${suffix.toUpperCase().slice(-8)}`,
      })) as { frameworkId: string };

      const createdIds: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        const row = (await asManager.mutation(api.compliance.createControl, {
          frameworkId: framework.frameworkId as never,
          identifier: `PG.${i + 1}`,
          title: `Pagination control ${suffix}-${i}`,
        })) as { controlId: string };
        createdIds.push(row.controlId);
      }

      const batch = 10;
      const first = (await asManager.query(api.compliance.listControls, {
        frameworkId: framework.frameworkId as never,
        numItems: batch,
      })) as ControlPage;
      expect(first.rows.length).toBeLessThanOrEqual(batch);
      const seen = first.rows.map((r) => r._id);
      let cursor: string | null = first.isDone ? null : first.continueCursor;
      let pages = 1;
      while (cursor && pages < 100) {
        const next = (await asManager.query(api.compliance.listControls, {
          frameworkId: framework.frameworkId as never,
          numItems: batch,
          cursor,
        })) as ControlPage;
        pages += 1;
        expect(next.rows.length).toBeLessThanOrEqual(batch);
        seen.push(...next.rows.map((r) => r._id));
        cursor = next.isDone ? null : next.continueCursor;
      }
      expect(cursor).toBeNull();
      expect(pages).toBeGreaterThan(1);
      expect(new Set(seen).size).toBe(seen.length);
      for (const id of createdIds) expect(seen).toContain(id);

      // The page size is clamped server-side: no caller can read the world.
      const clamped = (await asManager.query(api.compliance.listControls, {
        numItems: 10_000,
      })) as ControlPage;
      expect(clamped.rows.length).toBeLessThanOrEqual(100);

      // Cleanup removes this suite's fixture records and nothing else: the
      // tenant M risk baseline survives, and audit history is untouched.
      const before = (await asManager.query(api.compliance.listFrameworks, {})) as FrameworkPage;
      expect(before.rows.length).toBeGreaterThan(0);
      await resetComplianceFixtureData();
      const after = (await asManager.query(api.compliance.listFrameworks, {})) as FrameworkPage;
      expect(after.rows).toHaveLength(0);
      const controlsAfter = (await asManager.query(api.compliance.listControls, {})) as ControlPage;
      expect(controlsAfter.rows).toHaveLength(0);
      const controlsRemaining = (await asManager.query(api.compliance.listControls, {
        search: "Pagination control",
      })) as ControlPage;
      expect(controlsRemaining.rows).toHaveLength(0);
      const auditStillThere = (await asManager.query(api.admin.listAuditLogs, {
        action: "compliance.framework_created",
      })) as Array<unknown>;
      expect(auditStillThere.length).toBeGreaterThan(0);
      const risksUntouched = (await asManager.query(api.risks.listRisks, {})) as {
        items: Array<unknown>;
      };
      expect(risksUntouched.items.length).toBeGreaterThanOrEqual(1);
    },
    180000,
  );
});
