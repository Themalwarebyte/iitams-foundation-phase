import {
  isConfirmedVulnerabilityStatus,
  isOpenVulnerabilityStatus,
  type CyberRetestStatus,
  type CyberSeverity,
  type CyberTestOutcome,
  type CyberTestStatus,
  type CyberVulnerabilityStatus,
} from "./cyber";

/**
 * Security assurance reporting (Phase 4A — Batch 2B)
 * ==================================================
 * Pure aggregation over RECORDED rows. Nothing here invents a result, computes
 * a security score or certifies anything: it reports what humans recorded, how
 * much of it was independently reviewed, and what is still open or untested.
 *
 * The same function builds the live preview and the snapshot frozen when a
 * report is finalized, so a finalized report can never drift from what was
 * approved.
 */

export type ReportTestInput = {
  reference: string;
  title: string;
  status: CyberTestStatus;
  outcome: CyberTestOutcome;
  systemUnderTest: string;
  vulnerabilityId: string | null;
};

export type ReportRetestInput = {
  reference: string;
  originalTestReference: string;
  status: CyberRetestStatus;
  outcome: CyberTestOutcome;
  reviewedAt: number | null;
  reviewDecision: "approved" | "rejected" | null;
};

export type ReportVulnerabilityInput = {
  reference: string | null;
  title: string;
  severity: CyberSeverity;
  status: CyberVulnerabilityStatus;
  verifiedAt: number | null;
  closedAt: number | null;
};

export type ReportActionInput = {
  status: string;
  vulnerabilityReference: string | null;
};

export type ReportEvidenceInput = {
  reference: string;
  filename: string;
  classification: string;
  accessible: boolean;
};

export type AssuranceAssessmentInput = {
  name: string;
  reference: string | null;
  typeLabel: string;
  status: string;
  scope: string | null;
  objectives: string | null;
  systemsInScope: string | null;
  exclusions: string | null;
  methodology: string | null;
  authorizationReference: string | null;
  authorizedStartAt: number | null;
  authorizedEndAt: number | null;
  leadTesterLabel: string | null;
  ownerLabel: string | null;
};

export type AssuranceReportContent = {
  generatedAt: number;
  assessment: AssuranceAssessmentInput;
  tests: {
    total: number;
    planned: number;
    inProgress: number;
    completed: number;
    notApplicable: number;
    cancelled: number;
    passed: number;
    failed: number;
    inconclusive: number;
    notTested: number;
    testedSystems: string[];
  };
  retests: {
    total: number;
    planned: number;
    inProgress: number;
    awaitingReview: number;
    reviewed: number;
    rejected: number;
    passed: number;
    failed: number;
    inconclusive: number;
    items: Array<{
      reference: string;
      originalTestReference: string;
      status: CyberRetestStatus;
      outcome: CyberTestOutcome;
      reviewedAt: number | null;
      reviewDecision: "approved" | "rejected" | null;
    }>;
  };
  linkedVulnerabilities: {
    total: number;
    confirmed: number;
    open: number;
    items: Array<{
      reference: string | null;
      title: string;
      severity: CyberSeverity;
      status: CyberVulnerabilityStatus;
    }>;
  };
  severityDistribution: Record<CyberSeverity, number>;
  outstandingRemediation: {
    openVulnerabilities: number;
    outstandingActions: number;
  };
  verification: {
    verified: number;
    closed: number;
    riskAccepted: number;
    falsePositive: number;
  };
  evidence: {
    total: number;
    accessible: number;
    withheld: number;
    items: Array<{
      reference: string;
      filename: string;
      classification: string;
      accessible: boolean;
    }>;
  };
  limitations: {
    exclusions: string | null;
    notTestedCases: number;
    awaitingReviewRetests: number;
    openFindings: number;
    /**
     * Datasets whose aggregation scan hit its row cap. Their counts are lower
     * bounds, never exact totals, and the report says so rather than implying
     * comprehensive coverage.
     */
    truncatedDatasets: string[];
  };
};

function emptySeverityDistribution(): Record<CyberSeverity, number> {
  return {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    informational: 0,
  };
}

