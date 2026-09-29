import { useState } from "react";
import { useQuery } from "convex/react";
import { toast } from "sonner";
import { ScrollText, Printer, FileDown, FileText } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SeverityBadge, StatusChip } from "@/components/iitams/badges";
import type { Severity } from "@/lib/severity";
import { ListPageShell, ListSkeleton, EmptyState } from "./ListPageShell";

/**
 * Module 10 — Reporting foundation. Assembles the engagement report,
 * findings report and executive audit summary server-side and renders them
 * for print-to-PDF and Word export (self-hosted: no external services).
 */

type ReportKind = "engagement" | "findings" | "executive";

const REPORT_KINDS: { value: ReportKind; label: string; description: string }[] = [
  {
    value: "engagement",
    label: "Engagement report",
    description: "Scope, objectives, team, procedures, findings and recommendations for one engagement.",
  },
  {
    value: "findings",
    label: "Findings report",
    description: "All findings with severity, owner, due dates and status.",
  },
  {
    value: "executive",
    label: "Executive audit summary",
    description: "Audit coverage, key risks, critical findings and outstanding actions with an overall opinion.",
  },
];

interface EngagementReportData {
  organization: { name: string; code: string } | null;
  engagement: {
    code: string;
    title: string;
    statusLabel: string;
    objective: string | null;
    scope: string | null;
    criteria: string | null;
    startDate: number | null;
    targetEndDate: number | null;
    progressPct: number;
    auditManager: string | null;
    planName: string | null;
    universeItemName: string | null;
  };
  team: { roleLabel: string; name: string }[];
  programs: {
    code: string;
    title: string;
    objective: string | null;
    procedures: {
      code: string;
      name: string;
      controlObjective: string | null;
      expectedEvidence: string | null;
      completionStatus: string;
      result: string | null;
    }[];
  }[];
  findings: {
    code: string;
    title: string;
    severity: string;
    status: string;
    recommendation: string | null;
    ownerName: string | null;
  }[];
}

interface FindingsReportData {
  organization: { name: string; code: string } | null;
  bySeverity: Record<string, number>;
  total: number;
  findings: {
    code: string;
    title: string;
    severity: string;
    status: string;
    ownerName: string | null;
    dueDate: number | null;
  }[];
}

interface ExecutiveSummaryData {
  organization: { name: string; code: string } | null;
  auditUniverse: { total: number; audited: number; coveragePct: number };
  engagements: { total: number; completed: number; active: number; delayed: number };
  findings: { open: number; critical: number; high: number };
  actions: { outstanding: number; overdue: number };
  opinion: string;
  criticalFindingsList: {
    code: string;
    title: string;
    ownerName: string | null;
    dueDate: number | null;
  }[];
}

