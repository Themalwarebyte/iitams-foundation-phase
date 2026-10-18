import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { logAudit, requirePermission } from "./auditAccess";
import { roleHasPermission } from "./access";
import { effectiveMembershipStatus } from "../lib/membership";
import {
  COMPLIANCE_EVIDENCE_DESCRIPTION_MAX,
  COMPLIANCE_EVIDENCE_FILENAME_MAX,
  COMPLIANCE_EVIDENCE_MAX_BYTES,
  COMPLIANCE_EVIDENCE_TYPES,
  COMPLIANCE_EVIDENCE_UNLINK_REASON_MAX,
  COMPLIANCE_SOURCE_REFERENCE_MAX,
  CONTROL_TEST_COMPLETION_MIN,
  CONTROL_TEST_EXCEPTION_MIN,
  CONTROL_TEST_OUTCOME_LABELS,
  CONTROL_TEST_PERIOD_MAX,
  CONTROL_TEST_SAMPLE_MAX,
  CONTROL_TEST_STATUS_LABELS,
  CONTROL_TEST_TEXT_MAX,
  CONTROL_TEST_TITLE_MAX,
  canTransitionControlTest,
  complianceEvidenceClassificationValidator,
  controlTestOutcomeValidator,
  controlTestStatusValidator,
  isControlTestVerdict,
  isOpenControlTest,
  mayReadRestrictedEvidence,
  type ControlTestOutcome,
  type ControlTestStatus,
} from "../lib/compliance";

/**
 * Phase 3C — Batch 2: compliance control testing and evidence mapping.
 * ===================================================================
 * Design decisions that matter for security and auditability:
 *
 *  - A test row states what was tested, how, by whom and what was observed. No
 *    mutation here writes `controls.effectiveness`, so a test record can never
 *    declare a control effective by itself: the register reports outcomes.
 *  - COMPLETED tests are immutable. Corrections are new superseding records
 *    (`supersedesTestId`), so the historical result stays readable exactly as
 *    issued and the amendment is visible in the audit trail.
 *  - Completing a test requires "adequate completion details" AND either at
 *    least one ACTIVE evidence mapping or an explicitly documented
 *    `evidenceException` — the honest way to record a control whose evidence
 *    could not be obtained.
 *  - Compliance evidence is its own record type. The audit `evidence` table is
 *    engagement/working-paper shaped and gated by `audit.manage`; reusing it
 *    would leak compliance documents into audit views and import audit
 *    lifecycle semantics. Storage and SERVER-side SHA-256 hashing follow the
 *    same pattern as `auditEvidence.ts`.
 *  - Evidence MAPPINGS are rows, not fields: unlinking records an auditable
 *    event and never deletes the evidence, its hash or the audit trail.
 *
 * Authorization: `compliance.view` for every read, `compliance.manage` plus an
 * active membership for every write. Organization always comes from the access
 * context; every framework, control, test, evidence and mapping id is
 * re-validated against it, so a foreign id is indistinguishable from a missing
 * one. Restricted evidence requires `compliance.manage` to download.
 */

const TEST_LIST_LIMIT = 500;
const TEST_PAGE_DEFAULT = 25;
const TEST_PAGE_MAX = 100;
const EVIDENCE_LIST_LIMIT = 200;
const EVIDENCE_SCAN_LIMIT = 500;
const MAPPING_LIST_LIMIT = 200;
const CONTROL_SCAN_LIMIT = 500;

interface TestingAccess {
  organizationId: Id<"organizations">;
  userId: Id<"users">;
  label: string;
  canManage: boolean;
}

async function resolveAccess(
  ctx: QueryCtx | MutationCtx,
): Promise<TestingAccess> {
  const access = await requirePermission(ctx, "compliance.view");
  if (!access.organizationId || !access.user) {
    throw new Error("No organization context");
  }
  return {
    organizationId: access.organizationId,
    userId: access.user._id,
    label: access.user.name ?? access.user.email ?? "User",
    canManage:
      access.isProvisioned && roleHasPermission(access.role, "compliance.manage"),
  };
}

