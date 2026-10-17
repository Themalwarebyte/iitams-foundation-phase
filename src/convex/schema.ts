import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";
import { PROVISIONABLE_INITIAL_ROLES } from "../lib/membership";
import {
  accessReviewCycleStatusValidator,
  accessReviewDecisionValidator,
  accessReviewRecommendationValidator,
  accessReviewRemediationStatusValidator,
} from "../lib/accessReview";
import {
  riskCategoryValidator,
  riskStatusValidator,
} from "../lib/risk";

// ============================================================================
// IDENTITY & ACCESS — roles (RBAC)
// ============================================================================
// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
  // Phase 2 audit-workflow roles (see src/convex/access.ts). Optional on the
  // profile; existing rows keep their Phase-1 values and stay valid.
  v.literal("audit_director"),
  v.literal("audit_manager"),
  v.literal("auditor"),
  v.literal("audit_reviewer"),
  v.literal("management_user"),
  v.literal("executive_viewer"),
);
export type Role = Infer<typeof roleValidator>;

// ============================================================================
// SHARED DOMAIN ENUMERATIONS (validators reused across tables)
// ============================================================================

export const SEVERITIES = ["critical", "high", "medium", "low", "informational"] as const;
export const severityValidator = v.union(
  ...SEVERITIES.map((s) => v.literal(s)),
);
export type Severity = Infer<typeof severityValidator>;

export const CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"] as const;
export const classificationValidator = v.union(
  ...CLASSIFICATIONS.map((c) => v.literal(c)),
);
export type DataClassification = Infer<typeof classificationValidator>;

/**
 * Phase-1 engagement statuses are retained for backward compatibility with
 * seeded/demo data. Phase 2 adds the formal seven-stage lifecycle
 * (draft → planning → approved → fieldwork → review → report_issued → closed).
 * Transitions are governed by src/lib/auditWorkflow.ts.
 */
export const auditEngagementStatusValidator = v.union(
  v.literal("planned"),
  v.literal("in_progress"),
  v.literal("fieldwork"),
  v.literal("reporting"),
  v.literal("completed"),
  v.literal("cancelled"),
  // Phase-2 lifecycle stages
  v.literal("draft"),
  v.literal("planning"),
  v.literal("approved"),
  v.literal("review"),
  v.literal("report_issued"),
  v.literal("closed"),
);

/**
 * Phase-2 finding lifecycle: identified → draft → reviewed →
 * management_response → corrective_action → closed. Phase-1 statuses remain
 * valid for existing rows.
 */
export const findingStatusValidator = v.union(
  v.literal("open"),
  v.literal("in_remediation"),
  v.literal("resolved"),
  v.literal("risk_accepted"),
  v.literal("closed"),
  // Phase-2 lifecycle stages
  v.literal("identified"),
  v.literal("draft"),
  v.literal("reviewed"),
  v.literal("management_response"),
  v.literal("corrective_action"),
);

// Risk vocabulary + scoring live in src/lib/risk.ts (shared with the backend
// and the register UI); re-exported here for existing schema consumers.
export { riskStatusValidator };

export const controlEffectivenessValidator = v.union(
  v.literal("effective"),
  v.literal("partially_effective"),
  v.literal("ineffective"),
  v.literal("not_tested"),
);

export const vulnerabilityStatusValidator = v.union(
  v.literal("open"),
  v.literal("confirmed"),
  v.literal("remediated"),
  v.literal("risk_accepted"),
  v.literal("false_positive"),
);

export const drTestStatusValidator = v.union(
  v.literal("planned"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("deferred"),
);

export const notificationSeverityValidator = v.union(
  v.literal("info"),
  v.literal("success"),
  v.literal("warning"),
  v.literal("critical"),
);

// ---------------------------------------------------------------------------
// PHASE 2 ENUMERATIONS — audit management engine
// ---------------------------------------------------------------------------

/** Audit universe categories (Module 1). */
export const AUDIT_UNIVERSE_CATEGORIES = [
  "Application",
  "Database",
  "Network",
  "Server",
  "Cloud Service",
  "Digital Service",
  "ICT Process",
  "Security Platform",
  "Third Party Service",
  "Other",
] as const;
export const universeCategoryValidator = v.union(
  ...AUDIT_UNIVERSE_CATEGORIES.map((c) => v.literal(c)),
);
export type UniverseCategory = Infer<typeof universeCategoryValidator>;

/** Five-level criticality scale used for scoring inputs. */
export const CRITICALITY_LEVELS_VALIDATOR = [
  "very_low",
  "low",
  "medium",
  "high",
  "very_high",
] as const;
export const criticalityLevelValidator = v.union(
  ...CRITICALITY_LEVELS_VALIDATOR.map((c) => v.literal(c)),
);

/** Audit universe item lifecycle (Module 1). */
export const universeItemStatusValidator = v.union(
  v.literal("active"),
  v.literal("inactive"),
  v.literal("archived"),
);

/** Audit plan items (Module 2). */
export const planItemStatusValidator = v.union(
  v.literal("planned"),
  v.literal("scheduled"),
  v.literal("in_progress"),
  v.literal("completed"),
  v.literal("deferred"),
  v.literal("cancelled"),
);

/** Priority bands from the risk-based scoring engine. */
export const priorityBandValidator = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
  v.literal("critical"),
);

