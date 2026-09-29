import { describe, expect, test } from "bun:test";
import {
  BAND_THRESHOLDS,
  computePriorityScore,
  criticalityToRating,
  classificationToRating,
  normalizeWeights,
  priorityBand,
  scoringInputsFromUniverse,
  DEFAULT_WEIGHTS,
  SCORING_INPUTS,
} from "../src/lib/auditScoring";
import {
  AUDIT_TEAM_ROLES,
  ACTION_LABELS,
  ENGAGEMENT_LABELS,
  ENGAGEMENT_ORDER,
  ENGAGEMENT_TRANSITIONS,
  FINDING_LABELS,
  FINDING_TRANSITIONS,
  WORKING_PAPER_LABELS,
  WORKING_PAPER_TRANSITIONS,
  canTransitionEngagement,
  engagementTransitionAllowed,
  findingTransitionAllowed,
  workingPaperTransitionAllowed,
  isActionOverdue,
  type EngagementStatus,
  type FindingStatus,
  type WorkingPaperStatus,
} from "../src/lib/auditWorkflow";

/**
 * Phase 2 unit tests — Core IT Audit Management Engine.
 * Pure domain logic (scoring + state machines) is tested directly; the
 * server-side authorization structure is verified with source guards so any
 * regression that removes tenant checks or audit logging fails loudly.
 */

// ---------------------------------------------------------------------------
// Module 2 — risk-based audit priority scoring
// ---------------------------------------------------------------------------

describe("audit priority scoring", () => {
  test("zero inputs score 0 (Low); maximal inputs score 100 (Critical)", () => {
    expect(computePriorityScore({})).toBe(0);
    expect(priorityBand(0)).toBe("low");
    expect(
      computePriorityScore({
        criticality: 5,
        dataSensitivity: 5,
        regulatoryImpact: 5,
        securityExposure: 5,
        previousFindings: 5,
        changeFrequency: 5,
      }),
    ).toBe(100);
    expect(priorityBand(100)).toBe("critical");
  });

  test("band boundaries match the documented thresholds", () => {
    expect(BAND_THRESHOLDS).toEqual({ medium: 40, high: 60, critical: 80 });
    expect(priorityBand(39)).toBe("low");
    expect(priorityBand(40)).toBe("medium");
    expect(priorityBand(59)).toBe("medium");
    expect(priorityBand(60)).toBe("high");
    expect(priorityBand(79)).toBe("high");
    expect(priorityBand(80)).toBe("critical");
  });

  test("weights normalize to sum 1 and scale scores proportionally", () => {
    const normalized = normalizeWeights({
      criticality: 0.5,
      dataSensitivity: 0.4,
      regulatoryImpact: 0.4,
      securityExposure: 0.3,
      previousFindings: 0.2,
      changeFrequency: 0.2,
    });
    const sum = Object.values(normalized).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    // Heavier weight on criticality moves a mixed profile upward.
    const inputs = {
      criticality: 5,
      dataSensitivity: 1,
      regulatoryImpact: 1,
      securityExposure: 1,
      previousFindings: 1,
      changeFrequency: 1,
    };
    const balanced = computePriorityScore(inputs);
    const tilted = computePriorityScore(inputs, {
      criticality: 1,
      dataSensitivity: 0,
      regulatoryImpact: 0,
      securityExposure: 0,
      previousFindings: 0,
      changeFrequency: 0,
    });
    expect(tilted).toBe(100);
    expect(balanced).toBeLessThan(tilted);
  });

  test("default weights match the documented configuration", () => {
    const sum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(DEFAULT_WEIGHTS.criticality).toBe(0.25);
  });

  test("six scoring inputs are defined", () => {
    expect([...SCORING_INPUTS].sort()).toEqual([
      "changeFrequency",
      "criticality",
      "dataSensitivity",
      "previousFindings",
      "regulatoryImpact",
      "securityExposure",
    ]);
  });

  test("criticality/classification mappings follow the documented scales", () => {
    expect(criticalityToRating("very_low")).toBe(1);
    expect(criticalityToRating("very_high")).toBe(5);
    expect(criticalityToRating("bogus" as never)).toBe(0);
    expect(classificationToRating("public")).toBe(1);
    expect(classificationToRating("restricted")).toBe(5);
  });

  test("universe-item derivation produces clamped inputs; overrides win", () => {
    const inputs = scoringInputsFromUniverse({
      criticality: "very_high",
      dataClassification: "restricted",
      regulatoryImportance: "very_high",
      securityExposure: "high",
    });
    expect(inputs.criticality).toBe(5);
    expect(inputs.dataSensitivity).toBe(5);
    const overridden = scoringInputsFromUniverse(
      {
        criticality: "very_high",
        dataClassification: "restricted",
        regulatoryImportance: "very_high",
        securityExposure: "high",
      },
      { previousFindings: 3, changeFrequency: 4 },
    );
    expect(overridden.previousFindings).toBe(3);
    expect(overridden.changeFrequency).toBe(4);
  });

  test("plan scheduling stores the server-computed score (source guard)", async () => {
    const src = await Bun.file("src/convex/auditPlans.ts").text();
    expect(src).toContain("computePriorityScore(inputs)");
    // The client's claimed values are never used for the stored score.
    expect(src).not.toMatch(/priorityScore:\s*args\./);
  });
});

