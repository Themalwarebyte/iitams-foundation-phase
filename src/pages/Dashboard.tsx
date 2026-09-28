import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AppLayout } from "@/components/iitams/AppLayout";
import { Breadcrumbs, PageHeader } from "@/components/iitams/PageHeader";
import { KpiCard } from "@/components/iitams/KpiCard";
import {
  EffectivenessGauge,
  FrameworkBarChart,
  RiskHeatMap,
  SeverityBarChart,
  TrendLineChart,
} from "@/components/iitams/charts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/lib/format";
import {
  Activity,
  ClipboardCheck,
  Flame,
  FolderOpen,
  Gauge,
  ListChecks,
  RefreshCcw,
  ShieldAlert,
  ShieldCheck,
  Timer,
  Waypoints,
} from "lucide-react";
import { Link } from "react-router";

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-9 w-72" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}

export default function Dashboard() {
  const data = useQuery(api.dashboard.executive, {});

  return (
    <AppLayout>
      <Breadcrumbs path="/dashboard" />
      <PageHeader
        eyebrow="Overview"
        title="Executive Dashboard"
        description={`Consolidated ICT assurance posture for ${
          data?.organization?.name ?? "your organization"
        } — audits, risk, compliance, cybersecurity and continuity at a glance.`}
        actions={
          data?.isDemoData ? (
            <Badge
              variant="outline"
              className="gap-1.5 bg-warning/15 text-foreground/90 border-warning/40"
            >
              <Flame className="size-3.5" aria-hidden />
              Demo environment — synthetic data
            </Badge>
          ) : undefined
        }
      />

      {!data ? (
        <DashboardSkeleton />
      ) : (
        <div className="space-y-6">
          {/* KPI grid */}
          <section aria-label="Key performance indicators">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard
                label="Active audits"
                value={data.kpis.activeAudits}
                icon={FolderOpen}
                tone="primary"
                hint="Engagements not yet closed"
                tooltip="Audit engagements in planning, fieldwork or reporting stages."
                href="/audit/engagements"
              />
              <KpiCard
                label="Audit-plan completion"
                value={data.kpis.auditPlanCompletionPct}
                suffix="%"
                icon={ListChecks}
                tone="primary"
                hint="Average engagement progress"
                tooltip="Mean progress across all engagements in the current plan."
                href="/audit/plans"
              />
              <KpiCard
                label="Open findings"
                value={data.kpis.openFindings}
                icon={Flame}
                tone="warning"
                hint="Open or in remediation"
                tooltip="Findings awaiting closure, including those in active remediation."
                href="/audit/findings"
              />
              <KpiCard
                label="Critical / high findings"
                value={data.kpis.criticalHighFindings}
                icon={ShieldAlert}
                tone="critical"
                hint="Escalated for urgent action"
                tooltip="Open findings rated critical or high severity."
                href="/audit/findings"
              />
              <KpiCard
                label="Overdue corrective actions"
                value={data.kpis.overdueCorrectiveActions}
                icon={RefreshCcw}
                tone="critical"
                hint="Past agreed remediation date"
                tooltip="Corrective actions whose due date has passed without verified closure."
                href="/audit/corrective-actions"
              />
              <KpiCard
                label="Open ICT risks"
                value={data.kpis.openRisks}
                icon={Waypoints}
                tone="warning"
                hint="Any risk not yet closed"
                tooltip="Risks in open, assessing, mitigating, treated or accepted states."
                href="/risk/register"
              />
              <KpiCard
                label="Critical ICT risks"
                value={data.kpis.criticalRisks}
                icon={ShieldAlert}
                tone="critical"
                hint="Residual score 15+ of 25"
                tooltip="Open risks whose residual likelihood × impact reaches the critical band (score 15–25)."
                href="/risk/heat-map"
              />
              <KpiCard
                label="Critical vulnerabilities"
                value={data.kpis.criticalVulnerabilities}
                icon={ShieldAlert}
                tone="critical"
                hint="Open or confirmed, critical/high"
                tooltip="Unremediated vulnerabilities rated critical or high."
                href="/cyber/vulnerabilities"
              />
              <KpiCard
                label="Compliance score"
                value={data.kpis.complianceScorePct}
                suffix="%"
                icon={ShieldCheck}
                tone="success"
                hint="Mean across frameworks"
                tooltip="Average implemented-control percentage across tracked frameworks."
                href="/compliance/dashboard"
              />
              <KpiCard
                label="Control effectiveness"
                value={data.kpis.controlEffectivenessPct}
                suffix="%"
                icon={Gauge}
                tone="success"
                hint="Effective of tested controls"
                tooltip="Share of tested controls assessed as fully effective."
                href="/compliance/controls"
              />
              <KpiCard
                label="BCM readiness"
                value={data.kpis.bcmReadinessPct}
                suffix="%"
                icon={Activity}
                tone="info"
                hint="Mean across critical services"
                tooltip="Average readiness score across critical services."
                href="/bcm/critical-services"
              />
              <KpiCard
                label="DR readiness"
                value={data.kpis.drReadinessPct}
                suffix="%"
                icon={Timer}
                tone="info"
                hint="DR tests passed"
                tooltip="Share of disaster-recovery tests completed successfully."
                href="/bcm/dr-tests"
              />
            </div>
          </section>

          {/* Charts */}
          <section
            aria-label="Assurance analytics"
            className="grid gap-4 lg:grid-cols-2"
          >
            <SeverityBarChart
              title="Findings by severity"
              description="Open and in-remediation findings by rating."
              data={data.distributions.findingsBySeverity}
            />
            <TrendLineChart
              title="Risk trends"
              description="Open risks and critical/high count by quarter."
              data={data.trends}
            />
            <RiskHeatMap
              title="Residual risk heat map"
              description="Open risks plotted on the 5×5 likelihood × impact grid."
              cells={data.distributions.riskHeatCells}
            />
            <FrameworkBarChart
              title="Compliance by framework"
              description="Implemented-control percentage per framework."
              data={data.distributions.frameworkScores}
            />
          </section>

          {/* Supporting panels */}
          <section className="grid gap-4 lg:grid-cols-3">
            <EffectivenessGauge
              title="Control effectiveness"
              description="Share of tested controls rated effective."
              value={data.kpis.controlEffectivenessPct}
              caption="Controls not yet tested are excluded from the gauge."
              className="lg:row-span-1"
            />

            <Card className="border-border/70 shadow-none">
              <CardHeader>
                <CardTitle className="text-base">Upcoming deadlines</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <ClipboardCheck className="size-4 text-primary" aria-hidden />
                    Engagements due in 30 days
                  </span>
                  <span className="font-semibold tabular-nums">
                    {data.upcomingDeadlines.engagementsDueSoon}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <Timer className="size-4 text-primary" aria-hidden />
                    DR tests scheduled
                  </span>
                  <span className="font-semibold tabular-nums">
                    {data.upcomingDeadlines.upcomingDrTests}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <ShieldAlert className="size-4 text-critical" aria-hidden />
                    Overdue corrective actions
                  </span>
                  <span className="font-semibold tabular-nums text-critical">
                    {data.kpis.overdueCorrectiveActions}
                  </span>
                </div>
                <Button variant="outline" size="sm" asChild className="mt-2 w-full">
                  <Link to="/audit/corrective-actions">View corrective actions</Link>
                </Button>
              </CardContent>
            </Card>

            <Card className="border-border/70 shadow-none">
              <CardHeader>
                <CardTitle className="text-base">Recent activity</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="space-y-3">
                  {data.recentActivity.length === 0 && (
                    <li className="text-sm text-muted-foreground">
                      No recorded activity yet.
                    </li>
                  )}
                  {data.recentActivity.map((item) => (
                    <li key={item.id} className="flex gap-3 text-sm">
                      <span
                        aria-hidden
                        className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
                      />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{item.summary}</p>
                        <p className="text-xs text-muted-foreground">
                          {item.actor} · {formatRelative(item.createdAt)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          </section>

          <p className="text-xs text-muted-foreground">
            Figures computed live from IITAMS records
            {data.organization?.name ? ` for ${data.organization.name}` : ""}.
            {data.isDemoData &&
              " This deployment is running on flagged demonstration data — not production statistics."}
          </p>
        </div>
      )}
    </AppLayout>
  );
}
