import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CYBER_ACTION_TRANSITIONS,
  CYBER_ASSESSMENT_TRANSITIONS,
  CYBER_VULNERABILITY_TRANSITIONS,
  canTransitionAction,
  canTransitionAssessment,
  canTransitionVulnerability,
  isOpenVulnerabilityStatus,
  isOutstandingAction,
  mayReadRestrictedCyberEvidence,
  validateCveId,
  validateCvssScore,
  validateCvssVector,
} from "../src/lib/cyber";

/**
 * Cybersecurity Assurance — structural and vocabulary guarantees.
 * ==============================================================
 * These tests do not need a running backend: they assert the invariants that
 * the server code relies on, and prove that the source keeps them (no bypass
 * arguments, no automatic completion, no second risk model, no dev shortcut).
 */

const root = process.cwd();
function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("cybersecurity lifecycle vocabulary", () => {
  test("assessment lifecycle never jumps from planned straight to completed", () => {
    expect(canTransitionAssessment("scheduled", "in_progress")).toBe(true);
    expect(canTransitionAssessment("scheduled", "completed")).toBe(false);
    expect(canTransitionAssessment("in_progress", "completed")).toBe(true);
    expect(canTransitionAssessment("completed", "in_progress")).toBe(false);
    expect(canTransitionAssessment("cancelled", "scheduled")).toBe(false);
    for (const [from, targets] of Object.entries(CYBER_ASSESSMENT_TRANSITIONS)) {
      expect(from.length).toBeGreaterThan(0);
      expect(Array.isArray(targets)).toBe(true);
    }
  });

  test("vulnerability closure requires verification, acceptance or false positive", () => {
    expect(canTransitionVulnerability("open", "confirmed")).toBe(true);
    expect(canTransitionVulnerability("open", "closed")).toBe(false);
    expect(canTransitionVulnerability("confirmed", "remediated")).toBe(true);
    expect(canTransitionVulnerability("in_remediation", "verified")).toBe(false);
    expect(canTransitionVulnerability("remediated", "verified")).toBe(true);
    // Failed verification returns work to remediation.
    expect(canTransitionVulnerability("remediated", "in_remediation")).toBe(true);
    expect(canTransitionVulnerability("verified", "closed")).toBe(true);
    expect(canTransitionVulnerability("risk_accepted", "closed")).toBe(true);
    expect(canTransitionVulnerability("false_positive", "closed")).toBe(true);
    expect(canTransitionVulnerability("closed", "open")).toBe(true);
    for (const [from, targets] of Object.entries(CYBER_VULNERABILITY_TRANSITIONS)) {
      expect(targets.length).toBeGreaterThanOrEqual(0);
      expect(from.length).toBeGreaterThan(0);
    }
  });

  test("actions cannot be verified from open or closed twice", () => {
    expect(canTransitionAction("open", "completed")).toBe(true);
    expect(canTransitionAction("open", "verified")).toBe(false);
    expect(canTransitionAction("in_progress", "completed")).toBe(true);
    expect(canTransitionAction("completed", "verified")).toBe(true);
    expect(canTransitionAction("verified", "closed")).toBe(true);
    expect(canTransitionAction("closed", "verified")).toBe(false);
    expect(canTransitionAction("cancelled", "closed")).toBe(false);
    expect(Object.keys(CYBER_ACTION_TRANSITIONS).length).toBe(6);
  });

  test("open/outstanding helpers classify work honestly", () => {
    expect(isOpenVulnerabilityStatus("remediated")).toBe(true);
    expect(isOpenVulnerabilityStatus("verified")).toBe(false);
    expect(isOpenVulnerabilityStatus("closed")).toBe(false);
    expect(isOutstandingAction("completed")).toBe(false);
    expect(isOutstandingAction("in_progress")).toBe(true);
    expect(mayReadRestrictedCyberEvidence(false)).toBe(false);
    expect(mayReadRestrictedCyberEvidence(true)).toBe(true);
  });
});

describe("CVSS validation is independent of severity", () => {
  test("accepts real base scores and rejects invalid ones", () => {
    expect(validateCvssScore(undefined)).toBeUndefined();
    expect(validateCvssScore(0)).toBe(0);
    expect(validateCvssScore(10)).toBe(10);
    expect(validateCvssScore(7.5)).toBe(7.5);
    expect(validateCvssScore(9.8)).toBe(9.8);
    expect(() => validateCvssScore(-0.1)).toThrow();
    expect(() => validateCvssScore(10.1)).toThrow();
    expect(() => validateCvssScore(Number.NaN)).toThrow();
    expect(() => validateCvssScore(7.55)).toThrow(/one decimal/);
    expect(() => validateCvssScore(6.666)).toThrow(/one decimal/);
  });

  test("validates vector shape without computing a score", () => {
    expect(validateCvssVector(undefined)).toBeUndefined();
    expect(validateCvssVector("")).toBeUndefined();
    expect(
      validateCvssVector("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"),
    ).toBe("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H");
    expect(() => validateCvssVector("AV:N/AC:L")).toThrow(/CVSS v3/);
    expect(() => validateCvssVector("CVSS:3.1/")).toThrow(/CVSS v3/);
  });

  test("validates CVE identifiers", () => {
    expect(validateCveId(undefined)).toBeUndefined();
    expect(validateCveId("cve-2026-12345")).toBe("CVE-2026-12345");
    expect(() => validateCveId("CVE-26-1")).toThrow();
  });

  test("severity vocabulary contains no numeric score mapping", () => {
    const lib = read("src/lib/cyber.ts");
    // No severity → score table and no score → severity inference.
    expect(lib).not.toMatch(/severityToCvss|CvssFromSeverity|cvssForSeverity/i);
    expect(lib).toMatch(/export function validateCvssScore/);
  });
});