// ---------------------------------------------------------------------------
// Modules 3/6/8/9 — workflow state machines
// ---------------------------------------------------------------------------

describe("engagement workflow", () => {
  test("lifecycle follows the seven-stage specification order", () => {
    expect(ENGAGEMENT_ORDER).toEqual([
      "draft",
      "planning",
      "approved",
      "fieldwork",
      "review",
      "report_issued",
      "closed",
    ]);
  });

  test("legal forward path is traversable stage by stage", () => {
    let s: EngagementStatus = "draft";
    const path = [
      "planning",
      "approved",
      "fieldwork",
      "review",
      "report_issued",
      "closed",
    ] as const;
    for (const next of path) {
      expect(canTransitionEngagement(s, next)).toBe(true);
      s = next;
    }
    expect(s).toBe("closed");
    expect(ENGAGEMENT_TRANSITIONS.closed).toEqual([]);
  });

  test("illegal transitions are rejected", () => {
    expect(canTransitionEngagement("draft", "fieldwork")).toBe(false);
    expect(canTransitionEngagement("closed", "draft")).toBe(false);
    expect(canTransitionEngagement("review", "planning")).toBe(false);
    expect(canTransitionEngagement("draft", "closed")).toBe(false);
  });

  test("cancellation is available from pre-review stages only", () => {
    expect(canTransitionEngagement("draft", "cancelled")).toBe(true);
    expect(canTransitionEngagement("planning", "cancelled")).toBe(true);
    expect(canTransitionEngagement("approved", "cancelled")).toBe(true);
    expect(canTransitionEngagement("fieldwork", "cancelled")).toBe(true);
    expect(canTransitionEngagement("review", "cancelled")).toBe(false);
    expect(canTransitionEngagement("report_issued", "cancelled")).toBe(false);
  });

  test("role authority: auditors may start planning, not approve or close", () => {
    expect(
      engagementTransitionAllowed("draft", "planning", "lead_auditor"),
    ).toBe(true);
    expect(
      engagementTransitionAllowed("planning", "approved", "lead_auditor"),
    ).toBe(false);
    expect(
      engagementTransitionAllowed("report_issued", "closed", "lead_auditor"),
    ).toBe(false);
  });

  test("role authority: managers and directors control approval and closure", () => {
    expect(engagementTransitionAllowed("planning", "approved", "audit_manager")).toBe(true);
    expect(engagementTransitionAllowed("planning", "approved", "audit_director")).toBe(true);
    expect(engagementTransitionAllowed("report_issued", "closed", "audit_manager")).toBe(true);
    // Auditor (plain) may not even start planning.
    expect(engagementTransitionAllowed("draft", "planning", "auditor")).toBe(false);
    // Unassigned callers can do nothing.
    expect(engagementTransitionAllowed("draft", "planning", undefined)).toBe(false);
    // Review cannot be cancelled except by the director before review.
    expect(engagementTransitionAllowed("fieldwork", "cancelled", "audit_director")).toBe(true);
    expect(engagementTransitionAllowed("fieldwork", "cancelled", "audit_manager")).toBe(false);
  });

  test("all stages have human labels", () => {
    for (const s of [...ENGAGEMENT_ORDER, "cancelled"] as const) {
      expect(ENGAGEMENT_LABELS[s].length).toBeGreaterThan(0);
    }
  });
});