function downloadHtml(filename: string, title: string, bodyHtml: string) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; margin: 40px auto; max-width: 800px; color: #111; }
  h1 { font-size: 20px; border-bottom: 2px solid #005a9a; padding-bottom: 8px; }
  h2 { font-size: 15px; margin-top: 24px; color: #005a9a; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12px; }
  th, td { border: 1px solid #bbb; padding: 6px 8px; text-align: left; }
  th { background: #f0f4f8; }
  .meta { color: #555; font-size: 12px; }
</style></head><body>${bodyHtml}
<script>window.addEventListener('load', () => { setTimeout(() => window.print(), 300); });</script>
</body></html>`;
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadWord(filename: string, title: string, bodyHtml: string) {
  const html = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'><title>${title}</title></head><body>${bodyHtml}</body></html>`;
  const blob = new Blob(["\ufeff", html], { type: "application/msword" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filename}.doc`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ReportsPage({ path }: { path: string }) {
  const [kind, setKind] = useState<ReportKind>("executive");
  const [engagementId, setEngagementId] = useState("");

  const engagements = useQuery(api.auditEngagements.list, {});
  const activeReport = useQuery(
    kind === "engagement"
      ? api.auditReports.engagementReport
      : kind === "findings"
        ? api.auditReports.findingsReport
        : api.auditReports.executiveSummary,
    kind === "engagement"
      ? engagementId
        ? { engagementId: engagementId as never }
        : "skip"
      : {},
  );

  const meta = REPORT_KINDS.find((r) => r.value === kind)!;

  return (
    <ListPageShell
      path={path}
      eyebrow="Audit Management"
      title="Audit Reports"
      description="Report generation foundation: engagement reports, findings reports and the executive audit summary, exportable to PDF (print) and Word."
    >
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-56">
          <Label>Report type</Label>
          <Select
            value={kind}
            onValueChange={(v) => setKind(v as ReportKind)}
          >
            <SelectTrigger className="mt-1.5 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REPORT_KINDS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-1 text-xs text-muted-foreground">{meta.description}</p>
        </div>
        {kind === "engagement" && (
          <div className="min-w-64">
            <Label>Engagement *</Label>
            <Select value={engagementId} onValueChange={setEngagementId}>
              <SelectTrigger className="mt-1.5 w-full">
                <SelectValue placeholder="Select engagement" />
              </SelectTrigger>
              <SelectContent>
                {(engagements ?? []).map((e) => (
                  <SelectItem key={e._id} value={e._id}>
                    {e.code} — {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="flex gap-2 sm:ml-auto">
          <Button
            variant="outline"
            disabled={!activeReport || (kind === "engagement" && !engagementId)}
            onClick={() => {
              const html = renderReportHtml(kind, activeReport);
              downloadHtml(
                `iitams-${kind}-report.html`,
                `IITAMS ${meta.label}`,
                html,
              );
              toast.info("Print dialog opens in the new tab — save as PDF.");
            }}
          >
            <Printer className="size-4" aria-hidden /> PDF
          </Button>
          <Button
            variant="outline"
            disabled={!activeReport || (kind === "engagement" && !engagementId)}
            onClick={() => {
              const html = renderReportHtml(kind, activeReport);
              downloadWord(
                `iitams-${kind}-report`,
                `IITAMS ${meta.label}`,
                html,
              );
              toast.success("Word document downloaded");
            }}
          >
            <FileDown className="size-4" aria-hidden /> Word
          </Button>
        </div>
      </div>

      {activeReport === undefined ? (
        kind === "engagement" && !engagementId ? (
          <EmptyState
            icon={ScrollText}
            title="Select an engagement"
            description="Choose an engagement to assemble its audit report."
          />
        ) : (
          <ListSkeleton rows={4} />
        )
      ) : (
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="size-4 text-primary" aria-hidden />
              {meta.label} — preview
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {kind === "executive" &&
              renderExecutive(activeReport as unknown as ExecutiveSummaryData)}
            {kind === "findings" &&
              renderFindings(activeReport as unknown as FindingsReportData)}
            {kind === "engagement" &&
              renderEngagement(activeReport as unknown as EngagementReportData)}
          </CardContent>
        </Card>
      )}
    </ListPageShell>
  );
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderEngagement(d: EngagementReportData) {
  return (
    <>
      <PreviewRow label="Engagement" value={`${d.engagement.code} — ${d.engagement.title}`} />
      <PreviewRow label="Status" value={d.engagement.statusLabel} />
      <PreviewRow label="Objective" value={d.engagement.objective} />
      <PreviewRow label="Scope" value={d.engagement.scope} />
      <PreviewRow label="Criteria" value={d.engagement.criteria} />
      <PreviewRow label="Audit manager" value={d.engagement.auditManager} />
      <PreviewRow label="Team" value={d.team.map((t) => `${t.name} (${t.roleLabel})`).join(", ") || "—"} />
      <PreviewRow label="Programs" value={`${d.programs.length} program(s), ${d.programs.reduce((n, p) => n + p.procedures.length, 0)} procedure(s)`} />
      <PreviewRow label="Findings" value={`${d.findings.length} finding(s)`} />
    </>
  );
}

function renderFindings(d: FindingsReportData) {
  return (
    <>
      <PreviewRow label="Total findings" value={String(d.total)} />
      <PreviewRow
        label="By severity"
        value={Object.entries(d.bySeverity)
          .filter(([, n]) => n > 0)
          .map(([s, n]) => `${s}: ${n}`)
          .join(" · ") || "—"}
      />
      <div className="mt-2 space-y-1.5">
        {d.findings.slice(0, 12).map((f) => (
          <div key={f.code} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono text-muted-foreground">{f.code}</span>
            <span className="font-medium">{f.title}</span>
            <SeverityBadge severity={f.severity as Severity} />
            <StatusChip status={f.status} />
          </div>
        ))}
      </div>
    </>
  );
}

function renderExecutive(d: ExecutiveSummaryData) {
  const opinionLabel =
    d.opinion === "satisfactory"
      ? "Satisfactory"
      : d.opinion === "needs_improvement"
        ? "Needs improvement"
        : "Unsatisfactory";
  return (
    <>
      <PreviewRow
        label="Audit coverage"
        value={`${d.auditUniverse.coveragePct}% (${d.auditUniverse.audited}/${d.auditUniverse.total} universe items)`}
      />
      <PreviewRow
        label="Engagements"
        value={`${d.engagements.active} active · ${d.engagements.completed} completed · ${d.engagements.delayed} delayed`}
      />
      <PreviewRow
        label="Findings"
        value={`${d.findings.open} open · ${d.findings.critical} critical · ${d.findings.high} high`}
      />
      <PreviewRow
        label="Corrective actions"
        value={`${d.actions.outstanding} outstanding · ${d.actions.overdue} overdue`}
      />
      <PreviewRow label="Overall audit opinion" value={opinionLabel} />
    </>
  );
}

function PreviewRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_1fr]">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p>{value || <span className="text-muted-foreground">—</span>}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared HTML renderer for export
// ---------------------------------------------------------------------------

type ReportData = unknown;

function renderReportHtml(kind: ReportKind, data: ReportData): string {
  const d = data as Record<string, unknown>;
  const esc = (s: unknown) =>
    String(s ?? "—").replace(/[<>&]/g, (c) =>
      c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
    );
  const org = (d.organization as { name: string } | null)?.name ?? "Organization";
  let body = `<h1>IITAMS Audit Report</h1><p class="meta">${esc(org)} · Generated ${new Date().toLocaleString()}</p>`;

  if (kind === "executive") {
    const e = d as unknown as ExecutiveSummaryData;
    body += `<h2>Executive Audit Summary</h2>
<table><tr><th>Coverage</th><td>${e.auditUniverse.coveragePct}% (${e.auditUniverse.audited}/${e.auditUniverse.total})</td></tr>
<tr><th>Engagements</th><td>${e.engagements.active} active, ${e.engagements.completed} completed, ${e.engagements.delayed} delayed</td></tr>
<tr><th>Findings</th><td>${e.findings.open} open, ${e.findings.critical} critical, ${e.findings.high} high</td></tr>
<tr><th>Actions</th><td>${e.actions.outstanding} outstanding, ${e.actions.overdue} overdue</td></tr>
<tr><th>Overall opinion</th><td><b>${esc(e.opinion)}</b></td></tr></table>`;
  } else if (kind === "findings") {
    const f = d as unknown as FindingsReportData;
    body += `<h2>Findings Report</h2><table><tr><th>Ref</th><th>Title</th><th>Severity</th><th>Status</th><th>Owner</th><th>Due</th></tr>`;
    for (const x of f.findings) {
      body += `<tr><td>${esc(x.code)}</td><td>${esc(x.title)}</td><td>${esc(x.severity)}</td><td>${esc(x.status)}</td><td>${esc(x.ownerName)}</td><td>${x.dueDate ? new Date(x.dueDate).toLocaleDateString() : "—"}</td></tr>`;
    }
    body += `</table>`;
  } else {
    const e = d as unknown as EngagementReportData;
    body += `<h2>Engagement Report — ${esc(e.engagement.code)}</h2>
<table>
<tr><th>Title</th><td>${esc(e.engagement.title)}</td></tr>
<tr><th>Status</th><td>${esc(e.engagement.statusLabel)}</td></tr>
<tr><th>Objective</th><td>${esc(e.engagement.objective)}</td></tr>
<tr><th>Scope</th><td>${esc(e.engagement.scope)}</td></tr>
<tr><th>Criteria</th><td>${esc(e.engagement.criteria)}</td></tr>
<tr><th>Audit manager</th><td>${esc(e.engagement.auditManager)}</td></tr>
</table>
<h2>Team</h2><ul>${e.team.map((t) => `<li>${esc(t.name)} — ${esc(t.roleLabel)}</li>`).join("") || "<li>—</li>"}</ul>
<h2>Programs &amp; Procedures</h2>`;
    for (const p of e.programs) {
      body += `<h3>${esc(p.code)} ${esc(p.title)}</h3><table><tr><th>Procedure</th><th>Control objective</th><th>Expected evidence</th><th>Result</th></tr>`;
      for (const x of p.procedures) {
        body += `<tr><td>${esc(x.code)} ${esc(x.name)}</td><td>${esc(x.controlObjective)}</td><td>${esc(x.expectedEvidence)}</td><td>${esc(x.result ?? x.completionStatus)}</td></tr>`;
      }
      body += `</table>`;
    }
    body += `<h2>Findings</h2><table><tr><th>Ref</th><th>Title</th><th>Severity</th><th>Recommendation</th></tr>`;
    for (const f of e.findings) {
      body += `<tr><td>${esc(f.code)}</td><td>${esc(f.title)}</td><td>${esc(f.severity)}</td><td>${esc(f.recommendation)}</td></tr>`;
    }
    body += `</table>`;
  }
  return body;
}