describe("cybersecurity backend security invariants", () => {
  const core = read("src/convex/cyberCore.ts");
  const assessments = read("src/convex/cyberAssessments.ts");
  const vulnerabilities = read("src/convex/cyberVulnerabilities.ts");
  const actions = read("src/convex/cyberActions.ts");
  const evidence = read("src/convex/cyberEvidence.ts");
  const schema = read("src/convex/schema.ts");
  const main = read("src/main.tsx");

  test("reads require cyber.view and writes require cyber.manage + active membership", () => {
    expect(core).toContain('requirePermission(ctx, "cyber.view")');
    expect(core).toContain('requirePermission(ctx, "cyber.manage")');
    expect(core).toContain("access.isProvisioned");
    // Every module obtains authority through the shared helpers.
    for (const source of [assessments, vulnerabilities, actions, evidence]) {
      expect(source).toMatch(/requireCyberManager|resolveCyberAccess/);
    }
  });

  test("no cyber function accepts a client-supplied organization or role", () => {
    for (const source of [assessments, vulnerabilities, actions, evidence]) {
      expect(source).not.toMatch(/organizationId:\s*v\.id\("organizations"\)/);
      expect(source).not.toMatch(/role:\s*v\./);
      expect(source).not.toMatch(/permission:\s*v\./);
    }
  });

  test("every tenant read/write is scoped by the access-context organization", () => {
    for (const source of [assessments, vulnerabilities, actions, evidence]) {
      // Every insert names the resolved organization, never a client argument.
      expect(source).toMatch(/organizationId: (access|manager)\.organizationId/);
    }
    expect(core).toContain("assessment.organizationId !== organizationId");
    expect(core).toContain("vulnerability.organizationId !== organizationId");
  });

  test("assessments are never completed automatically and create no findings", () => {
    expect(assessments).toContain("assertAssessmentTransition");
    expect(assessments).not.toMatch(/insert\("vulnerabilities"/);
    expect(assessments).not.toMatch(/insert\("complianceFindings"/);
    // Derived counts, never stored counters.
    expect(assessments).not.toMatch(/criticalFindings:/);
    expect(schema).toMatch(/criticalFindings: v\.optional\(v\.number\(\)\)/);
  });

  test("independent verification is enforced server-side", () => {
    expect(vulnerabilities).toMatch(
      /remediatedByUserId === manager\.userId/,
    );
    expect(actions).toMatch(/completedByUserId === manager\.userId/);
    expect(vulnerabilities).toContain("Independent verification required");
    expect(actions).toContain("implementer cannot verify their own action");
  });

  test("closure cannot bypass outstanding remediation actions", () => {
    expect(vulnerabilities).toMatch(/Cannot close while remediation actions are unresolved/);
    expect(vulnerabilities).toMatch(/action\.status === "completed"/);
  });

  test("no second risk-scoring model and risk rows are never patched", () => {
    for (const source of [assessments, vulnerabilities, actions]) {
      expect(source).not.toMatch(/insert\("riskAssessments"/);
      expect(source).not.toMatch(/patch\(\s*risk/i);
      expect(source).not.toMatch(/residualScore|inherentLikelihood/);
    }
    expect(vulnerabilities).toContain("risk scores unchanged");
  });

  test("evidence hashing is server-side and downloads are audited", () => {
    expect(evidence).toContain("crypto.subtle.digest(\"SHA-256\"");
    expect(evidence).toContain("internalMutation");
    expect(evidence).toContain("cyber.evidence_downloaded");
    expect(evidence).toContain("Restricted evidence requires cyber.manage");
  });

  test("no development authentication shortcut in the cyber modules", () => {
    for (const source of [core, assessments, vulnerabilities, actions, evidence]) {
      expect(source).not.toContain("IITAMS_ALLOW_GUEST_AUTH");
      expect(source).not.toContain("devOtp");
      expect(source).not.toContain("VLY_OTP_API_KEY");
    }
  });

  test("routes replace the placeholders with dedicated pages", () => {
    expect(main).toContain("CyberAssessmentsPage");
    expect(main).toContain("CyberVulnerabilitiesPage");
    expect(main).toContain('path="/cyber/assessments"');
    expect(main).toContain('path="/cyber/vulnerabilities"');
    // The placeholder registry must no longer claim these two routes.
    const moduleRoutes = main.slice(
      main.indexOf("const MODULE_ROUTES"),
      main.indexOf("createRoot"),
    );
    expect(moduleRoutes).not.toContain('"/cyber/assessments"');
    expect(moduleRoutes).not.toContain('"/cyber/vulnerabilities"');
  });
});