describe("working paper workflow", () => {
  test("follows Draft → Submitted → Reviewed → Approved with a return loop", () => {
    expect(canTransitionEngagement === undefined).toBe(false); // sanity import
    let s: WorkingPaperStatus = "draft";
    expect(workingPaperTransitionAllowed(s, "submitted", "auditor")).toBe(true);
    s = "submitted";
    expect(workingPaperTransitionAllowed(s, "reviewed", "reviewer")).toBe(true);
    s = "reviewed";
    expect(workingPaperTransitionAllowed(s, "approved", "audit_manager")).toBe(true);
    expect(WORKING_PAPER_TRANSITIONS.approved).toEqual([]);
  });

  test("returned papers go back to the preparer and resubmit", () => {
    expect(workingPaperTransitionAllowed("submitted", "returned", "reviewer")).toBe(true);
    expect(workingPaperTransitionAllowed("returned", "submitted", "auditor")).toBe(true);
    expect(workingPaperTransitionAllowed("returned", "approved", "audit_manager")).toBe(false);
  });

  test("preparers cannot review their own work; reviewers cannot prepare", () => {
    expect(workingPaperTransitionAllowed("submitted", "reviewed", "auditor")).toBe(false);
    expect(workingPaperTransitionAllowed("draft", "submitted", "reviewer")).toBe(false);
    // Managers/directors may act as reviewers.
    expect(workingPaperTransitionAllowed("submitted", "reviewed", "audit_manager")).toBe(true);
    expect(workingPaperTransitionAllowed("submitted", "returned", "audit_director")).toBe(true);
  });

  test("all stages have human labels", () => {
    for (const s of Object.keys(WORKING_PAPER_LABELS) as WorkingPaperStatus[]) {
      expect(WORKING_PAPER_LABELS[s].length).toBeGreaterThan(0);
    }
  });
});

describe("finding workflow", () => {
  test("follows the six-stage specification order", () => {
    const path = [
      "identified",
      "draft",
      "reviewed",
      "management_response",
      "corrective_action",
      "closed",
    ] as const;
    let s: FindingStatus = "identified";
    for (const next of path.slice(1)) {
      expect(FINDING_TRANSITIONS[s]).toContain(next);
      s = next;
    }
    expect(FINDING_TRANSITIONS.closed).toEqual([]);
    for (const s of path) {
      expect(FINDING_LABELS[s].length).toBeGreaterThan(0);
    }
  });

  test("auditors draft; managers approve into management response", () => {
    expect(findingTransitionAllowed("identified", "draft", "auditor")).toBe(true);
    expect(findingTransitionAllowed("draft", "reviewed", "auditor")).toBe(false);
    expect(findingTransitionAllowed("draft", "reviewed", "lead_auditor")).toBe(true);
    expect(findingTransitionAllowed("reviewed", "management_response", "auditor")).toBe(false);
    expect(findingTransitionAllowed("reviewed", "management_response", "audit_manager")).toBe(true);
    expect(findingTransitionAllowed("corrective_action", "closed", "audit_director")).toBe(true);
  });

  test("revision loops are explicit and role-limited", () => {
    expect(findingTransitionAllowed("reviewed", "draft", "lead_auditor")).toBe(true);
    expect(findingTransitionAllowed("management_response", "reviewed", "audit_manager")).toBe(true);
    expect(findingTransitionAllowed("corrective_action", "management_response", "auditor")).toBe(false);
  });
});