async function requireManager(ctx: MutationCtx): Promise<TestingAccess> {
  const access = await requirePermission(ctx, "compliance.manage");
  if (!access.organizationId || !access.user) {
    throw new Error("No organization context");
  }
  if (!access.isProvisioned) {
    throw new Error("Caller membership is not active");
  }
  return {
    organizationId: access.organizationId,
    userId: access.user._id,
    label: access.user.name ?? access.user.email ?? "User",
    canManage: true,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function requireText(
  value: string,
  field: string,
  max: number,
  min = 1,
): string {
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (cleaned.length < min) {
    throw new Error(`${field} must be at least ${min} characters`);
  }
  if (cleaned.length > max) {
    throw new Error(`${field} must be at most ${max} characters`);
  }
  return cleaned;
}

function requireNarrative(value: string, field: string, max: number): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${field} is required`);
  if (cleaned.length > max) {
    throw new Error(`${field} must be at most ${max} characters`);
  }
  return cleaned;
}

function optionalText(
  value: string | undefined,
  field: string,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.trim();
  if (!cleaned) return undefined;
  if (cleaned.length > max) {
    throw new Error(`${field} must be at most ${max} characters`);
  }
  return cleaned;
}

function optionalDate(value: number | undefined, field: string) {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) throw new Error(`${field} must be a valid date`);
  return Math.floor(value);
}

/** The control addressed by a test, re-validated against the organization. */
async function requireOwnedControl(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  controlId: Id<"controls">,
): Promise<{ control: Doc<"controls">; framework: Doc<"complianceFrameworks"> }> {
  const control = await ctx.db.get(controlId);
  if (!control || control.organizationId !== organizationId) {
    throw new Error("Control not found in your organization");
  }
  if (!control.frameworkId) {
    throw new Error(
      "Control is not linked to a framework, so it cannot be tested",
    );
  }
  const framework = await ctx.db.get(control.frameworkId);
  if (!framework || framework.organizationId !== organizationId) {
    throw new Error("Framework not found in your organization");
  }
  return { control, framework };
}

async function activeMappingsForTest(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  testId: Id<"complianceControlTests">,
) {
  const rows = await ctx.db
    .query("complianceEvidenceMappings")
    .withIndex("by_organization_test", (q) =>
      q.eq("organizationId", organizationId).eq("testId", testId),
    )
    .take(MAPPING_LIST_LIMIT);
  return rows.filter((m) => m.active);
}

function presentTest(test: Doc<"complianceControlTests">, supersededBy?: string) {
  return {
    _id: test._id,
    reference: test.reference,
    title: test.title,
    objective: test.objective,
    procedure: test.procedure,
    status: test.status,
    statusLabel: CONTROL_TEST_STATUS_LABELS[test.status],
    outcome: test.outcome,
    outcomeLabel: CONTROL_TEST_OUTCOME_LABELS[test.outcome],
    testerUserId: test.testerUserId ?? null,
    testerLabel: test.testerLabel,
    plannedStart: test.plannedStart ?? null,
    plannedEnd: test.plannedEnd ?? null,
    actualStart: test.actualStart ?? null,
    actualEnd: test.actualEnd ?? null,
    periodLabel: test.periodLabel ?? null,
    sampleSize: test.sampleSize ?? null,
    sampleDescription: test.sampleDescription ?? null,
    observations: test.observations ?? null,
    exceptions: test.exceptions ?? null,
    recommendations: test.recommendations ?? null,
    completionNotes: test.completionNotes ?? null,
    evidenceException: test.evidenceException ?? null,
    completedAt: test.completedAt ?? null,
    completedByLabel: test.completedByLabel ?? null,
    supersedesTestId: test.supersedesTestId ?? null,
    amendmentReason: test.amendmentReason ?? null,
    /** Set when a LATER record supersedes this one (derived, never stored). */
    supersededByTestId: supersededBy ?? null,
    superseded: Boolean(supersededBy),
    open: isOpenControlTest(test.status),
    createdByLabel: test.createdByLabel,
    createdAt: test.createdAt,
    updatedAt: test.updatedAt,
    frameworkId: test.frameworkId,
    controlId: test.controlId,
  };
}

function presentEvidence(
  evidence: Doc<"complianceEvidence">,
  includeDownload: boolean,
) {
  return {
    _id: evidence._id,
    filename: evidence.filename,
    fileType: evidence.fileType,
    sizeBytes: evidence.sizeBytes,
    classification: evidence.classification,
    source: evidence.source ?? null,
    description: evidence.description ?? null,
    sha256: evidence.sha256 || null,
    integrity: evidence.integrity,
    integrityCheckedAt: evidence.integrityCheckedAt ?? null,
    uploadedByLabel: evidence.uploadedByLabel,
    createdAt: evidence.createdAt,
    controlId: evidence.controlId,
    testId: evidence.testId ?? null,
    hasBlob: evidence.storageId !== undefined,
    /**
     * A download URL is only ever returned by the audited `evidenceDownloadUrl`
     * mutation for callers allowed to read the record's classification.
     */
    downloadable: includeDownload,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Control tests in the organization, optionally narrowed to one control, one
 * framework, a status, an outcome or a search term. Cursor-paginated over an
 * organization index, so the register stays reachable without a whole-tenant
 * scan.
 */
export const listControlTests = query({
  args: {
    controlId: v.optional(v.id("controls")),
    frameworkId: v.optional(v.id("complianceFrameworks")),
    status: v.optional(controlTestStatusValidator),
    outcome: v.optional(controlTestOutcomeValidator),
    search: v.optional(v.string()),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await resolveAccess(ctx);
    const requested = args.numItems ?? TEST_PAGE_DEFAULT;
    const numItems = Math.min(
      Math.max(
        Number.isFinite(requested) ? Math.floor(requested) : TEST_PAGE_DEFAULT,
        1,
      ),
      TEST_PAGE_MAX,
    );

    // A foreign control/framework id discloses nothing.
    if (args.controlId) {
      const control = await ctx.db.get(args.controlId);
      if (!control || control.organizationId !== access.organizationId) {
        return { rows: [], continueCursor: "", isDone: true, summary: null };
      }
    }
    if (args.frameworkId) {
      const framework = await ctx.db.get(args.frameworkId);
      if (!framework || framework.organizationId !== access.organizationId) {
        return { rows: [], continueCursor: "", isDone: true, summary: null };
      }
    }

    const page = args.controlId
      ? await ctx.db
          .query("complianceControlTests")
          .withIndex("by_organization_control", (q) =>
            q
              .eq("organizationId", access.organizationId)
              .eq("controlId", args.controlId as Id<"controls">),
          )
          .order("desc")
          .paginate({ numItems, cursor: args.cursor ?? null })
      : await ctx.db
          .query("complianceControlTests")
          .withIndex("by_organization", (q) =>
            q.eq("organizationId", access.organizationId),
          )
          .order("desc")
          .paginate({ numItems, cursor: args.cursor ?? null });

    const search = args.search?.trim().toLowerCase();
    const rows = [];
    for (const test of page.page) {
      if (args.status && test.status !== args.status) continue;
      if (args.outcome && test.outcome !== args.outcome) continue;
      if (args.frameworkId && test.frameworkId !== args.frameworkId) continue;
      if (search) {
        const haystack = [
          test.reference,
          test.title,
          test.objective,
          test.procedure,
          test.testerLabel,
          test.observations,
          test.exceptions,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(search)) continue;
      }
      const superseding = await ctx.db
        .query("complianceControlTests")
        .withIndex("by_organization_supersedes", (q) =>
          q
            .eq("organizationId", access.organizationId)
            .eq("supersedesTestId", test._id),
        )
        .first();
      rows.push(presentTest(test, superseding ? String(superseding._id) : undefined));
    }

    // Counting summary across the organization's tests (bounded scan).
    const scanned = await ctx.db
      .query("complianceControlTests")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(TEST_LIST_LIMIT);
    const byStatus: Record<string, number> = {};
    const byOutcome: Record<string, number> = {};
    for (const test of scanned) {
      byStatus[test.status] = (byStatus[test.status] ?? 0) + 1;
      if (test.status === "completed") {
        byOutcome[test.outcome] = (byOutcome[test.outcome] ?? 0) + 1;
      }
    }

    return {
      rows,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      summary: { total: scanned.length, byStatus, byOutcome },
    };
  },
});

/** One test with its evidence, integrity state and amendment chain. */
export const getControlTest = query({
  args: { testId: v.id("complianceControlTests") },
  handler: async (ctx, args) => {
    const access = await resolveAccess(ctx);
    const test = await ctx.db.get(args.testId);
    if (!test || test.organizationId !== access.organizationId) return null;

    const control = await ctx.db.get(test.controlId);
    if (!control || control.organizationId !== access.organizationId) return null;
    const framework = await ctx.db.get(test.frameworkId);
    if (!framework || framework.organizationId !== access.organizationId) return null;

    const mappings = await ctx.db
      .query("complianceEvidenceMappings")
      .withIndex("by_organization_test", (q) =>
        q.eq("organizationId", access.organizationId).eq("testId", test._id),
      )
      .take(MAPPING_LIST_LIMIT);

    const evidence = [];
    for (const mapping of mappings) {
      const record = await ctx.db.get(mapping.evidenceId);
      if (!record || record.organizationId !== access.organizationId) continue;
      evidence.push({
        mappingId: mapping._id,
        active: mapping.active,
        linkedAt: mapping.linkedAt,
        linkedByLabel: mapping.linkedByLabel,
        unlinkedAt: mapping.unlinkedAt ?? null,
        unlinkedByLabel: mapping.unlinkedByLabel ?? null,
        unlinkReason: mapping.unlinkReason ?? null,
        ...presentEvidence(
          record,
          // Restricted evidence is flagged as not downloadable for callers
          // without compliance.manage; the audited mutation enforces it too.
          record.classification !== "restricted" || access.canManage,
        ),
      });
    }

    const superseding = await ctx.db
      .query("complianceControlTests")
      .withIndex("by_organization_supersedes", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("supersedesTestId", test._id),
      )
      .first();

    let supersededTest = null;
    if (test.supersedesTestId) {
      const earlier = await ctx.db.get(test.supersedesTestId);
      if (earlier && earlier.organizationId === access.organizationId) {
        supersededTest = presentTest(earlier);
      }
    }

    return {
      ...presentTest(test, superseding ? String(superseding._id) : undefined),
      control: {
        _id: control._id,
        code: control.code,
        title: control.name,
        implementationStatus: control.implementationStatus ?? "not_implemented",
        effectiveness: control.effectiveness,
      },
      framework: { _id: framework._id, code: framework.code, name: framework.name },
      evidence,
      activeEvidenceCount: evidence.filter((e) => e.active).length,
      supersededTest,
      canManage: access.canManage,
    };
  },
});

/**
 * Testing and evidence reporting for one control, or for the whole
 * organization. Every figure is a COUNT OF REAL RECORDS — latest completed
 * test outcome per control and evidence gaps. No compliance percentage is
 * produced (its denominator and assessment rules are not defined by this
 * batch).
 */
export const testingSummary = query({
  args: { frameworkId: v.optional(v.id("complianceFrameworks")) },
  handler: async (ctx, args) => {
    const access = await resolveAccess(ctx);

    if (args.frameworkId) {
      const framework = await ctx.db.get(args.frameworkId);
      if (!framework || framework.organizationId !== access.organizationId) {
        return {
          controls: 0,
          notTested: 0,
          effective: 0,
          partiallyEffective: 0,
          ineffective: 0,
          plannedTests: 0,
          inProgressTests: 0,
          completedTests: 0,
          evidenceGaps: 0,
          evidenceRecords: 0,
          unverifiedEvidence: 0,
        };
      }
    }

    const controls = await ctx.db
      .query("controls")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(CONTROL_SCAN_LIMIT);
    const scopedControls = args.frameworkId
      ? controls.filter((c) => c.frameworkId === args.frameworkId)
      : controls;
    const controlIds = new Set(scopedControls.map((c) => String(c._id)));

    const tests = await ctx.db
      .query("complianceControlTests")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(TEST_LIST_LIMIT);
    const scopedTests = tests.filter((t) => controlIds.has(String(t.controlId)));

    const evidenceRows = await ctx.db
      .query("complianceEvidence")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(EVIDENCE_SCAN_LIMIT);
    const scopedEvidence = evidenceRows.filter((e) =>
      controlIds.has(String(e.controlId)),
    );

    const mappingRows = await ctx.db
      .query("complianceEvidenceMappings")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(EVIDENCE_SCAN_LIMIT);
    const activeMappings = mappingRows.filter(
      (m) => m.active && controlIds.has(String(m.controlId)),
    );
    const mappedEvidenceIds = new Set(activeMappings.map((m) => String(m.evidenceId)));

    // Latest COMPLETED test outcome per control (newest first wins).
    const ordered = [...scopedTests].sort((a, b) => b.createdAt - a.createdAt);
    const latestOutcome = new Map<string, ControlTestOutcome>();
    for (const test of ordered) {
      const key = String(test.controlId);
      if (test.status === "completed" && !latestOutcome.has(key)) {
        latestOutcome.set(key, test.outcome);
      }
    }

    let effective = 0;
    let partiallyEffective = 0;
    let ineffective = 0;
    let notTested = 0;
    let evidenceGaps = 0;
    for (const control of scopedControls) {
      const outcome = latestOutcome.get(String(control._id));
      if (outcome === "effective") effective += 1;
      else if (outcome === "partially_effective") partiallyEffective += 1;
      else if (outcome === "ineffective") ineffective += 1;
      else notTested += 1;
      // A control with no ACTIVE evidence mapping recorded against it cannot
      // support its result — reported as a gap, whatever its test state.
      const hasEvidence = scopedEvidence.some(
        (e) =>
          String(e.controlId) === String(control._id) &&
          (mappedEvidenceIds.has(String(e._id)) || e.testId === undefined),
      );
      if (!hasEvidence) evidenceGaps += 1;
    }

    return {
      controls: scopedControls.length,
      notTested,
      effective,
      partiallyEffective,
      ineffective,
      plannedTests: scopedTests.filter((t) => t.status === "planned").length,
      inProgressTests: scopedTests.filter((t) => t.status === "in_progress").length,
      completedTests: scopedTests.filter((t) => t.status === "completed").length,
      evidenceGaps,
      evidenceRecords: scopedEvidence.length,
      unverifiedEvidence: scopedEvidence.filter(
        (e) => e.integrity === "pending" || e.integrity === "hash_mismatch",
      ).length,
    };
  },
});

// ---------------------------------------------------------------------------
// Control test writes
// ---------------------------------------------------------------------------

async function nextTestReference(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
): Promise<string> {
  const existing = await ctx.db
    .query("complianceControlTests")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(1000);
  let highest = 0;
  for (const test of existing) {
    const match = /^CT-(\d+)$/.exec(test.reference);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `CT-${String(highest + 1).padStart(3, "0")}`;
}

/** Tester must be an ACTIVE member of the same organization when supplied. */
async function resolveTester(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  testerUserId: Id<"users"> | undefined,
  fallbackLabel: string,
): Promise<string> {
  if (testerUserId === undefined) return fallbackLabel;
  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("userId", (q) => q.eq("userId", testerUserId))
    .unique();
  if (
    !profile ||
    profile.organizationId !== organizationId ||
    effectiveMembershipStatus(profile.membershipStatus) !== "active"
  ) {
    throw new Error("Tester is not an active member of your organization");
  }
  const user = await ctx.db.get(testerUserId);
  return user?.name ?? user?.email ?? fallbackLabel;
}

export const createControlTest = mutation({
  args: {
    controlId: v.id("controls"),
    title: v.string(),
    objective: v.string(),
    procedure: v.string(),
    testerUserId: v.optional(v.id("users")),
    plannedStart: v.optional(v.number()),
    plannedEnd: v.optional(v.number()),
    periodLabel: v.optional(v.string()),
    sampleSize: v.optional(v.number()),
    sampleDescription: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const { control, framework } = await requireOwnedControl(
      ctx,
      manager.organizationId,
      args.controlId,
    );

    const title = requireText(args.title, "Test title", CONTROL_TEST_TITLE_MAX);
    const objective = requireNarrative(
      args.objective,
      "Test objective",
      CONTROL_TEST_TEXT_MAX,
    );
    const procedure = requireNarrative(
      args.procedure,
      "Test procedure",
      CONTROL_TEST_TEXT_MAX,
    );
    const periodLabel = optionalText(
      args.periodLabel,
      "Test period",
      CONTROL_TEST_PERIOD_MAX,
    );
    const sampleDescription = optionalText(
      args.sampleDescription,
      "Sample description",
      CONTROL_TEST_SAMPLE_MAX,
    );
    const plannedStart = optionalDate(args.plannedStart, "Planned start");
    const plannedEnd = optionalDate(args.plannedEnd, "Planned end");
    if (
      plannedStart !== undefined &&
      plannedEnd !== undefined &&
      plannedEnd < plannedStart
    ) {
      throw new Error("Planned end cannot precede the planned start");
    }
    if (args.sampleSize !== undefined) {
      if (!Number.isInteger(args.sampleSize) || args.sampleSize < 0) {
        throw new Error("Sample size must be a whole number of zero or more");
      }
    }
    const testerLabel = await resolveTester(
      ctx,
      manager.organizationId,
      args.testerUserId,
      manager.label,
    );

    const reference = await nextTestReference(ctx, manager.organizationId);
    const now = Date.now();
    const testId = await ctx.db.insert("complianceControlTests", {
      organizationId: manager.organizationId,
      frameworkId: framework._id,
      controlId: control._id,
      reference,
      title,
      objective,
      procedure,
      testerUserId: args.testerUserId,
      testerLabel,
      plannedStart,
      plannedEnd,
      periodLabel,
      sampleSize: args.sampleSize,
      sampleDescription,
      status: "planned",
      // A test carries no verdict before it is completed.
      outcome: "not_tested",
      createdByUserId: manager.userId,
      createdByLabel: manager.label,
      createdAt: now,
      updatedAt: now,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.control_test_created",
      entityType: "complianceControlTests",
      entityId: String(testId),
      relatedEntityType: "controls",
      relatedEntityId: String(control._id),
      summary: `Control test ${reference} planned for ${control.code} (${control.name}) in framework ${framework.code}`,
    });
    return { testId, reference, status: "planned" as ControlTestStatus };
  },
});

/**
 * Update an OPEN test's plan. A COMPLETED test is immutable: its fields are
 * never patched — corrections must go through `supersedeControlTest`.
 */
export const updateControlTest = mutation({
  args: {
    testId: v.id("complianceControlTests"),
    title: v.optional(v.string()),
    objective: v.optional(v.string()),
    procedure: v.optional(v.string()),
    testerUserId: v.optional(v.id("users")),
    plannedStart: v.optional(v.number()),
    plannedEnd: v.optional(v.number()),
    periodLabel: v.optional(v.string()),
    sampleSize: v.optional(v.number()),
    sampleDescription: v.optional(v.string()),
    observations: v.optional(v.string()),
    exceptions: v.optional(v.string()),
    recommendations: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const test = await ctx.db.get(args.testId);
    if (!test || test.organizationId !== manager.organizationId) {
      throw new Error("Control test not found in your organization");
    }
    if (test.status === "completed") {
      throw new Error(
        "A completed control test cannot be edited — record a superseding test instead",
      );
    }
    await requireOwnedControl(ctx, manager.organizationId, test.controlId);

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.title !== undefined) {
      patch.title = requireText(args.title, "Test title", CONTROL_TEST_TITLE_MAX);
    }
    if (args.objective !== undefined) {
      patch.objective = requireNarrative(
        args.objective,
        "Test objective",
        CONTROL_TEST_TEXT_MAX,
      );
    }
    if (args.procedure !== undefined) {
      patch.procedure = requireNarrative(
        args.procedure,
        "Test procedure",
        CONTROL_TEST_TEXT_MAX,
      );
    }
    if (args.testerUserId !== undefined) {
      patch.testerUserId = args.testerUserId;
      patch.testerLabel = await resolveTester(
        ctx,
        manager.organizationId,
        args.testerUserId,
        manager.label,
      );
    }
    if (args.plannedStart !== undefined) {
      patch.plannedStart = optionalDate(args.plannedStart, "Planned start");
    }
    if (args.plannedEnd !== undefined) {
      patch.plannedEnd = optionalDate(args.plannedEnd, "Planned end");
    }
    if (args.periodLabel !== undefined) {
      patch.periodLabel = optionalText(
        args.periodLabel,
        "Test period",
        CONTROL_TEST_PERIOD_MAX,
      );
    }
    if (args.sampleSize !== undefined) {
      if (!Number.isInteger(args.sampleSize) || args.sampleSize < 0) {
        throw new Error("Sample size must be a whole number of zero or more");
      }
      patch.sampleSize = args.sampleSize;
    }
    if (args.sampleDescription !== undefined) {
      patch.sampleDescription = optionalText(
        args.sampleDescription,
        "Sample description",
        CONTROL_TEST_SAMPLE_MAX,
      );
    }
    if (args.observations !== undefined) {
      patch.observations = optionalText(
        args.observations,
        "Observations",
        CONTROL_TEST_TEXT_MAX,
      );
    }
    if (args.exceptions !== undefined) {
      patch.exceptions = optionalText(
        args.exceptions,
        "Exceptions",
        CONTROL_TEST_TEXT_MAX,
      );
    }
    if (args.recommendations !== undefined) {
      patch.recommendations = optionalText(
        args.recommendations,
        "Recommendations",
        CONTROL_TEST_TEXT_MAX,
      );
    }

    await ctx.db.patch(test._id, patch);
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.control_test_updated",
      entityType: "complianceControlTests",
      entityId: String(test._id),
      relatedEntityType: "controls",
      relatedEntityId: String(test.controlId),
      summary: `Control test ${test.reference} plan updated (${Object.keys(patch)
        .filter((k) => k !== "updatedAt")
        .join(", ")})`,
    });
    return { ok: true as const };
  },
});

/** planned → in_progress. Transitions are validated server-side. */
export const startControlTest = mutation({
  args: { testId: v.id("complianceControlTests"), actualStart: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const test = await ctx.db.get(args.testId);
    if (!test || test.organizationId !== manager.organizationId) {
      throw new Error("Control test not found in your organization");
    }
    if (!canTransitionControlTest(test.status, "in_progress")) {
      throw new Error(
        `A ${CONTROL_TEST_STATUS_LABELS[test.status].toLowerCase()} control test cannot start`,
      );
    }
    await ctx.db.patch(test._id, {
      status: "in_progress",
      actualStart: optionalDate(args.actualStart, "Actual start") ?? Date.now(),
      updatedAt: Date.now(),
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.control_test_started",
      entityType: "complianceControlTests",
      entityId: String(test._id),
      relatedEntityType: "controls",
      relatedEntityId: String(test.controlId),
      summary: `Control test ${test.reference} moved to in progress`,
    });
    return { ok: true as const, status: "in_progress" as ControlTestStatus };
  },
});

/**
 * Complete a test with a verdict. Requires adequate completion details and
 * either an ACTIVE mapped evidence record or an explicitly documented
 * `evidenceException` — a result is never fabricated from an empty file set.
 * A control whose test is `partially_effective` / `ineffective` must record the
 * observations or exceptions that justify it.
 */
export const completeControlTest = mutation({
  args: {
    testId: v.id("complianceControlTests"),
    outcome: controlTestOutcomeValidator,
    actualEnd: v.optional(v.number()),
    observations: v.optional(v.string()),
    exceptions: v.optional(v.string()),
    recommendations: v.optional(v.string()),
    completionNotes: v.string(),
    evidenceException: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const test = await ctx.db.get(args.testId);
    if (!test || test.organizationId !== manager.organizationId) {
      throw new Error("Control test not found in your organization");
    }
    if (!canTransitionControlTest(test.status, "completed")) {
      throw new Error(
        `A ${CONTROL_TEST_STATUS_LABELS[test.status].toLowerCase()} control test cannot be completed again`,
      );
    }
    if (!isControlTestVerdict(args.outcome)) {
      throw new Error(
        "Completing a control test requires an outcome of effective, partially effective or ineffective",
      );
    }

    const completionNotes = args.completionNotes.trim();
    if (completionNotes.length < CONTROL_TEST_COMPLETION_MIN) {
      throw new Error(
        `Completion notes must be at least ${CONTROL_TEST_COMPLETION_MIN} characters describing what was done`,
      );
    }
    if (completionNotes.length > CONTROL_TEST_TEXT_MAX) {
      throw new Error(
        `Completion notes must be at most ${CONTROL_TEST_TEXT_MAX} characters`,
      );
    }

    const observations = optionalText(
      args.observations,
      "Observations",
      CONTROL_TEST_TEXT_MAX,
    );
    const exceptions = optionalText(
      args.exceptions,
      "Exceptions",
      CONTROL_TEST_TEXT_MAX,
    );
    const recommendations = optionalText(
      args.recommendations,
      "Recommendations",
      CONTROL_TEST_TEXT_MAX,
    );
    if (
      (args.outcome === "partially_effective" || args.outcome === "ineffective") &&
      !observations &&
      !exceptions
    ) {
      throw new Error(
        "A partially effective or ineffective outcome requires the observations or exceptions that justify it",
      );
    }

    // Supporting evidence, or an explicitly documented exception.
    const mappings = await activeMappingsForTest(
      ctx,
      manager.organizationId,
      test._id,
    );
    const evidenceException = optionalText(
      args.evidenceException,
      "Missing-evidence exception",
      CONTROL_TEST_TEXT_MAX,
    );
    if (mappings.length === 0) {
      if (!evidenceException || evidenceException.length < CONTROL_TEST_EXCEPTION_MIN) {
        throw new Error(
          `Completing a control test without mapped evidence requires a documented exception of at least ${CONTROL_TEST_EXCEPTION_MIN} characters explaining why no evidence could be obtained`,
        );
      }
    }

    const now = Date.now();
    await ctx.db.patch(test._id, {
      status: "completed",
      outcome: args.outcome,
      observations,
      exceptions,
      recommendations,
      completionNotes,
      evidenceException: mappings.length === 0 ? evidenceException : undefined,
      actualEnd: optionalDate(args.actualEnd, "Actual end") ?? now,
      completedAt: now,
      completedByUserId: manager.userId,
      completedByLabel: manager.label,
      updatedAt: now,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.control_test_completed",
      entityType: "complianceControlTests",
      entityId: String(test._id),
      relatedEntityType: "controls",
      relatedEntityId: String(test.controlId),
      summary: `Control test ${test.reference} completed with outcome ${CONTROL_TEST_OUTCOME_LABELS[args.outcome]}${
        mappings.length === 0
          ? " (documented missing-evidence exception)"
          : ` with ${mappings.length} mapped evidence record(s)`
      }`,
    });
    return {
      ok: true as const,
      status: "completed" as ControlTestStatus,
      outcome: args.outcome,
      evidenceMapped: mappings.length,
    };
  },
});

/**
 * Record a correction as a NEW test that supersedes a previous one. The
 * superseded record is never modified: its result stays readable, and the
 * amendment chain plus audit trail show what replaced it.
 */
export const supersedeControlTest = mutation({
  args: {
    testId: v.id("complianceControlTests"),
    title: v.string(),
    objective: v.string(),
    procedure: v.string(),
    testerUserId: v.optional(v.id("users")),
    plannedStart: v.optional(v.number()),
    plannedEnd: v.optional(v.number()),
    periodLabel: v.optional(v.string()),
    sampleSize: v.optional(v.number()),
    sampleDescription: v.optional(v.string()),
    amendmentReason: v.string(),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const original = await ctx.db.get(args.testId);
    if (!original || original.organizationId !== manager.organizationId) {
      throw new Error("Control test not found in your organization");
    }
    if (original.status !== "completed") {
      throw new Error(
        "Only a completed control test can be superseded — edit the open test instead",
      );
    }
    // The original must not already be superseded (no double amendments).
    const alreadySuperseded = await ctx.db
      .query("complianceControlTests")
      .withIndex("by_organization_supersedes", (q) =>
        q
          .eq("organizationId", manager.organizationId)
          .eq("supersedesTestId", original._id),
      )
      .first();
    if (alreadySuperseded) {
      throw new Error(
        `Control test ${original.reference} is already superseded by ${alreadySuperseded.reference}`,
      );
    }
    const { control, framework } = await requireOwnedControl(
      ctx,
      manager.organizationId,
      original.controlId,
    );

    const title = requireText(args.title, "Test title", CONTROL_TEST_TITLE_MAX);
    const objective = requireNarrative(
      args.objective,
      "Test objective",
      CONTROL_TEST_TEXT_MAX,
    );
    const procedure = requireNarrative(
      args.procedure,
      "Test procedure",
      CONTROL_TEST_TEXT_MAX,
    );
    const amendmentReason = requireNarrative(
      args.amendmentReason,
      "Amendment reason",
      CONTROL_TEST_TEXT_MAX,
    );
    const testerLabel = await resolveTester(
      ctx,
      manager.organizationId,
      args.testerUserId,
      manager.label,
    );
    const reference = await nextTestReference(ctx, manager.organizationId);
    const now = Date.now();
    const testId = await ctx.db.insert("complianceControlTests", {
      organizationId: manager.organizationId,
      frameworkId: framework._id,
      controlId: control._id,
      reference,
      title,
      objective,
      procedure,
      testerUserId: args.testerUserId,
      testerLabel,
      plannedStart: optionalDate(args.plannedStart, "Planned start"),
      plannedEnd: optionalDate(args.plannedEnd, "Planned end"),
      periodLabel: optionalText(args.periodLabel, "Test period", CONTROL_TEST_PERIOD_MAX),
      sampleSize: args.sampleSize,
      sampleDescription: optionalText(
        args.sampleDescription,
        "Sample description",
        CONTROL_TEST_SAMPLE_MAX,
      ),
      status: "planned",
      outcome: "not_tested",
      supersedesTestId: original._id,
      amendmentReason,
      createdByUserId: manager.userId,
      createdByLabel: manager.label,
      createdAt: now,
      updatedAt: now,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.control_test_superseded",
      entityType: "complianceControlTests",
      entityId: String(testId),
      relatedEntityType: "complianceControlTests",
      relatedEntityId: String(original._id),
      summary: `Control test ${reference} supersedes ${original.reference} for ${control.code}: ${amendmentReason}. The earlier result (${CONTROL_TEST_OUTCOME_LABELS[original.outcome]}) is preserved`,
    });
    return { testId, reference, supersedesTestId: original._id };
  },
});

// ---------------------------------------------------------------------------
// Evidence: upload, integrity, mapping
// ---------------------------------------------------------------------------

/** One-time upload URL for compliance evidence (compliance.manage only). */
export const generateEvidenceUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireManager(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Finalize an evidence upload: validates the declaration and the control/test
 * ownership, creates the record and schedules server-side SHA-256 hashing.
 * `sizeBytes` and `fileType` are re-validated here — the browser's pre-PUT
 * checks are convenience, not authorization.
 */
export const confirmEvidenceUpload = mutation({
  args: {
    storageId: v.id("_storage"),
    controlId: v.id("controls"),
    testId: v.optional(v.id("complianceControlTests")),
    filename: v.string(),
    fileType: v.string(),
    sizeBytes: v.number(),
    classification: complianceEvidenceClassificationValidator,
    description: v.optional(v.string()),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const { control } = await requireOwnedControl(
      ctx,
      manager.organizationId,
      args.controlId,
    );

    const filename = requireText(
      args.filename,
      "File name",
      COMPLIANCE_EVIDENCE_FILENAME_MAX,
    );
    if (!(COMPLIANCE_EVIDENCE_TYPES as readonly string[]).includes(args.fileType)) {
      throw new Error(`Unsupported file type: ${args.fileType}`);
    }
    if (
      !Number.isFinite(args.sizeBytes) ||
      args.sizeBytes <= 0 ||
      args.sizeBytes > COMPLIANCE_EVIDENCE_MAX_BYTES
    ) {
      throw new Error("File size must be between 1 byte and 10 MB");
    }

    // A linked test must belong to the same organization AND the same control.
    let test: Doc<"complianceControlTests"> | null = null;
    if (args.testId) {
      const candidate = await ctx.db.get(args.testId);
      if (
        !candidate ||
        candidate.organizationId !== manager.organizationId ||
        candidate.controlId !== control._id
      ) {
        throw new Error("Control test not found for this control in your organization");
      }
      test = candidate;
    }

    const now = Date.now();
    const evidenceId = await ctx.db.insert("complianceEvidence", {
      organizationId: manager.organizationId,
      controlId: control._id,
      testId: test?._id,
      filename,
      fileType: args.fileType,
      sizeBytes: Math.floor(args.sizeBytes),
      classification: args.classification,
      source: optionalText(args.source, "Source", COMPLIANCE_SOURCE_REFERENCE_MAX),
      description: optionalText(
        args.description,
        "Description",
        COMPLIANCE_EVIDENCE_DESCRIPTION_MAX,
      ),
      // Stamped by the scheduled hashing action.
      sha256: "",
      integrity: "pending",
      storageId: args.storageId,
      uploadedById: manager.userId,
      uploadedByLabel: manager.label,
      createdAt: now,
      updatedAt: now,
    });

    // The upload itself IS the first mapping when a test is supplied, so a
    // completed test can immediately rely on it.
    let mappingId: Id<"complianceEvidenceMappings"> | null = null;
    if (test) {
      mappingId = await ctx.db.insert("complianceEvidenceMappings", {
        organizationId: manager.organizationId,
        evidenceId,
        controlId: control._id,
        testId: test._id,
        linkedByUserId: manager.userId,
        linkedByLabel: manager.label,
        linkedAt: now,
        active: true,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Mutations cannot read blob bytes, so hashing runs as a scheduled action.
    await ctx.scheduler.runAfter(
      0,
      internal.complianceTesting.computeEvidenceHash,
      { evidenceId, storageId: args.storageId },
    );

    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.evidence_uploaded",
      entityType: "complianceEvidence",
      entityId: String(evidenceId),
      relatedEntityType: "controls",
      relatedEntityId: String(control._id),
      summary: `Evidence ${filename} (${args.classification}) recorded for control ${control.code}${
        test ? ` and mapped to control test ${test.reference}` : ""
      }; server-side integrity hash scheduled`,
    });
    return { evidenceId, mappingId, integrity: "pending" as const };
  },
});

/** INTERNAL — compute the SHA-256 of a stored blob and stamp the record. */
export const computeEvidenceHash = internalAction({
  args: {
    evidenceId: v.id("complianceEvidence"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const url = await ctx.storage.getUrl(args.storageId);
    if (!url) {
      await ctx.runMutation(
        internal.complianceTesting.recordEvidenceIntegrity,
        { evidenceId: args.evidenceId, sha256: "", integrity: "blob_missing" },
      );
      return { integrity: "blob_missing" as const };
    }
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const sha256 = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    await ctx.runMutation(
      internal.complianceTesting.recordEvidenceIntegrity,
      { evidenceId: args.evidenceId, sha256, integrity: "intact" },
    );
    return { integrity: "intact" as const, sha256 };
  },
});

/** INTERNAL — persist an integrity verdict (hashing or re-verification). */
export const recordEvidenceIntegrity = internalMutation({
  args: {
    evidenceId: v.id("complianceEvidence"),
    sha256: v.string(),
    integrity: v.union(
      v.literal("pending"),
      v.literal("intact"),
      v.literal("hash_mismatch"),
      v.literal("blob_missing"),
    ),
  },
  handler: async (ctx, args) => {
    const evidence = await ctx.db.get(args.evidenceId);
    if (!evidence) return { ok: false as const };
    await ctx.db.patch(evidence._id, {
      sha256: args.sha256,
      integrity: args.integrity,
      integrityCheckedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { ok: true as const };
  },
});

/**
 * Re-verify a stored evidence blob against its recorded hash and persist the
 * verdict. Permission-gated and audited; no bytes are returned.
 */
export const verifyEvidenceIntegrity = mutation({
  args: { evidenceId: v.id("complianceEvidence") },
  handler: async (ctx, args) => {
    const access = await resolveAccess(ctx);
    const evidence = await ctx.db.get(args.evidenceId);
    if (!evidence || evidence.organizationId !== access.organizationId) {
      throw new Error("Evidence not found in your organization");
    }
    if (!mayReadRestrictedEvidence(access.canManage) &&
        evidence.classification === "restricted") {
      throw new Error(
        "Restricted evidence integrity can only be checked by a compliance manager",
      );
    }
    if (!evidence.storageId) {
      await ctx.db.patch(evidence._id, {
        integrity: "blob_missing",
        integrityCheckedAt: Date.now(),
        updatedAt: Date.now(),
      });
      return { verdict: "blob_missing" as const };
    }
    await ctx.scheduler.runAfter(
      0,
      internal.complianceTesting.reverifyEvidence,
      {
        evidenceId: evidence._id,
        storageId: evidence.storageId,
        expectedSha256: evidence.sha256,
      },
    );
    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.userId,
      actorId: access.userId,
      actorLabel: access.label,
      action: "compliance.evidence_integrity_checked",
      entityType: "complianceEvidence",
      entityId: String(evidence._id),
      summary: `Integrity re-check requested for ${evidence.filename}`,
    });
    return { verdict: "queued" as const };
  },
});

/** INTERNAL — recompute a hash and record intact / mismatch / missing. */
export const reverifyEvidence = internalAction({
  args: {
    evidenceId: v.id("complianceEvidence"),
    storageId: v.id("_storage"),
    expectedSha256: v.string(),
  },
  handler: async (ctx, args) => {
    const url = await ctx.storage.getUrl(args.storageId);
    if (!url) {
      await ctx.runMutation(internal.complianceTesting.recordEvidenceIntegrity, {
        evidenceId: args.evidenceId,
        sha256: args.expectedSha256,
        integrity: "blob_missing",
      });
      return { verdict: "blob_missing" as const };
    }
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const sha256 = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const integrity = sha256 === args.expectedSha256 ? "intact" : "hash_mismatch";
    await ctx.runMutation(internal.complianceTesting.recordEvidenceIntegrity, {
      evidenceId: args.evidenceId,
      sha256,
      integrity,
    });
    return { verdict: integrity };
  },
});

/**
 * Audited evidence download. The URL is only returned to a caller allowed to
 * read the record's classification, and every issuance is logged — no URL or
 * token is ever exposed to an unauthorized user (viewers of restricted
 * evidence receive a refusal, not a link).
 */
export const evidenceDownloadUrl = mutation({
  args: { evidenceId: v.id("complianceEvidence") },
  handler: async (ctx, args) => {
    const access = await resolveAccess(ctx);
    const evidence = await ctx.db.get(args.evidenceId);
    if (!evidence || evidence.organizationId !== access.organizationId) {
      throw new Error("Evidence not found in your organization");
    }
    if (evidence.classification === "restricted" && !access.canManage) {
      throw new Error("Restricted evidence requires compliance.manage access");
    }
    if (!evidence.storageId) {
      throw new Error("The stored file for this evidence record is missing");
    }
    const url = await ctx.storage.getUrl(evidence.storageId);
    if (!url) throw new Error("The stored file for this evidence record is missing");

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.userId,
      actorId: access.userId,
      actorLabel: access.label,
      action: "compliance.evidence_downloaded",
      entityType: "complianceEvidence",
      entityId: String(evidence._id),
      summary: `Evidence ${evidence.filename} (${evidence.classification}) retrieved`,
    });
    return { url, sha256: evidence.sha256 || null, filename: evidence.filename };
  },
});

/** Evidence records for one control (or one test), with mapping state. */
export const listEvidence = query({
  args: {
    controlId: v.optional(v.id("controls")),
    testId: v.optional(v.id("complianceControlTests")),
  },
  handler: async (ctx, args) => {
    const access = await resolveAccess(ctx);
    if (!args.controlId && !args.testId) {
      throw new Error("Specify a control or a test to list evidence for");
    }
    if (args.controlId) {
      const control = await ctx.db.get(args.controlId);
      if (!control || control.organizationId !== access.organizationId) {
        return { rows: [], activeCount: 0 };
      }
    }
    const rows = args.testId
      ? await ctx.db
          .query("complianceEvidence")
          .withIndex("by_organization_test", (q) =>
            q
              .eq("organizationId", access.organizationId)
              .eq("testId", args.testId as Id<"complianceControlTests">),
          )
          .take(EVIDENCE_LIST_LIMIT)
      : await ctx.db
          .query("complianceEvidence")
          .withIndex("by_organization_control", (q) =>
            q
              .eq("organizationId", access.organizationId)
              .eq("controlId", args.controlId as Id<"controls">),
          )
          .take(EVIDENCE_LIST_LIMIT);

    const mappings = await ctx.db
      .query("complianceEvidenceMappings")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(EVIDENCE_SCAN_LIMIT);
    const activeByEvidence = new Map<string, boolean>();
    for (const mapping of mappings) {
      const key = String(mapping.evidenceId);
      activeByEvidence.set(key, (activeByEvidence.get(key) ?? false) || mapping.active);
    }

    const presented = rows.map((record) => ({
      ...presentEvidence(
        record,
        record.classification !== "restricted" || access.canManage,
      ),
      activeMapping: activeByEvidence.get(String(record._id)) ?? false,
    }));
    return {
      rows: presented.sort((a, b) => b.createdAt - a.createdAt),
      activeCount: presented.filter((r) => r.activeMapping).length,
    };
  },
});

/** Link an existing evidence record to a control test (same organization). */
export const linkEvidenceToTest = mutation({
  args: {
    evidenceId: v.id("complianceEvidence"),
    testId: v.id("complianceControlTests"),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const evidence = await ctx.db.get(args.evidenceId);
    if (!evidence || evidence.organizationId !== manager.organizationId) {
      throw new Error("Evidence not found in your organization");
    }
    const test = await ctx.db.get(args.testId);
    if (!test || test.organizationId !== manager.organizationId) {
      throw new Error("Control test not found in your organization");
    }
    if (test.controlId !== evidence.controlId) {
      throw new Error(
        "Evidence can only be mapped to a test of the control it was recorded against",
      );
    }

    const existing = await ctx.db
      .query("complianceEvidenceMappings")
      .withIndex("by_organization_evidence", (q) =>
        q
          .eq("organizationId", manager.organizationId)
          .eq("evidenceId", evidence._id),
      )
      .take(MAPPING_LIST_LIMIT);
    if (existing.some((m) => m.active && m.testId === test._id)) {
      throw new Error("This evidence is already mapped to that control test");
    }

    const now = Date.now();
    const mappingId = await ctx.db.insert("complianceEvidenceMappings", {
      organizationId: manager.organizationId,
      evidenceId: evidence._id,
      controlId: evidence.controlId,
      testId: test._id,
      linkedByUserId: manager.userId,
      linkedByLabel: manager.label,
      linkedAt: now,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.evidence_mapped",
      entityType: "complianceEvidence",
      entityId: String(evidence._id),
      relatedEntityType: "complianceControlTests",
      relatedEntityId: String(test._id),
      summary: `Evidence ${evidence.filename} mapped to control test ${test.reference}`,
    });
    return { mappingId };
  },
});

/**
 * Unlink a mapping. The mapping row is retained with its unlink metadata and
 * audit entry: the evidence record, its hash and the surrounding history are
 * never deleted.
 */
export const unlinkEvidenceMapping = mutation({
  args: {
    mappingId: v.id("complianceEvidenceMappings"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const mapping = await ctx.db.get(args.mappingId);
    if (!mapping || mapping.organizationId !== manager.organizationId) {
      throw new Error("Evidence mapping not found in your organization");
    }
    if (!mapping.active) {
      throw new Error("This evidence mapping has already been removed");
    }
    const reason = requireNarrative(
      args.reason,
      "Unlink reason",
      COMPLIANCE_EVIDENCE_UNLINK_REASON_MAX,
    );

    const now = Date.now();
    await ctx.db.patch(mapping._id, {
      active: false,
      unlinkedAt: now,
      unlinkedByUserId: manager.userId,
      unlinkedByLabel: manager.label,
      unlinkReason: reason,
      updatedAt: now,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.evidence_unmapped",
      entityType: "complianceEvidenceMappings",
      entityId: String(mapping._id),
      relatedEntityType: "complianceEvidence",
      relatedEntityId: String(mapping.evidenceId),
      summary: `Evidence mapping removed: ${reason} (evidence record and its audit history are retained)`,
    });
    return { ok: true as const };
  },
});
