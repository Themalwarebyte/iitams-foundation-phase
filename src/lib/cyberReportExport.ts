import type { AssuranceReportContent } from "./cyberReport";

/**
 * Cybersecurity report export (Phase 4A — Batch 3)
 * =================================================
 * Reuses the existing Audit Reports export mechanism (a self-contained HTML
 * document printed to PDF, plus an HTML-based Word `.doc`) rather than adding a
 * second reporting engine or a bundled PDF library.
 *
 * Both builders are pure functions over the report row and its content, which
 * is the FROZEN SNAPSHOT for a finalized report. Nothing here recomputes data
 * and nothing here invents a finding, conclusion or score.
 */

export type ExportReportMeta = {
  reference: string;
  title: string;
  status: string;
  statusLabel: string;
  version: number;
  frozen: boolean;
  preparedByLabel: string;
  preparedAt: number;
  submittedByLabel: string | null;
  submittedAt: number | null;
  reviewedByLabel: string | null;
  reviewedAt: number | null;
  reviewDecision: string | null;
  reviewNotes: string | null;
  finalizedByLabel: string | null;
  finalizedAt: number | null;
  supersededByReportId: string | null;
  conclusions: string;
  recommendations: string;
  limitations: string;
  untestedScope: string;
};

export type ReportExportInput = {
  report: ExportReportMeta;
  content: AssuranceReportContent;
  organizationName?: string | null;
  generatedBy: string;
  generatedAt: number;
};

function escapeHtml(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().slice(0, 10);
}

function formatDateTime(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

function row(label: string, value: string): string {
  return `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`;
}

function section(title: string, body: string): string {
  return `<h2>${escapeHtml(title)}</h2>${body}`;
}

/** The report body shared by the PDF (print) and Word exports. */
export function buildCyberReportBody(input: ReportExportInput): string {
  const { report, content } = input;
  const statusBanner = report.frozen
    ? `<p class="banner">FINALIZED — the content below is the frozen snapshot captured at finalization${
        report.version > 1 ? ` (version ${report.version})` : ""
      }.</p>`
    : `<p class="banner draft">DRAFT / NOT FINALIZED — this export is not an approved report and must not be relied on as one.</p>`;

  const tests = content.tests;
  const retests = content.retests;
  const vulns = content.linkedVulnerabilities;

  const evidenceRows = content.evidence.items
    .filter((item) => item.accessible)
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.filename)}</td><td>${escapeHtml(
          item.classification,
        )}</td></tr>`,
    )
    .join("");

  return `
<h1>${escapeHtml(report.title)}</h1>
<p class="meta">${escapeHtml(report.reference)} · version ${report.version} · ${escapeHtml(
    report.statusLabel,
  )}${input.organizationName ? ` · ${escapeHtml(input.organizationName)}` : ""}</p>
${statusBanner}
<table>
${row("Assessment", `${escapeHtml(content.assessment.name)} (${escapeHtml(content.assessment.reference ?? "no reference")})`)}
${row("Assessment type", escapeHtml(content.assessment.typeLabel))}
${row("Assessment status", escapeHtml(content.assessment.status))}
${row("Prepared by", `${escapeHtml(report.preparedByLabel)} · ${formatDateTime(report.preparedAt)}`)}
${row("Submitted by", `${escapeHtml(report.submittedByLabel ?? "—")} · ${formatDateTime(report.submittedAt)}`)}
${row("Independent reviewer", `${escapeHtml(report.reviewedByLabel ?? "Not reviewed")}${report.reviewDecision ? ` · ${escapeHtml(report.reviewDecision)}` : ""} · ${formatDateTime(report.reviewedAt)}`)}
${row("Finalized by", `${escapeHtml(report.finalizedByLabel ?? "—")} · ${formatDateTime(report.finalizedAt)}`)}
${row("Superseded by", escapeHtml(report.supersededByReportId ?? "—"))}
${row("Exported by", `${escapeHtml(input.generatedBy)} · ${formatDateTime(input.generatedAt)}`)}
</table>

${section(
  "Scope and methodology",
  `<table>
${row("In-scope systems", escapeHtml(content.assessment.systemsInScope ?? "Not recorded"))}
${row("Exclusions", escapeHtml(content.assessment.exclusions ?? "Not recorded"))}
${row("Methodology", escapeHtml(content.assessment.methodology ?? "Not recorded"))}
${row("Authorization reference", escapeHtml(content.assessment.authorizationReference ?? "Not recorded"))}
${row("Testing period", `${formatDate(content.assessment.authorizedStartAt)} → ${formatDate(content.assessment.authorizedEndAt)}`)}
${row("Lead tester", escapeHtml(content.assessment.leadTesterLabel ?? "Not recorded"))}
${row("Systems tested", escapeHtml(content.tests.testedSystems.join(", ") || "None recorded as completed"))}
</table>`,
)}

${section(
  "Recorded testing",
  `<table>
${row("Total test cases", String(tests.total))}
${row("Completed", String(tests.completed))}
${row("Passed", String(tests.passed))}
${row("Failed", String(tests.failed))}
${row("Inconclusive", String(tests.inconclusive))}
${row("Not tested", String(tests.notTested))}
${row("Not applicable", String(tests.notApplicable))}
${row("Cancelled", String(tests.cancelled))}
${row("Outstanding (planned / in progress)", String(tests.planned + tests.inProgress))}
</table>
<p class="note">These are counts of recorded test results. A pass rate is not a measure of organizational security effectiveness and no security score is derived here.</p>`,
)}