describe("corrective actions", () => {
  test("all statuses have human labels", () => {
    for (const label of Object.values(ACTION_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });

  test("overdue detection ignores terminal states and missing dates", () => {
    const now = Date.now();
    const past = now - 1000;
    expect(isActionOverdue("open", past, now)).toBe(true);
    expect(isActionOverdue("in_progress", past, now)).toBe(true);
    expect(isActionOverdue("open", undefined, now)).toBe(false);
    expect(isActionOverdue("open", now + 1000, now)).toBe(false);
    expect(isActionOverdue("verified", past, now)).toBe(false);
    expect(isActionOverdue("closed", past, now)).toBe(false);
  });

  test("team roles cover the five specification roles", () => {
    expect([...AUDIT_TEAM_ROLES].sort()).toEqual([
      "audit_director",
      "audit_manager",
      "auditor",
      "lead_auditor",
      "reviewer",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Server-side authorization structure (source guards)
// ---------------------------------------------------------------------------

describe("audit backend security invariants (source guards)", () => {
  const files = [
    "src/convex/auditUniverse.ts",
    "src/convex/auditPlans.ts",
    "src/convex/auditEngagements.ts",
    "src/convex/auditWorkpapers.ts",
    "src/convex/auditEvidence.ts",
    "src/convex/auditFindings.ts",
    "src/convex/auditReports.ts",
    "src/convex/auditDashboard.ts",
  ];

  test("every audit module resolves access through the authorization core", async () => {
    for (const file of files) {
      const src = await Bun.file(file).text();
      const usesCore =
        src.includes("requirePermission") ||
        src.includes("requireEngagementAccess");
      expect(usesCore).toBe(true);
    }
  });

  test("engagement access re-checks tenant isolation before any read", async () => {
    const src = await Bun.file("src/convex/auditAccess.ts").text();
    expect(src).toContain("engagement.organizationId !== access.organizationId");
    // Unassigned users are never granted work rights.
    expect(src).toContain("platformPrivileged || teamRole !== undefined");
  });

  test("list queries filter by the caller's organization", async () => {
    for (const file of files) {
      const src = await Bun.file(file).text();
      if (!src.includes(".query(")) continue;
      // Every module either org-filters its queries directly or resolves the
      // parent engagement through requireEngagementAccess (which itself
      // re-checks the organizationId before any read).
      const orgFiltered =
        src.includes('access.organizationId!') ||
        src.includes('ea.access.organizationId!');
      const engagementScoped = src.includes("requireEngagementAccess");
      expect(orgFiltered || engagementScoped).toBe(true);
    }
  });

  test("mutations write to the immutable audit log via logAudit", async () => {
    const withMutations = [
      "src/convex/auditUniverse.ts",
      "src/convex/auditPlans.ts",
      "src/convex/auditEngagements.ts",
      "src/convex/auditWorkpapers.ts",
      "src/convex/auditEvidence.ts",
      "src/convex/auditFindings.ts",
    ];
    for (const file of withMutations) {
      const src = await Bun.file(file).text();
      expect(src).toContain("logAudit(");
    }
    // logAudit itself is insert-only.
    const accessSrc = await Bun.file("src/convex/auditAccess.ts").text();
    expect(accessSrc).toContain('ctx.db.insert("auditLogs"');
    expect(accessSrc).not.toMatch(/ctx\.db\.(patch|replace|delete)\("auditLogs"/);
  });

  test("evidence hashing is server-side and access-logged (source guard)", async () => {
    const src = await Bun.file("src/convex/auditEvidence.ts").text();
    expect(src).toContain("crypto.subtle.digest");
    expect(src).toContain('"SHA-256"');
    expect(src).toContain('action: "evidence.accessed"');
    // Restricted classification gates downloads to privileged roles.
    expect(src).toContain('classification !== "restricted"');
    expect(src).toContain('"audit_director"');
    // Hash computation is asynchronous (scheduled action), not trusted client
    // data: the public insert path stores an empty placeholder and the only
    // args-sourced hash write is the INTERNAL stamp mutation.
    expect(src).toContain('sha256: ""');
    const argHashWrites = src.match(/sha256:\s*args\./g) ?? [];
    expect(argHashWrites.length).toBe(1); // stampEvidenceHash (internal only)
    expect(src).toContain("internalMutation");
  });

  test("engagement transitions are guarded by the role matrix (source guard)", async () => {
    const src = await Bun.file("src/convex/auditEngagements.ts").text();
    expect(src).toContain("canTransitionEngagement");
    expect(src).toContain("engagementTransitionAllowed");
    // Team assignment requires a same-organization profile.
    expect(src).toContain("targetProfile.organizationId !== ea.access.organizationId");
  });

  test("findings enforce engagement assignment for creation (source guard)", async () => {
    const src = await Bun.file("src/convex/auditFindings.ts").text();
    expect(src).toContain("Only assigned users can raise findings");
  });

  test("audit team list requires assignment (Module 4 rule, source guard)", async () => {
    const src = await Bun.file("src/convex/auditEngagements.ts").text();
    expect(src).toContain("Only assigned users can view the team");
  });
});