/** Audit team assignment roles (Module 4) — src/lib/auditWorkflow.ts. */
export const auditTeamRoleValidator = v.union(
  v.literal("audit_director"),
  v.literal("audit_manager"),
  v.literal("lead_auditor"),
  v.literal("auditor"),
  v.literal("reviewer"),
);

/** Audit program / procedure lifecycle (Module 5). */
export const programStatusValidator = v.union(
  v.literal("draft"),
  v.literal("approved"),
  v.literal("completed"),
);

export const procedureStatusValidator = v.union(
  v.literal("not_started"),
  v.literal("in_progress"),
  v.literal("completed"),
);

export const procedureResultValidator = v.union(
  v.literal("pass"),
  v.literal("fail"),
  v.literal("exception"),
);

/** Working paper lifecycle (Module 6). */
export const workingPaperStatusValidator = v.union(
  v.literal("draft"),
  v.literal("submitted"),
  v.literal("reviewed"),
  v.literal("returned"),
  v.literal("approved"),
);

/** Evidence lifecycle states (Module 7). */
export const evidenceStatusValidator = v.union(
  v.literal("collected"),
  v.literal("stored"),
  v.literal("reviewed"),
  v.literal("referenced"),
  v.literal("archived"),
);

/**
 * Corrective-action statuses. Phase-1 values (not_started/implemented) remain
 * valid for seeded rows; Phase 2 uses the formal set
 * open → in_progress → completed → verified → closed (+ overdue).
 */
export const correctiveActionStatusValidator = v.union(
  v.literal("not_started"),
  v.literal("in_progress"),
  v.literal("implemented"),
  v.literal("verified"),
  v.literal("overdue"),
  // Phase-2 lifecycle states
  v.literal("open"),
  v.literal("completed"),
  v.literal("closed"),
);

