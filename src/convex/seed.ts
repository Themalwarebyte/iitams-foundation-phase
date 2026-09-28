import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { getCurrentUserOrNull, guestAuthEnabled } from "./access";

/**
 * Demo environment seed. Creates a clearly-flagged demo organization with
 * representative data so the dashboard and charts are meaningful in a fresh
 * deployment. Real deployments simply do not call this; production data is
 * never fabricated here. Safe to call repeatedly — it no-ops when a
 * "IITAMS Demo MDAC" organization already exists.
 */
export const seedDemoData = mutation({
  args: {},
  handler: async (ctx) => {
    // Demo seeding is a development convenience: refuse on production
    // deployments (guest auth disabled) and for anonymous callers.
    const actor = await getCurrentUserOrNull(ctx);
    if (!guestAuthEnabled() || actor?.isAnonymous === true) {
      throw new Error(
        "Demo seeding is only available on development deployments",
      );
    }

    const existing = await ctx.db
      .query("organizations")
      .withIndex("code", (q) => q.eq("code", "IITAMS-DEMO"))
      .unique();
    if (existing) return { seeded: false, organizationId: existing._id };

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    const orgId = await ctx.db.insert("organizations", {
      name: "IITAMS Demo MDAC",
      code: "IITAMS-DEMO",
      type: "ministry",
      description:
        "Demonstration organization with synthetic data. Clearly flagged as demo — not production statistics.",
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    });

    const demo = <T extends object>(row: T) => ({ ...row, isDemo: true });

    // --- Audit universe & engagements --------------------------------
    const universe = [
      { code: "AU-001", name: "Core Banking Platform", domain: "Applications", inherentRisk: "critical" },
      { code: "AU-002", name: "National Data Centre", domain: "Infrastructure", inherentRisk: "high" },
      { code: "AU-003", name: "GovPay Payment Gateway", domain: "Applications", inherentRisk: "high" },
      { code: "AU-004", name: "Identity & Access Management", domain: "Security", inherentRisk: "critical" },
      { code: "AU-005", name: "HR Management System", domain: "Applications", inherentRisk: "medium" },
      { code: "AU-006", name: "Wide Area Network (NOFBI)", domain: "Network", inherentRisk: "high" },
    ] as const;
    for (const u of universe) {
      await ctx.db.insert("auditUniverseItems", demo({
        organizationId: orgId,
        code: u.code,
        name: u.name,
        domain: u.domain,
        inherentRisk: u.inherentRisk,
        lastAuditedAt: now - 300 * DAY,
        nextAuditDue: now + 90 * DAY,
        createdAt: now,
        updatedAt: now,
      }));
    }

    const engagements = [
      { code: "ENG-2025-014", name: "Core Banking Platform IT Audit", status: "fieldwork", progress: 62, end: 45 },
      { code: "ENG-2025-015", name: "Data Centre Physical & Environmental Review", status: "in_progress", progress: 38, end: 80 },
      { code: "ENG-2025-016", name: "GovPay Application Security Review", status: "reporting", progress: 85, end: 20 },
      { code: "ENG-2025-017", name: "IAM Access Recertification Audit", status: "planned", progress: 5, end: 120 },
      { code: "ENG-2025-013", name: "Network Operations Centre Audit", status: "completed", progress: 100, end: -30 },
    ] as const;
    for (const e of engagements) {
      await ctx.db.insert("auditEngagements", demo({
        organizationId: orgId,
        code: e.code,
        name: e.name,
        status: e.status,
        progressPct: e.progress,
        startDate: now - 60 * DAY,
        targetEndDate: now + e.end * DAY,
        createdAt: now,
        updatedAt: now,
      }));
    }

    await ctx.db.insert("auditPlans", demo({
      organizationId: orgId,
      name: "FY 2025/26 Risk-Based ICT Audit Plan",
      fiscalYear: "2025/26",
      status: "in_execution",
      totalEngagements: 12,
      completedEngagements: 4,
      createdAt: now,
      updatedAt: now,
    }));

    // --- Findings & corrective actions --------------------------------
    const findings = [
      { code: "F-101", title: "Privileged accounts without MFA", severity: "critical", status: "open", due: 30 },
      { code: "F-102", title: "Unpatched middleware in DMZ", severity: "high", status: "in_remediation", due: 21 },
      { code: "F-103", title: "Backup restoration not tested for 12 months", severity: "high", status: "open", due: 60 },
      { code: "F-104", title: "Excessive shared service accounts", severity: "medium", status: "in_remediation", due: 90 },
      { code: "F-105", title: "Incomplete asset register", severity: "medium", status: "open", due: 120 },
      { code: "F-106", title: "Log retention below policy minimum", severity: "low", status: "resolved", due: -10 },
      { code: "F-107", title: "Outdated acceptable-use policy", severity: "informational", status: "open", due: 150 },
    ] as const;
    const findingIds: (string | undefined)[] = [];
    for (const f of findings) {
      const id = await ctx.db.insert("findings", demo({
        organizationId: orgId,
        code: f.code,
        title: f.title,
        severity: f.severity,
        status: f.status,
        ownerName: "ICT Directorate",
        dueDate: now + f.due * DAY,
        isOverdue: f.due < 0 && f.status !== "resolved",
        createdAt: now,
        updatedAt: now,
      }));
      findingIds.push(id);
    }

    const actions = [
      { title: "Deploy MFA for all privileged accounts", status: "in_progress", due: 25, finding: 0 },
      { title: "Patch middleware cluster to vendor-supported release", status: "not_started", due: 18, finding: 1 },
      { title: "Schedule and document full backup restore test", status: "in_progress", due: 55, finding: 2 },
      { title: "Eliminate shared accounts via named accounts", status: "implemented", due: -5, finding: 3 },
      { title: "Rebuild asset register from CMDB export", status: "not_started", due: 110, finding: 4 },
    ] as const;
    for (const a of actions) {
      await ctx.db.insert("correctiveActions", demo({
        organizationId: orgId,
        findingId: findingIds[a.finding] as never,
        title: a.title,
        status: a.status,
        ownerName: "ICT Operations",
        dueDate: now + a.due * DAY,
        createdAt: now,
        updatedAt: now,
      }));
    }

    // --- ICT Risk register ---------------------------------------------
    const risks = [
      { code: "R-001", title: "Ransomware on core banking segment", category: "Cyber", il: 4, ii: 5, rl: 3, ri: 5, status: "mitigating" },
      { code: "R-002", title: "Single data centre dependency", category: "Infrastructure", il: 3, ii: 5, rl: 2, ri: 5, status: "open" },
      { code: "R-003", title: "Third-party payment processor breach", category: "Third-party", il: 3, ii: 4, rl: 2, ri: 4, status: "assessing" },
      { code: "R-004", title: "Insider data exfiltration", category: "People", il: 3, ii: 4, rl: 2, ri: 3, status: "mitigating" },
      { code: "R-005", title: "Legacy OS end-of-support", category: "Infrastructure", il: 4, ii: 3, rl: 3, ri: 2, status: "treated" },
      { code: "R-006", title: "DDoS on citizen services portal", category: "Cyber", il: 4, ii: 4, rl: 3, ri: 3, status: "open" },
      { code: "R-007", title: "Data centre power instability", category: "Infrastructure", il: 3, ii: 4, rl: 2, ri: 3, status: "accepted" },
      { code: "R-008", title: "Skill shortage in security operations", category: "People", il: 4, ii: 2, rl: 3, ri: 2, status: "open" },
    ] as const;
    for (const r of risks) {
      await ctx.db.insert("risks", demo({
        organizationId: orgId,
        code: r.code,
        title: r.title,
        category: r.category,
        inherentLikelihood: r.il,
        inherentImpact: r.ii,
        residualLikelihood: r.rl,
        residualImpact: r.ri,
        status: r.status,
        ownerName: "Risk Committee",
        reviewDue: now + 60 * DAY,
        createdAt: now,
        updatedAt: now,
      }));
    }

    // Risk trend snapshots (8 quarters of synthetic history)
    const trendData = [
      { label: "2024-Q1", open: 24, crit: 7, avg: 12.4 },
      { label: "2024-Q2", open: 22, crit: 6, avg: 11.8 },
      { label: "2024-Q3", open: 25, crit: 8, avg: 12.9 },
      { label: "2024-Q4", open: 20, crit: 5, avg: 10.6 },
      { label: "2025-Q1", open: 18, crit: 4, avg: 9.9 },
      { label: "2025-Q2", open: 16, crit: 4, avg: 9.2 },
      { label: "2025-Q3", open: 15, crit: 3, avg: 8.8 },
    ] as const;
    for (let i = 0; i < trendData.length; i++) {
      const t = trendData[i];
      await ctx.db.insert("riskTrendSnapshots", demo({
        organizationId: orgId,
        periodLabel: t.label,
        periodStart: now - (trendData.length - 1 - i) * 90 * DAY,
        openRisks: t.open,
        criticalHighRisks: t.crit,
        avgResidualScore: t.avg,
        createdAt: now,
        updatedAt: now,
      }));
    }

    // --- Compliance -----------------------------------------------------
    const frameworks = [
      { name: "ISO/IEC 27001:2022", code: "27001", total: 93, implemented: 71, score: 76 },
      { name: "NIST Cybersecurity Framework 2.0", code: "NIST-CSF", total: 106, implemented: 82, score: 77 },
      { name: "Data Protection Act 2019 (Kenya)", code: "DPA-2019", total: 42, implemented: 33, score: 79 },
      { name: "PCI DSS v4.0", code: "PCI", total: 264, implemented: 178, score: 67 },
    ] as const;
    for (const f of frameworks) {
      await ctx.db.insert("complianceFrameworks", demo({
        organizationId: orgId,
        name: f.name,
        code: f.code,
        totalControls: f.total,
        implementedControls: f.implemented,
        complianceScorePct: f.score,
        createdAt: now,
        updatedAt: now,
      }));
    }

    const controlEffectiveness = ["effective", "partially_effective", "ineffective", "not_tested"] as const;
    const controlCounts = [38, 14, 6, 35];
    for (let i = 0; i < controlEffectiveness.length; i++) {
      for (let n = 0; n < controlCounts[i]; n++) {
        await ctx.db.insert("controls", demo({
          organizationId: orgId,
          code: `CTL-${String(i * 100 + n + 1).padStart(4, "0")}`,
          name: `Control family item ${i * 100 + n + 1}`,
          effectiveness: controlEffectiveness[i],
          lastTestedAt: now - (i + 1) * 20 * DAY,
          createdAt: now,
          updatedAt: now,
        }));
      }
    }

    // --- Vulnerabilities --------------------------------------------------
    const vulns = [
      { cve: "CVE-2025-21415", asset: "dmz-mw-01", title: "RCE in middleware", severity: "critical", cvss: 9.8, status: "confirmed", ageDays: 12 },
      { cve: "CVE-2024-48887", asset: "gwp-app-02", title: "SQL injection in payments API", severity: "critical", cvss: 9.1, status: "open", ageDays: 41 },
      { cve: "CVE-2025-1097", asset: "lb-edge-01", title: "TLS downgrade in load balancer", severity: "high", cvss: 8.2, status: "open", ageDays: 27 },
      { cve: "CVE-2024-3400", asset: "fw-perim-01", title: "Arbitrary file read in firewall", severity: "high", cvss: 8.9, status: "remediated", ageDays: 95 },
      { cve: undefined, asset: "hr-app-01", title: "Verbose error pages leak stack traces", severity: "medium", cvss: 5.3, status: "open", ageDays: 66 },
      { cve: undefined, asset: "ad-dc-01", title: "LDAP anonymous bind enabled", severity: "medium", cvss: 5.0, status: "confirmed", ageDays: 120 },
      { cve: undefined, asset: "mail-relay-01", title: "Open relay misconfiguration", severity: "low", cvss: 3.1, status: "open", ageDays: 200 },
      { cve: undefined, asset: "kiosk-portal", title: "Missing security headers", severity: "informational", cvss: 0, status: "open", ageDays: 15 },
    ] as const;
    for (const v of vulns) {
      await ctx.db.insert("vulnerabilities", demo({
        organizationId: orgId,
        cveId: v.cve,
        assetName: v.asset,
        title: v.title,
        severity: v.severity,
        cvssScore: v.cvss,
        status: v.status,
        discoveredAt: now - v.ageDays * DAY,
        remediationDue: now + (30 - v.ageDays) * DAY,
        createdAt: now,
        updatedAt: now,
      }));
    }

    const secAssessments = [
      { name: "External penetration test — perimeter", type: "penetration_test", status: "completed", crit: 1, high: 3, med: 5, low: 7 },
      { name: "Internal network segmentation assessment", type: "network_assessment", status: "in_progress", crit: 0, high: 2, med: 4, low: 6 },
      { name: "GovPay secure code review", type: "application_security", status: "scheduled", crit: 0, high: 0, med: 0, low: 0 },
      { name: "CIS benchmark review — Windows estate", type: "configuration_review", status: "completed", crit: 0, high: 1, med: 6, low: 9 },
    ] as const;
    for (const s of secAssessments) {
      await ctx.db.insert("securityAssessments", demo({
        organizationId: orgId,
        name: s.name,
        type: s.type,
        status: s.status,
        startedAt: now - 40 * DAY,
        completedAt: s.status === "completed" ? now - 10 * DAY : undefined,
        criticalFindings: s.crit,
        highFindings: s.high,
        mediumFindings: s.med,
        lowFindings: s.low,
        createdAt: now,
        updatedAt: now,
      }));
    }

    // --- BCM / DR ---------------------------------------------------------
    const services = [
      { name: "GovPay payment gateway", rto: 4, rpo: 1, curRto: 5, curRpo: 1, ready: 82 },
      { name: "Citizen services portal", rto: 8, rpo: 4, curRto: 8, curRpo: 4, ready: 74 },
      { name: "Core banking platform", rto: 2, rpo: 0.5, curRto: 3, curRpo: 1, ready: 68 },
      { name: "National identity verification", rto: 4, rpo: 2, curRto: 4, curRpo: 2, ready: 88 },
      { name: "Government email (GoKe Mail)", rto: 24, rpo: 8, curRto: 20, curRpo: 8, ready: 91 },
    ] as const;
    for (const s of services) {
      await ctx.db.insert("criticalServices", demo({
        organizationId: orgId,
        name: s.name,
        rtoHours: s.rto,
        rpoHours: s.rpo,
        currentRtoHours: s.curRto,
        currentRpoHours: s.curRpo,
        readinessScorePct: s.ready,
        createdAt: now,
        updatedAt: now,
      }));
    }

    const drTests = [
      { name: "Core banking failover drill", scope: "Data centre A → B", scheduled: now + 21 * DAY, status: "planned" },
      { name: "GovPay DR invocation test", scope: "Payment platform", scheduled: now - 45 * DAY, status: "completed" },
      { name: "Portal restoration tabletop", scope: "Citizen portal", scheduled: now - 90 * DAY, status: "completed" },
      { name: "Email continuity failover", scope: "Messaging platform", scheduled: now - 130 * DAY, status: "failed" },
    ] as const;
    for (const t of drTests) {
      await ctx.db.insert("drTests", demo({
        organizationId: orgId,
        name: t.name,
        scope: t.scope,
        scheduledFor: t.scheduled,
        status: t.status,
        createdAt: now,
        updatedAt: now,
      }));
    }

    // --- Notifications & audit log -------------------------------------
    const notifications = [
      { title: "ENG-2025-016 moved to reporting", body: "GovPay Application Security Review is ready for report issuance.", severity: "info", at: now - 2 * 60 * 60 * 1000 },
      { title: "2 corrective actions overdue", body: "Shared-account elimination and patching actions have passed due dates.", severity: "warning", at: now - 26 * 60 * 60 * 1000 },
      { title: "Critical vulnerability confirmed", body: "CVE-2025-21415 confirmed on dmz-mw-01 — remediation due in 18 days.", severity: "critical", at: now - 3 * DAY },
      { title: "Q3 risk review pack published", body: "Risk Committee papers are available in Reports.", severity: "success", at: now - 5 * DAY },
    ] as const;
    for (const n of notifications) {
      await ctx.db.insert("notifications", {
        organizationId: orgId,
        title: n.title,
        body: n.body,
        severity: n.severity,
        isDemo: true,
        createdAt: n.at,
      });
    }

    const logs = [
      { action: "engagement.status_changed", entity: "auditEngagements", summary: "GovPay Application Security Review → reporting" },
      { action: "finding.created", entity: "findings", summary: "F-101 Privileged accounts without MFA" },
      { action: "vulnerability.confirmed", entity: "vulnerabilities", summary: "CVE-2025-21415 on dmz-mw-01" },
      { action: "dr_test.scheduled", entity: "drTests", summary: "Core banking failover drill scheduled" },
      { action: "report.published", entity: "auditLogs", summary: "Q3 risk review pack published" },
    ] as const;
    for (let i = 0; i < logs.length; i++) {
      await ctx.db.insert("auditLogs", {
        organizationId: orgId,
        actorLabel: "Demo Administrator",
        action: logs[i].action,
        entityType: logs[i].entity,
        summary: logs[i].summary,
        createdAt: now - (i + 1) * 4 * 60 * 60 * 1000,
      });
    }

    const seeder = actor; // reuse the actor fetched by the guard above
    await ctx.db.insert("auditLogs", {
      organizationId: orgId,
      userId: seeder?._id,
      actorLabel: seeder?.name ?? seeder?.email ?? "Unknown",
      action: "system.seeded_demo_data",
      entityType: "organizations",
      entityId: orgId,
      summary: "Demo organization seeded with synthetic data",
      createdAt: now,
    });

    return { seeded: true, organizationId: orgId };
  },
});