${section(
  "Retesting and independent verification",
  `<table>
${row("Total retests", String(retests.total))}
${row("Awaiting independent review", String(retests.awaitingReview))}
${row("Independently reviewed", String(retests.reviewed))}
${row("Rejected — further remediation required", String(retests.rejected))}
</table>
${
  retests.items.length > 0
    ? `<table><tr><th>Retest</th><th>Original test</th><th>Status</th><th>Outcome</th><th>Review</th></tr>${retests.items
        .map(
          (item) =>
            `<tr><td>${escapeHtml(item.reference)}</td><td>${escapeHtml(
              item.originalTestReference,
            )}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(
              item.outcome,
            )}</td><td>${escapeHtml(item.reviewDecision ?? "not reviewed")}</td></tr>`,
        )
        .join("")}</table>`
    : `<p class="note">No retest has been recorded for this assessment.</p>`
}`,
)}

${section(
  "Linked vulnerabilities and verification",
  `<table>
${row("Recorded vulnerabilities", String(vulns.total))}
${row("Confirmed", String(vulns.confirmed))}
${row("Open", String(vulns.open))}
${row("Critical / high / medium / low / informational", `${content.severityDistribution.critical} / ${content.severityDistribution.high} / ${content.severityDistribution.medium} / ${content.severityDistribution.low} / ${content.severityDistribution.informational}`)}
${row("Verified", String(content.verification.verified))}
${row("Closed", String(content.verification.closed))}
${row("Risk accepted", String(content.verification.riskAccepted))}
${row("False positive", String(content.verification.falsePositive))}
${row("Outstanding remediation actions", String(content.outstandingRemediation.outstandingActions))}
</table>`,
)}

${section(
  "Evidence",
  `<p>${content.evidence.accessible} accessible evidence record(s).${
    content.evidence.withheld > 0
      ? ` ${content.evidence.withheld} record(s) withheld because the exporting user's permissions do not permit this classification.`
      : ""
  }</p>
${evidenceRows ? `<table><tr><th>File</th><th>Classification</th></tr>${evidenceRows}</table>` : `<p class="note">No accessible evidence is recorded.</p>`}`,
)}

${section(
  "Limitations and untested scope",
  `<p>${escapeHtml(report.limitations)}</p>
<p>${escapeHtml(report.untestedScope)}</p>
<p class="note">${content.limitations.notTestedCases} case(s) not tested, not applicable or cancelled; ${content.limitations.awaitingReviewRetests} retest(s) awaiting independent review.</p>
${
  content.limitations.truncatedDatasets.length > 0
    ? `<p class="banner draft">AGGREGATION CAP REACHED — ${escapeHtml(
        content.limitations.truncatedDatasets.join(", "),
      )}. Counts for those datasets are lower bounds, not exact totals; this report does not claim comprehensive coverage.</p>`
    : ""
}`,
)}

${section("Conclusions", `<p>${escapeHtml(report.conclusions)}</p>`)}
${section("Recommendations", `<p>${escapeHtml(report.recommendations)}</p>`)}
${
  report.reviewNotes
    ? section(
        "Independent review notes",
        `<p>${escapeHtml(report.reviewNotes)}</p>`,
      )
    : ""
}
`;
}

const PRINT_STYLE = `
  body { font-family: Georgia, 'Times New Roman', serif; margin: 40px auto; max-width: 820px; color: #111; }
  h1 { font-size: 20px; border-bottom: 2px solid #005a9a; padding-bottom: 8px; }
  h2 { font-size: 15px; margin-top: 24px; color: #005a9a; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12px; }
  th, td { border: 1px solid #bbb; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f0f4f8; width: 34%; }
  .meta { color: #555; font-size: 12px; }
  .note { color: #555; font-size: 12px; font-style: italic; }
  .banner { border: 1px solid #005a9a; background: #eef4fa; padding: 8px 10px; font-size: 12px; }
  .banner.draft { border-color: #a15c00; background: #fdf3e3; }
`;

/** Self-contained printable HTML (the PDF path of the Audit Reports export). */
export function buildCyberReportHtml(input: ReportExportInput): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(
    input.report.reference,
  )}</title><style>${PRINT_STYLE}</style></head><body>${buildCyberReportBody(
    input,
  )}
<script>window.addEventListener('load', () => { setTimeout(() => window.print(), 300); });</script>
</body></html>`;
}

/** Word-compatible HTML document (the Word path of the Audit Reports export). */
export function buildCyberReportWordHtml(input: ReportExportInput): string {
  return `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'><title>${escapeHtml(
    input.report.reference,
  )}</title><style>${PRINT_STYLE}</style></head><body>${buildCyberReportBody(
    input,
  )}</body></html>`;
}

/** Export filename: reference, version and lifecycle state are in the name. */
export function reportExportFilename(
  report: Pick<ExportReportMeta, "reference" | "title" | "version" | "frozen">,
  extension: "html" | "doc",
): string {
  const slug = report.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  const state = report.frozen ? "finalized" : "draft";
  return `${report.reference}-v${report.version}-${state}-${slug || "report"}.${extension}`;
}