export function buildAssuranceReportContent(input: {
  assessment: AssuranceAssessmentInput;
  tests: ReportTestInput[];
  retests: ReportRetestInput[];
  vulnerabilities: ReportVulnerabilityInput[];
  actions: ReportActionInput[];
  evidence: ReportEvidenceInput[];
  generatedAt: number;
  /** Dataset names whose source scan reached its row cap. */
  truncatedDatasets?: string[];
}): AssuranceReportContent {
  const tests = {
    total: input.tests.length,
    planned: 0,
    inProgress: 0,
    completed: 0,
    notApplicable: 0,
    cancelled: 0,
    passed: 0,
    failed: 0,
    inconclusive: 0,
    notTested: 0,
    testedSystems: [] as string[],
  };
  const systems = new Set<string>();
  for (const row of input.tests) {
    if (row.status === "planned") tests.planned += 1;
    if (row.status === "in_progress") tests.inProgress += 1;
    if (row.status === "completed") tests.completed += 1;
    if (row.status === "not_applicable") tests.notApplicable += 1;
    if (row.status === "cancelled") tests.cancelled += 1;
    if (row.outcome === "pass") tests.passed += 1;
    if (row.outcome === "fail") tests.failed += 1;
    if (row.outcome === "inconclusive") tests.inconclusive += 1;
    if (row.outcome === "not_tested") tests.notTested += 1;
    if (row.status === "completed") systems.add(row.systemUnderTest);
  }
  tests.testedSystems = [...systems].sort();

  const retests = {
    total: input.retests.length,
    planned: 0,
    inProgress: 0,
    awaitingReview: 0,
    reviewed: 0,
    rejected: 0,
    passed: 0,
    failed: 0,
    inconclusive: 0,
    items: input.retests.map((row) => ({
      reference: row.reference,
      originalTestReference: row.originalTestReference,
      status: row.status,
      outcome: row.outcome,
      reviewedAt: row.reviewedAt,
      reviewDecision: row.reviewDecision,
    })),
  };
  for (const row of input.retests) {
    if (row.status === "planned") retests.planned += 1;
    if (row.status === "in_progress") retests.inProgress += 1;
    if (row.status === "completed") retests.awaitingReview += 1;
    if (row.status === "reviewed") retests.reviewed += 1;
    if (row.status === "rejected") retests.rejected += 1;
    if (row.outcome === "pass") retests.passed += 1;
    if (row.outcome === "fail") retests.failed += 1;
    if (row.outcome === "inconclusive") retests.inconclusive += 1;
  }

  const severityDistribution = emptySeverityDistribution();
  const linked = {
    total: input.vulnerabilities.length,
    confirmed: 0,
    open: 0,
    items: input.vulnerabilities.map((row) => ({
      reference: row.reference,
      title: row.title,
      severity: row.severity,
      status: row.status,
    })),
  };
  const verification = {
    verified: 0,
    closed: 0,
    riskAccepted: 0,
    falsePositive: 0,
  };
  for (const row of input.vulnerabilities) {
    severityDistribution[row.severity] += 1;
    if (isConfirmedVulnerabilityStatus(row.status)) linked.confirmed += 1;
    if (isOpenVulnerabilityStatus(row.status)) linked.open += 1;
    if (row.status === "verified") verification.verified += 1;
    if (row.status === "closed") verification.closed += 1;
    if (row.status === "risk_accepted") verification.riskAccepted += 1;
    if (row.status === "false_positive") verification.falsePositive += 1;
  }

  const outstandingActions = input.actions.filter(
    (row) => row.status !== "closed" && row.status !== "cancelled",
  ).length;

  const evidenceItems = input.evidence.map((row) => ({
    reference: row.reference,
    filename: row.filename,
    classification: row.classification,
    accessible: row.accessible,
  }));
  const accessible = evidenceItems.filter((row) => row.accessible).length;

  return {
    generatedAt: input.generatedAt,
    assessment: input.assessment,
    tests,
    retests,
    linkedVulnerabilities: linked,
    severityDistribution,
    outstandingRemediation: {
      openVulnerabilities: linked.open,
      outstandingActions,
    },
    verification,
    evidence: {
      total: evidenceItems.length,
      accessible,
      withheld: evidenceItems.length - accessible,
      items: evidenceItems,
    },
    limitations: {
      exclusions: input.assessment.exclusions,
      notTestedCases: tests.notTested + tests.notApplicable + tests.cancelled,
      awaitingReviewRetests:
        retests.awaitingReview + retests.planned + retests.inProgress,
      openFindings: linked.open,
      truncatedDatasets: [...(input.truncatedDatasets ?? [])].sort(),
    },
  };
}

/**
 * Evidence classifications that a viewer without restricted clearance may
 * still see. Restricted evidence is withheld from the record entirely.
 */
const VIEWER_VISIBLE_CLASSIFICATIONS = new Set([
  "public",
  "internal",
  "confidential",
]);

/**
 * Re-apply the requesting viewer's evidence permissions to stored report
 * content. A frozen snapshot records the classifications as they were captured,
 * but the `accessible` flag belongs to whoever captured it; recomputing it per
 * viewer means a finalized report (and its export) never hands restricted
 * evidence references to someone without that classification.
 */
export function redactReportContentForViewer(
  content: AssuranceReportContent,
  canReadRestricted: boolean,
): AssuranceReportContent {
  const items = content.evidence.items.map((item) => ({
    ...item,
    accessible:
      canReadRestricted || VIEWER_VISIBLE_CLASSIFICATIONS.has(item.classification),
  }));
  const accessible = items.filter((item) => item.accessible).length;
  return {
    ...content,
    evidence: {
      total: items.length,
      accessible,
      withheld: items.length - accessible,
      items,
    },
  };
}

/**
 * A retest only ever counts as verified once it has been independently
 * reviewed and approved; a recorded pass on its own is a claim.
 */
export function isRetestVerified(status: CyberRetestStatus): boolean {
  return status === "reviewed";
}

/**
 * Stable fingerprint of the report content that a reviewer approved. The
 * `generatedAt` timestamp is deliberately excluded: the fingerprint answers
 * "did the recorded data change?", not "was it rendered a second later?".
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

export function reportContentFingerprint(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const comparable = { ...(content as Record<string, unknown>) };
  delete comparable.generatedAt;
  // Canonical (key-sorted) serialisation: Convex does not promise object key
  // order, and the stored approval must compare equal to a fresh computation.
  return stableStringify(comparable);
}