// Common bookkeeping timestamps. Each domain table declares its own
// organizationId (the multi-tenant boundary) explicitly.
const auditFields = {
  createdAt: v.number(),
  updatedAt: v.number(),
};

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // ------------------------------------------------------------------
    // ORGANIZATION MANAGEMENT — Ministries, Departments, Agencies & Counties
    // ------------------------------------------------------------------
    organizations: defineTable({
      name: v.string(),
      code: v.string(), // e.g. "MICDE", "KRA", "Nairobi County"
      type: v.union(
        v.literal("ministry"),
        v.literal("department"),
        v.literal("agency"),
        v.literal("county"),
        v.literal("state_corporation"),
      ),
      description: v.optional(v.string()),
      isDemo: v.optional(v.boolean()),
      createdAt: v.number(),
      updatedAt: v.number(),
    }).index("code", ["code"]),

    // Profile extension for the auth user (separate from auth-owned fields).
    // Presence of a profile row with an explicit organizationId marks the user
    // as provisioned; organization access requires it (no fallbacks).
    userProfiles: defineTable({
      userId: v.id("users"),
      organizationId: v.optional(v.id("organizations")),
      // Explicit validated role — never inferred from permission strings.
      role: v.optional(roleValidator),
      jobTitle: v.optional(v.string()),
      department: v.optional(v.string()),
      phone: v.optional(v.string()),
      // Organization-membership lifecycle state (Phase 3A — Batch 2A). The
      // security boundary is the membership (this profile row), never a
      // global user status. Absent value resolves to "active" so existing
      // rows keep access without a data migration. Suspended/deactivated
      // memberships are denied all organization access server-side
      // (src/convex/access.ts resolveAccess).
      membershipStatus: v.optional(
        v.union(
          v.literal("active"),
          v.literal("suspended"),
          v.literal("deactivated"),
        ),
      ),
      // Deliberate permission overrides (grants), separate from role
      // assignment. Evaluated explicitly where a feature requires it.
      permissionOverrides: v.optional(v.array(v.string())),
      // Trusted-test-harness demo role grants (demo-escalation hardening).
      // Set ONLY by the internal, token-guarded harness mutations for
      // anonymous users with an established IITAMS-DEMO membership; the
      // elevated role stored in `role` is considered EXPIRED by
      // resolveAccess (src/convex/access.ts) once this deadline passes, so
      // revoked-or-abandoned test privileges never authorize protected
      // operations even without a cleanup sweep.
      demoRoleExpiresAt: v.optional(v.number()),
      demoRoleGrantedAt: v.optional(v.number()),
      lastSeenAt: v.optional(v.number()),
    })
      .index("userId", ["userId"])
      .index("by_organization", ["organizationId"]),

    // ------------------------------------------------------------------
    // ADMINISTRATOR LIFECYCLE (Phase 3A — Batch A1)
    // ------------------------------------------------------------------
    // Controlled administrator-grant workflow: an existing administrator
    // initiates a PENDING grant for an eligible same-organization member;
    // the grant elevates NOBODY until the recipient's own verified identity
    // accepts it server-side. Every transition is append-audited and stores
    // the privileged role's PREVIOUS role so revocation restores it exactly
    // (never an automatic demotion to `member`).
    administratorGrants: defineTable({
      organizationId: v.id("organizations"),
      targetUserId: v.id("users"),
      // Auditable labels only — no secrets, no tokens, no OTP codes.
      targetLabel: v.string(),
      initiatorUserId: v.id("users"),
      initiatorLabel: v.string(),
      // The target's own role AT INITIATION (the canonical registry keys);   
      // `admin` is structurally impossible (initiation refuses targets that
      // already hold the role).
      previousRole: v.union(...roleValidator.members),
      // pending → accepted | rejected | expired | cancelled
      // accepted → revoked
      status: v.union(
        v.literal("pending"),
        v.literal("accepted"),
        v.literal("rejected"),
        v.literal("expired"),
        v.literal("cancelled"),
        v.literal("revoked"),
      ),
      requestedAt: v.number(),
      expiresAt: v.number(),
      decidedAt: v.optional(v.number()),
      revokedAt: v.optional(v.number()),
      revokedByUserId: v.optional(v.id("users")),
    })
      .index("by_organization_status", ["organizationId", "status"])
      .index("by_target_status", ["targetUserId", "status"]),

    // One-time, deployment-controlled first-administrator bootstrap.
    // A row here IS the durable consumption marker: once inserted, the
    // bootstrap for that organization stays disabled forever, even if the
    // environment token is accidentally left configured. Only the SHA-256
    // hash of the consumed secret is persisted — never the secret itself.
    initialBootstraps: defineTable({
      organizationId: v.id("organizations"),
      targetUserId: v.id("users"),
      targetEmail: v.string(),
      // The target's role BEFORE the bootstrap grant (restored verbatim on
      // revocation); `admin` is structurally impossible here.
      previousRole: v.union(...roleValidator.members),
      tokenHash: v.string(), // SHA-256 of the consumed one-time secret
      consumedAt: v.number(),
    }).index("by_organization", ["organizationId"]),

    // ------------------------------------------------------------------
    // AUDIT MANAGEMENT
    // ------------------------------------------------------------------
    // Module 1 — Audit Universe: all ICT entities that may require coverage.
    // Phase-1 fields (code/domain/inherentRisk) retained; Phase 2 adds the
    // full descriptive/scoring attribute set (all optional for migration).
    auditUniverseItems: defineTable({
      organizationId: v.id("organizations"),
      code: v.string(),
      name: v.string(),
      domain: v.string(), // e.g. "Infrastructure", "Applications", "Data"
      inherentRisk: severityValidator,
      // --- Phase 2 attributes ---
      description: v.optional(v.string()),
      category: v.optional(universeCategoryValidator),
      owner: v.optional(v.string()),
      businessUnit: v.optional(v.string()),
      technologyType: v.optional(v.string()),
      criticality: v.optional(criticalityLevelValidator),
      businessImpact: v.optional(v.string()),
      dataClassification: v.optional(classificationValidator),
      regulatoryImportance: v.optional(criticalityLevelValidator),
      securityExposure: v.optional(criticalityLevelValidator),
      status: v.optional(universeItemStatusValidator), // active by default
      createdById: v.optional(v.id("users")),
      lastAuditedAt: v.optional(v.number()),
      nextAuditDue: v.optional(v.number()),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_organization", ["organizationId"])
      .index("by_status", ["organizationId", "status"])
      .index("by_category", ["organizationId", "category"]),

    // Module 2 — Audit Plans (annual / multi-year). Phase-1 fields retained.
    auditPlans: defineTable({
      organizationId: v.id("organizations"),
      name: v.string(),
      fiscalYear: v.string(),
      status: v.union(
        v.literal("draft"),
        v.literal("approved"),
        v.literal("in_execution"),
        v.literal("closed"),
      ),
      totalEngagements: v.number(),
      completedEngagements: v.number(),
      // --- Phase 2 attributes ---
      period: v.optional(v.string()), // e.g. "FY 2025/26 – FY 2027/28"
      coverageObjective: v.optional(v.string()),
      description: v.optional(v.string()),
      approvedById: v.optional(v.id("users")),
      approvedByName: v.optional(v.string()),
      approvalDate: v.optional(v.number()),
      createdById: v.optional(v.id("users")),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    }).index("by_organization", ["organizationId"]),

    // Module 2 — Plan line items: which universe items are scheduled, with
    // the computed audit priority score at planning time.
    auditPlanItems: defineTable({
      organizationId: v.id("organizations"),
      auditPlanId: v.id("auditPlans"),
      auditUniverseItemId: v.id("auditUniverseItems"),
      priorityScore: v.number(), // 0–100 (auditScoring.computePriorityScore)
      priorityBand: priorityBandValidator,
      scoringInputs: v.optional(v.object({
        criticality: v.number(),
        dataSensitivity: v.number(),
        regulatoryImpact: v.number(),
        securityExposure: v.number(),
        previousFindings: v.number(),
        changeFrequency: v.number(),
      })),
      plannedStartDate: v.optional(v.number()),
      plannedEndDate: v.optional(v.number()),
      estimatedEffortDays: v.optional(v.number()),
      assignedManagerId: v.optional(v.id("users")),
      assignedManagerName: v.optional(v.string()),
      status: planItemStatusValidator,
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_plan", ["auditPlanId"])
      .index("by_organization", ["organizationId"])
      .index("by_universe_item", ["auditUniverseItemId"]),

    // Module 3 — Audit Engagements. Phase-1 fields retained; Phase 2 adds
    // the formal lifecycle status values and engagement detail.
    auditEngagements: defineTable({
      organizationId: v.id("organizations"),
      code: v.string(), // engagement number, e.g. "ENG-2026-001"
      name: v.string(), // title
      planId: v.optional(v.id("auditPlans")),
      universeItemId: v.optional(v.id("auditUniverseItems")),
      status: auditEngagementStatusValidator,
      leadAuditorId: v.optional(v.id("users")),
      startDate: v.optional(v.number()),
      targetEndDate: v.optional(v.number()),
      progressPct: v.number(),
      // --- Phase 2 attributes ---
      objective: v.optional(v.string()),
      scope: v.optional(v.string()),
      criteria: v.optional(v.string()),
      auditManagerId: v.optional(v.id("users")),
      auditManagerName: v.optional(v.string()),
      endDate: v.optional(v.number()),
      createdById: v.optional(v.id("users")),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_organization", ["organizationId"])
      .index("by_status", ["organizationId", "status"])
      .index("by_plan", ["planId"])
      .index("by_universe_item", ["universeItemId"]),

    // Module 4 — Audit team assignments. Only assigned users may perform
    // engagement activities (enforced server-side; see src/convex/auditAccess.ts).
    auditAssignments: defineTable({
      organizationId: v.id("organizations"),
      engagementId: v.id("auditEngagements"),
      userId: v.id("users"),
      teamRole: auditTeamRoleValidator,
      assignedById: v.optional(v.id("users")),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_engagement", ["engagementId"])
      .index("by_user", ["userId"])
      .index("by_organization", ["organizationId"]),

    // Module 5 — Audit programs (per engagement) and their procedures.
    auditPrograms: defineTable({
      organizationId: v.id("organizations"),
      engagementId: v.id("auditEngagements"),
      code: v.string(),
      title: v.string(),
      objective: v.optional(v.string()),
      status: programStatusValidator,
      createdById: v.optional(v.id("users")),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_engagement", ["engagementId"])
      .index("by_organization", ["organizationId"]),

    auditProcedures: defineTable({
      organizationId: v.id("organizations"),
      auditProgramId: v.id("auditPrograms"),
      engagementId: v.id("auditEngagements"),
      code: v.string(),
      procedureName: v.string(),
      description: v.optional(v.string()),
      controlObjective: v.optional(v.string()),
      expectedEvidence: v.optional(v.string()),
      assignedAuditorId: v.optional(v.id("users")),
      completionStatus: procedureStatusValidator,
      result: v.optional(procedureResultValidator), // Pass / Fail / Exception
      resultNotes: v.optional(v.string()),
      completedAt: v.optional(v.number()),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_program", ["auditProgramId"])
      .index("by_engagement", ["engagementId"])
      .index("by_organization", ["organizationId"])
      .index("by_assigned_auditor", ["assignedAuditorId"]),

    // Module 6 — Working papers with reviewer workflow.
    workingPapers: defineTable({
      organizationId: v.id("organizations"),
      engagementId: v.id("auditEngagements"),
      code: v.string(),
      title: v.string(),
      description: v.optional(v.string()),
      // Auditor notes / test results (prepared-by content).
      content: v.optional(v.string()),
      createdById: v.optional(v.id("users")),
      reviewerId: v.optional(v.id("users")),
      status: workingPaperStatusValidator,
      reviewComments: v.optional(v.string()),
      submittedAt: v.optional(v.number()),
      reviewedAt: v.optional(v.number()),
      approvedAt: v.optional(v.number()),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_engagement", ["engagementId"])
      .index("by_reviewer", ["reviewerId"])
      .index("by_organization", ["organizationId"])
      .index("by_status", ["organizationId", "status"]),

    // Module 6 — Reviewer comments / approval history on a working paper.
    workingPaperComments: defineTable({
      organizationId: v.id("organizations"),
      workingPaperId: v.id("workingPapers"),
      authorId: v.optional(v.id("users")),
      authorName: v.optional(v.string()),
      body: v.string(),
      createdAt: v.number(),
      isDemo: v.optional(v.boolean()),
    }).index("by_paper", ["workingPaperId"]),

    // Module 7 — Evidence metadata + integrity (SHA-256). File bytes live in
    // Convex file storage; storageId links each record to its blob.
    evidence: defineTable({
      organizationId: v.id("organizations"),
      engagementId: v.optional(v.id("auditEngagements")),
      workingPaperId: v.optional(v.id("workingPapers")),
      filename: v.string(),
      fileType: v.string(), // MIME type
      sizeBytes: v.number(),
      classification: classificationValidator,
      sha256: v.string(), // integrity hash computed at upload
      storageId: v.optional(v.id("_storage")), // Convex file storage pointer
      source: v.optional(v.string()),
      description: v.optional(v.string()),
      collectedAt: v.optional(v.number()),
      uploadedById: v.optional(v.id("users")),
      status: evidenceStatusValidator,
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_organization", ["organizationId"])
      .index("by_engagement", ["engagementId"])
      .index("by_paper", ["workingPaperId"])
      .index("by_sha", ["sha256"]),

    // Module 8 — Findings. Phase-1 fields retained; Phase 2 adds the full
    // lifecycle and the structured finding attributes.
    findings: defineTable({
      organizationId: v.id("organizations"),
      engagementId: v.optional(v.id("auditEngagements")),
      code: v.string(),
      title: v.string(),
      description: v.optional(v.string()),
      severity: severityValidator,
      status: findingStatusValidator,
      ownerName: v.optional(v.string()),
      dueDate: v.optional(v.number()),
      isOverdue: v.optional(v.boolean()),
      // --- Phase 2 attributes ---
      condition: v.optional(v.string()),
      criteria: v.optional(v.string()),
      rootCause: v.optional(v.string()),
      impact: v.optional(v.string()),
      recommendation: v.optional(v.string()),
      riskRating: v.optional(v.number()), // 1–25 (likelihood × impact)
      managementResponse: v.optional(v.string()),
      createdById: v.optional(v.id("users")),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_organization", ["organizationId"])
      .index("by_status", ["organizationId", "status"])
      .index("by_severity", ["organizationId", "severity"])
      .index("by_engagement", ["engagementId"]),

    // Module 9 — Corrective actions / remediation tracking.
    correctiveActions: defineTable({
      organizationId: v.id("organizations"),
      findingId: v.optional(v.id("findings")),
      title: v.string(),
      status: correctiveActionStatusValidator,
      ownerName: v.optional(v.string()),
      dueDate: v.optional(v.number()),
      // --- Phase 2 attributes ---
      description: v.optional(v.string()),
      responsiblePerson: v.optional(v.string()),
      responsiblePersonId: v.optional(v.id("users")),
      completionEvidence: v.optional(v.string()),
      verifiedById: v.optional(v.id("users")),
      verifiedByName: v.optional(v.string()),
      verifiedAt: v.optional(v.number()),
      lastReminderAt: v.optional(v.number()),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_organization", ["organizationId"])
      .index("by_status", ["organizationId", "status"])
      .index("by_finding", ["findingId"]),

    // ------------------------------------------------------------------
    // ICT RISK MANAGEMENT
    // ------------------------------------------------------------------
    risks: defineTable({
      organizationId: v.id("organizations"),
      // Human-readable unique identifier within the organization (R-001…).
      code: v.string(),
      title: v.string(),
      // Enum-validated register category; `Other` covers local taxonomy.
      category: riskCategoryValidator,
      description: v.optional(v.string()),
      // Related ICT asset, system or service (free text until an asset
      // register model exists; kept deliberately denormalised).
      assetOrService: v.optional(v.string()),
      threat: v.optional(v.string()),
      vulnerability: v.optional(v.string()),
      inherentLikelihood: v.number(), // 1-5
      inherentImpact: v.number(), // 1-5
      residualLikelihood: v.number(),
      residualImpact: v.number(),
      existingControls: v.optional(v.string()),
      treatmentRecommendation: v.optional(v.string()),
      status: riskStatusValidator,
      // Owner: a provisioned member when available, plus a display label so
      // historical rows stay readable if the membership changes.
      ownerUserId: v.optional(v.id("users")),
      ownerName: v.optional(v.string()),
      reviewDue: v.optional(v.number()),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_organization", ["organizationId"])
      .index("by_status", ["organizationId", "status"])
      // Unique risk identifier per organization (creation checks this index).
      .index("by_organization_code", ["organizationId", "code"]),

    // ------------------------------------------------------------------
    // COMPLIANCE MANAGEMENT
    // ------------------------------------------------------------------
    complianceFrameworks: defineTable({
      organizationId: v.id("organizations"),
      name: v.string(), // ISO 27001, NIST CSF, Data Protection Act 2019...
      code: v.string(),
      totalControls: v.number(),
      implementedControls: v.number(),
      complianceScorePct: v.number(),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    }).index("by_organization", ["organizationId"]),

    controls: defineTable({
      organizationId: v.id("organizations"),
      frameworkId: v.optional(v.id("complianceFrameworks")),
      code: v.string(),
      name: v.string(),
      effectiveness: controlEffectivenessValidator,
      lastTestedAt: v.optional(v.number()),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_organization", ["organizationId"])
      .index("by_effectiveness", ["organizationId", "effectiveness"]),

    // ------------------------------------------------------------------
    // CYBERSECURITY ASSURANCE & VULNERABILITY MANAGEMENT
    // ------------------------------------------------------------------
    vulnerabilities: defineTable({
      organizationId: v.id("organizations"),
      cveId: v.optional(v.string()),
      assetName: v.string(),
      title: v.string(),
      severity: severityValidator,
      cvssScore: v.optional(v.number()),
      status: vulnerabilityStatusValidator,
      discoveredAt: v.number(),
      remediationDue: v.optional(v.number()),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_organization", ["organizationId"])
      .index("by_severity", ["organizationId", "severity"])
      .index("by_status", ["organizationId", "status"]),

    securityAssessments: defineTable({
      organizationId: v.id("organizations"),
      name: v.string(),
      type: v.union(
        v.literal("penetration_test"),
        v.literal("network_assessment"),
        v.literal("application_security"),
        v.literal("configuration_review"),
        v.literal("red_team"),
      ),
      status: v.union(
        v.literal("scheduled"),
        v.literal("in_progress"),
        v.literal("completed"),
      ),
      startedAt: v.optional(v.number()),
      completedAt: v.optional(v.number()),
      criticalFindings: v.number(),
      highFindings: v.number(),
      mediumFindings: v.number(),
      lowFindings: v.number(),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_organization", ["organizationId"])
      .index("by_type", ["organizationId", "type"]),

    // ------------------------------------------------------------------
    // BUSINESS CONTINUITY / DISASTER RECOVERY
    // ------------------------------------------------------------------
    criticalServices: defineTable({
      organizationId: v.id("organizations"),
      name: v.string(),
      rtoHours: v.number(),
      rpoHours: v.number(),
      currentRtoHours: v.optional(v.number()),
      currentRpoHours: v.optional(v.number()),
      readinessScorePct: v.number(),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    }).index("by_organization", ["organizationId"]),

    drTests: defineTable({
      organizationId: v.id("organizations"),
      name: v.string(),
      scope: v.string(),
      scheduledFor: v.number(),
      status: drTestStatusValidator,
      lessonsLearned: v.optional(v.string()),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_organization", ["organizationId"])
      .index("by_status", ["organizationId", "status"]),

    // ------------------------------------------------------------------
    // REPORTING & ANALYTICS — pre-aggregated time series
    // ------------------------------------------------------------------
    riskTrendSnapshots: defineTable({
      organizationId: v.id("organizations"),
      periodLabel: v.string(), // e.g. "2025-Q3"
      periodStart: v.number(),
      openRisks: v.number(),
      criticalHighRisks: v.number(),
      avgResidualScore: v.number(), // 1-25
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    }).index("by_organization", ["organizationId"]),

    // ------------------------------------------------------------------
    // NOTIFICATIONS
    // ------------------------------------------------------------------
    notifications: defineTable({
      organizationId: v.optional(v.id("organizations")),
      userId: v.optional(v.id("users")),
      title: v.string(),
      body: v.optional(v.string()),
      severity: notificationSeverityValidator,
      href: v.optional(v.string()),
      readAt: v.optional(v.number()),
      isDemo: v.optional(v.boolean()),
      createdAt: v.number(),
    })
      .index("by_user", ["userId"])
      .index("by_organization", ["organizationId"]),

    // ------------------------------------------------------------------
    // DEVELOPMENT-ONLY TOOLING
    // ------------------------------------------------------------------
    // Pending OTP codes for the browser-test bridge. Written ONLY by the
    // email-otp provider's no-delivery branch on development deployments
    // (guest auth enabled), and only read there. Production deployments
    // with a configured provider never populate this table.
    devOtpCodes: defineTable({
      email: v.string(),
      code: v.string(),
      expirationTime: v.number(),
      createdAt: v.number(),
    }).index("by_email", ["email"]),

    // ------------------------------------------------------------------
    // ORGANIZATION INVITATIONS (Phase 3A — Batch 2C)
    // ------------------------------------------------------------------
    // Secure, organization-scoped invitations for users who have not yet
    // joined the host organization. Security properties (see
    // src/convex/invitations.ts for the enforcement):
    //  - the invitation secret is generated client-agnostic, single-use and
    //    hashed; only the SHA-256 HEX HASH is stored, never the plaintext;
    //  - a token is NOT authentication: acceptance additionally requires a
    //    real, email-verified Convex Auth identity whose verified email
    //    matches the invited address exactly;
    //  - acceptance writes the membership and terminal invitation state in
    //    ONE transaction (no partial states, no replay);
    //  - the invited email is canonically normalized (lower-case trimmed)
    //    matching Convex Auth identifier storage.
    organizationInvitations: defineTable({
      organizationId: v.id("organizations"),
      // Canonical (lower-case, trimmed) invitee email.
      email: v.string(),
      // Initial role assigned upon acceptance — restricted to
      // PROVISIONABLE_INITIAL_ROLES (the privileged `admin` role is
      // structurally impossible here; see invitations.ts validation).
      role: v.union(
        ...PROVISIONABLE_INITIAL_ROLES.map((r) => v.literal(r)),
      ),
      jobTitle: v.optional(v.string()),
      // Lifecycle: pending_delivery → pending → accepted; alternative
      // transitions: pending → revoked, pending → expired,
      // pending_delivery → delivery_failed (reissueable).
      status: v.union(
        v.literal("pending_delivery"),
        v.literal("pending"),
        v.literal("delivery_failed"),
        v.literal("accepted"),
        v.literal("revoked"),
        v.literal("expired"),
      ),
      // SHA-256 hex hash of the CURRENT acceptance secret (re-armed on send
      // and resend; the previous hash is never reused for a second secret —
      // a resend issues a NEW secret and overwrites the hash, so token
      // replay across sends is impossible).
      secretHash: v.optional(v.string()),
      // One-time acceptance flag: set at acceptance time together with all
      // other terminal-acceptance fields in the same transaction.
      acceptedAt: v.optional(v.number()),
      acceptedUserId: v.optional(v.id("users")),
      acceptedProfileId: v.optional(v.id("userProfiles")),
      // Administrative lifecycle.
      createdBy: v.id("users"), // inviting administrator
      revokedAt: v.optional(v.number()),
      revokedBy: v.optional(v.id("users")),
      // Expiry is evaluated server-side (never only client-side).
      createdAt: v.number(),
      expiresAt: v.number(),
      // Latest delivery attempt bookkeeping (safe metadata only — never the
      // secret, never OTP codes, never provider credentials).
      deliveryStatus: v.union(
        v.literal("not_yet"),
        v.literal("sending"),
        v.literal("sent"),
        v.literal("failed"),
        v.literal("skipped"),
      ),
      deliveryLastAttemptAt: v.optional(v.number()),
      deliveryConfirmedAt: v.optional(v.number()),
      deliveryAttempts: v.optional(v.number()),
      deliveryError: v.optional(v.string()),
    })
      // Duplicate prevention: at most ONE actionable invitation per
      // (organization, email) — see the atomic checks in invitations.ts.
      .index("by_organization_email", ["organizationId", "email"])
      // Expiry sweep / org-scoped listing support.
      .index("by_organization", ["organizationId"])
      .index("by_organization_status", ["organizationId", "status"])
      // Lookup by stored hash for token acceptance (keeps the acceptance path
      // hash-driven — a guessed plaintext never enumerates invitations).
      .index("by_secret_hash", ["secretHash"]),

    // ------------------------------------------------------------------
    // ACCESS REVIEWS — Phase 3A Batch A3 (recertification foundation)
    // ------------------------------------------------------------------
    // Organisation-scoped review cycles, immutable membership SNAPSHOTS and
    // append-only decisions/recommendations on top of the existing RBAC and
    // membership model.
    //
    //  - Snapshots copy the reviewed membership's identity, role, membership
    //    status and last-activity at capture time. Rows are insert-only: later
    //    role/status changes never rewrite historical review evidence.
    //  - Decisions are append-only (history preserved); the latest row is the
    //    current decision.
    //  - Remediation rows record a RECOMMENDATION. `status` only becomes
    //    "applied" after the existing authorized mutation succeeds; a
    //    recommendation is never presented as implemented.
    accessReviewCycles: defineTable({
      organizationId: v.id("organizations"),
      title: v.string(),
      dueAt: v.number(),
      status: accessReviewCycleStatusValidator,
      creatorUserId: v.id("users"),
      creatorLabel: v.string(),
      createdAt: v.number(),
      completedAt: v.optional(v.number()),
      completedByUserId: v.optional(v.id("users")),
      completedByLabel: v.optional(v.string()),
      // Resumable snapshot capture (organizations larger than one batch).
      // The cursor persists between calls so a bounded, page-sized batch can
      // be resumed without rescanning; `captureScanComplete` is the only
      // signal that the snapshot is complete enough to close the cycle.
      captureCursor: v.optional(v.string()),
      membersScanned: v.optional(v.number()),
      membersEligible: v.optional(v.number()),
      captureScanComplete: v.optional(v.boolean()),
      captureCompletedAt: v.optional(v.number()),
      lastCaptureAt: v.optional(v.number()),
    }).index("by_organization", ["organizationId"]),

    accessReviewItems: defineTable({
      organizationId: v.id("organizations"),
      cycleId: v.id("accessReviewCycles"),
      targetProfileId: v.id("userProfiles"),
      targetUserId: v.id("users"),
      // Frozen copy of the reviewed membership at capture time.
      targetLabel: v.string(),
      targetEmail: v.optional(v.string()),
      roleSnapshot: v.optional(v.string()),
      membershipStatusSnapshot: v.string(),
      lastActivityAt: v.optional(v.number()),
      capturedAt: v.number(),
      capturedByUserId: v.id("users"),
      capturedByLabel: v.string(),
    })
      .index("by_cycle", ["cycleId"])
      // Duplicate prevention for resumable capture: one snapshot per reviewed
      // membership per cycle, enforced by lookup on this index.
      .index("by_cycle_target", ["cycleId", "targetProfileId"])
      .index("by_organization", ["organizationId"]),

    accessReviewDecisions: defineTable({
      organizationId: v.id("organizations"),
      cycleId: v.id("accessReviewCycles"),
      itemId: v.id("accessReviewItems"),
      decision: accessReviewDecisionValidator,
      notes: v.optional(v.string()),
      reviewerUserId: v.id("users"),
      reviewerLabel: v.string(),
      createdAt: v.number(),
    })
      .index("by_item", ["itemId"])
      .index("by_cycle", ["cycleId"])
      .index("by_organization", ["organizationId"]),

    accessReviewRemediations: defineTable({
      organizationId: v.id("organizations"),
      cycleId: v.id("accessReviewCycles"),
      itemId: v.id("accessReviewItems"),
      recommendation: accessReviewRecommendationValidator,
      targetRole: v.optional(v.string()),
      notes: v.optional(v.string()),
      status: accessReviewRemediationStatusValidator,
      proposedByUserId: v.id("users"),
      proposedByLabel: v.string(),
      createdAt: v.number(),
      appliedAt: v.optional(v.number()),
      appliedByUserId: v.optional(v.id("users")),
      appliedByLabel: v.optional(v.string()),
      withdrawnAt: v.optional(v.number()),
      withdrawnByLabel: v.optional(v.string()),
      roleBefore: v.optional(v.string()),
      roleAfter: v.optional(v.string()),
      membershipBefore: v.optional(v.string()),
      membershipAfter: v.optional(v.string()),
    })
      .index("by_item", ["itemId"])
      .index("by_cycle", ["cycleId"])
      .index("by_organization", ["organizationId"]),

    // ------------------------------------------------------------------
    // AUDIT LOGGING — immutable trail of significant actions
    // ------------------------------------------------------------------
    auditLogs: defineTable({
      organizationId: v.optional(v.id("organizations")),
      userId: v.optional(v.id("users")),
      // Acting identity (Phase 3A — Batch 2B). `userId` records the user the
      // entry CONCERNS (target); `actorLabel` kept working for historical rows
      // and `actorId` now records the acting principal explicitly, so
      // administrative entries never conflate actor with target. Optional +
      // backward-compatible: existing rows are untouched and remain valid.
      actorId: v.optional(v.id("users")),
      actorLabel: v.optional(v.string()),
      action: v.string(), // e.g. "engagement.created"
      entityType: v.string(),
      entityId: v.optional(v.string()),
      summary: v.optional(v.string()),
      createdAt: v.number(),
    })
      .index("by_organization", ["organizationId"])
      // Phase 3B: per-record history lookups (e.g. risk detail audit trail)
      // without scanning the organization's whole log.
      .index("by_organization_entity", [
        "organizationId",
        "entityType",
        "entityId",
      ]),
  },
  {
    // Production behaviour: documents are validated against this schema on
    // every write. Demo seed data satisfies these validators.
    schemaValidation: true,
  },
);

export default schema;
