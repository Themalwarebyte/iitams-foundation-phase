import { Component, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { Link } from "react-router";
import { api } from "@/convex/_generated/api";
import { AppLayout } from "@/components/iitams/AppLayout";
import { Breadcrumbs, PageHeader } from "@/components/iitams/PageHeader";
import { EmptyState, ListSkeleton } from "@/components/iitams/audit/ListPageShell";
import { RiskScoreBadge, StatusChip } from "@/components/iitams/badges";
import { KpiCard } from "@/components/iitams/KpiCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { formatDate } from "@/lib/format";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Gauge,
  ListChecks,
  Loader2,
  RefreshCcw,
  ShieldAlert,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

/**
 * /risk/monitoring — Phase 3B Batch 2C: ICT risk monitoring and treatment
 * oversight.
 * =======================================================================
 * Read-only assurance view over the register, the immutable assessment history
 * and treatment plans/actions. Every figure is organization-scoped and derived
 * server-side (`riskMonitoring.ts`); this page only presents it. Completing a
 * treatment never lowers a residual score here — only a recorded assessment
 * does — and an `accept` treatment strategy is shown as a proposal, not an
 * approved acceptance.
 */

type RiskBand = "critical" | "high" | "medium" | "low";

type MonitoringFilter =
  | "all"
  | "high_priority"
  | "overdue_assessment"
  | "overdue_treatment"
  | "no_treatment_plan"
  | "awaiting_reassessment";

const FILTERS: Array<{
  value: MonitoringFilter;
  label: string;
  description: string;
}> = [
  {
    value: "all",
    label: "All active risks",
    description: "Every risk that has not been closed.",
  },
  {
    value: "high_priority",
    label: "High priority",
    description: "Residual band critical or high on the 5×5 model.",
  },
  {
    value: "overdue_assessment",
    label: "Overdue reassessment",
    description: "Past their scheduled review date.",
  },
  {
    value: "overdue_treatment",
    label: "Overdue treatment",
    description: "At least one open action past its due date.",
  },
  {
    value: "no_treatment_plan",
    label: "No treatment plan",
    description: "Active risks with no treatment plan recorded.",
  },
  {
    value: "awaiting_reassessment",
    label: "Awaiting reassessment",
    description: "Treatment completed, but no assessment since completion.",
  },
];

type RiskRow = {
  riskId: string;
  code: string;
  title: string;
  category: string;
  status: string;
  ownerName?: string;
  reviewDue?: number;
  reviewOverdue: boolean;
  residualLikelihood: number;
  residualImpact: number;
  residualScore: number;
  residualBand: RiskBand;
  inherentScore: number;
  plansTotal: number;
  openPlans: number;
  completedPlans: number;
  actionsTotal: number;
  actionsCompleted: number;
  actionsOutstanding: number;
  actionsOverdue: number;
  assessments: number;
  latestAssessmentDate: number | null;
  lastPlanCompletedAt: number | null;
  awaitingReassessment: boolean;
  trendDirection: "increased" | "decreased" | "unchanged" | "unknown";
  trendChange: number | null;
};

type OverdueAction = {
  actionId: string;
  riskId: string;
  planId: string;
  planReference: string;
  riskCode: string;
  riskTitle: string;
  description: string;
  ownerName: string;
  dueDate: number;
  daysOverdue: number;
};

type Overview = {
  generatedAt: number;
  sampled: {
    risks: boolean;
    plans: boolean;
    actions: boolean;
    assessments: boolean;
  };
  kpis: {
    activeRisks: number;
    highCritical: number;
    overdueAssessments: number;
    risksWithOpenPlans: number;
    overdueActions: number;
    completedActions: number;
    increasingResidual: number;
    awaitingReassessment: number;
  };
  bands: Record<RiskBand, number>;
  statuses: Record<string, number>;
  movements: {
    increased: number;
    decreased: number;
    unchanged: number;
    noHistory: number;
  };
  treatment: {
    plansTotal: number;
    openPlans: number;
    completedPlans: number;
    actionsTotal: number;
    actionsCompleted: number;
    actionsOutstanding: number;
    actionsOverdue: number;
    strategyCounts: Record<string, number>;
  };
  attention: {
    highPriority: RiskRow[];
    overdueAssessments: RiskRow[];
    awaitingReassessment: RiskRow[];
    withoutTreatmentPlan: RiskRow[];
    overdueActions: OverdueAction[];
  };
  trend: TrendData;
  oversight: Oversight;
};

type TrendData = {
  monthly: Array<{
    month: string;
    label: string;
    assessments: number;
    avgInherent: number;
    avgResidual: number;
    maxResidual: number;
  }>;
  movements: {
    increased: number;
    decreased: number;
    unchanged: number;
    noHistory: number;
  };
  riskMovements: Array<{
    riskId: string;
    code: string;
    title: string;
    residualBand: RiskBand;
    from: number | null;
    to: number | null;
    change: number | null;
    direction: string;
    at: number | null;
    awaitingReassessment: boolean;
  }>;
  totalAssessments: number;
  sampled: { assessments: boolean; risks: boolean };
};

type OversightPlan = {
  planId: string;
  reference: string;
  riskId: string;
  riskCode: string;
  riskTitle: string;
  strategy: string;
  strategyLabel: string;
  status: string;
  statusLabel: string;
  ownerName: string;
  targetDate: number;
  targetOverdue: boolean;
  daysToTarget: number;
  total: number;
  completed: number;
  outstanding: number;
  overdue: number;
  progressPct: number;
  completedAt?: number;
  residualScore: number;
  residualBand: RiskBand;
  awaitingReassessment: boolean;
  acceptanceProposal: boolean;
};

type Oversight = {
  rows: OversightPlan[];
  total: number;
  truncated: boolean;
  sampled: Overview["sampled"];
};

type RiskPage = {
  rows: RiskRow[];
  continueCursor: string;
  isDone: boolean;
  scanned: number;
};

/** Local error boundary: a failed monitoring query must not blank the app. */
class MonitoringErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <Card className="mx-auto max-w-lg border-dashed shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4 text-warning" aria-hidden />
              Monitoring data could not be loaded
            </CardTitle>
            <CardDescription>
              The monitoring query failed. Your access may have changed, or the
              backend is temporarily unavailable. No data was modified.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.location.reload()}
            >
              <RefreshCcw className="size-3.5" aria-hidden />
              Reload
            </Button>
          </CardContent>
        </Card>
      );
    }
    return this.props.children;
  }
}

function BandBar({
  band,
  count,
  total,
}: {
  band: RiskBand;
  count: number;
  total: number;
}) {
  const pct = total === 0 ? 0 : Math.round((count / total) * 100);
  const tone =
    band === "critical"
      ? "bg-critical"
      : band === "high"
        ? "bg-warning"
        : band === "medium"
          ? "bg-info"
          : "bg-success";
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="capitalize">{band}</span>
        <span className="tabular-nums text-muted-foreground">
          {count} <span className="text-xs">({pct}%)</span>
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${tone}`}
          style={{ width: `${pct}%` }}
          role="img"
          aria-label={`${band}: ${count} of ${total} active risks`}
        />
      </div>
    </div>
  );
}

function TrendIndicator({ row }: { row: RiskRow }) {
  if (row.trendDirection === "unknown") {
    return (
      <span className="text-xs text-muted-foreground">No history</span>
    );
  }
  if (row.trendDirection === "unchanged") {
    return <span className="text-xs text-muted-foreground">No change</span>;
  }
  const up = row.trendDirection === "increased";
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium ${
        up ? "text-critical" : "text-success"
      }`}
    >
      <Icon className="size-3.5" aria-hidden />
      {up ? "+" : ""}
      {row.trendChange}
      <span className="sr-only">
        {up ? "increased" : "decreased"} residual score since the previous
        assessment
      </span>
    </span>
  );
}

export function RiskMonitoringPage() {
  const session = useQuery(api.session.getSession);
  const canView = session?.permissions?.risk === true;

  const [filter, setFilter] = useState<MonitoringFilter>("all");
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [olderRows, setOlderRows] = useState<RiskRow[]>([]);

  // Changing the filter or the search restarts pagination from the first page.
  // Done in the handlers (not an effect) so no cascading render is scheduled.
  const restartPagination = () => {
    setCursor(null);
    setOlderRows([]);
  };

  // One consistent snapshot: KPIs, trend and treatment oversight all derive
  // from the same bounded record set in a single query execution.
  const overview = useQuery(
    api.riskMonitoring.monitoringOverview,
    canView ? {} : "skip",
  ) as Overview | undefined;
  const trends = overview?.trend;
  const oversight = overview?.oversight;
  const riskPage = useQuery(
    api.riskMonitoring.monitoringRisks,
    canView
      ? {
          filter,
          search: search.trim() || undefined,
          cursor: cursor ?? undefined,
          // Bounded scan batch per request (the server clamps it too).
          numItems: 100,
        }
      : "skip",
  ) as RiskPage | undefined;

  const rows = useMemo(() => {
    if (!riskPage) return undefined;
    const byId = new Map<string, RiskRow>();
    for (const row of [...olderRows, ...riskPage.rows]) byId.set(row.riskId, row);
    return [...byId.values()];
  }, [riskPage, olderRows]);

  const activeFilter = FILTERS.find((f) => f.value === filter) ?? FILTERS[0];
  const activeTotal =
    overview === undefined
      ? 0
      : (["critical", "high", "medium", "low"] as const).reduce(
          (n, band) => n + overview.bands[band],
          0,
        );

  const trendConfig = {
    avgInherent: { label: "Avg inherent", color: "var(--chart-2)" },
    avgResidual: { label: "Avg residual", color: "var(--chart-1)" },
  } satisfies ChartConfig;

  const header = (
    <>
      <Breadcrumbs path="/risk/monitoring" />
      <PageHeader
        eyebrow="ICT Risk"
        title="Risk Monitoring"
        description="Organization-level oversight of residual risk, reassessment deadlines and treatment progress. Figures are derived from the register, the immutable assessment history and treatment records; completing treatment never moves a score by itself."
        actions={
          <Button asChild variant="outline">
            <Link to="/risk/register">
              <ClipboardList className="size-4" aria-hidden />
              Open risk register
            </Link>
          </Button>
        }
      />
    </>
  );

  if (session === undefined) {
    return (
      <AppLayout>
        {header}
        <ListSkeleton rows={5} />
      </AppLayout>
    );
  }

  if (!canView) {
    return (
      <AppLayout>
        {header}
        <Card className="mx-auto max-w-md border-dashed shadow-none">
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-muted">
              <ShieldAlert className="size-5 text-muted-foreground" aria-hidden />
            </div>
            <CardTitle>Risk monitoring is not available for your role</CardTitle>
            <CardDescription>
              Reading monitoring data requires the <code>risk.view</code>{" "}
              permission. Ask your administrator if you believe this is an
              error.
            </CardDescription>
          </CardHeader>
        </Card>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      {header}

      <MonitoringErrorBoundary>
        <div className="space-y-6">
          {/* KPI strip */}
          <section
            aria-label="Risk monitoring key indicators"
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          >
            <KpiCard
              label="Active risks"
              value={overview?.kpis.activeRisks ?? "…"}
              icon={ClipboardList}
              hint="Not closed, scoped to your organization"
            />
            <KpiCard
              label="High & critical"
              value={overview?.kpis.highCritical ?? "…"}
              icon={ShieldAlert}
              tone="critical"
              hint="Residual score 10–25"
            />
            <KpiCard
              label="Overdue reassessments"
              value={overview?.kpis.overdueAssessments ?? "…"}
              icon={Clock}
              tone="warning"
              hint="Past their review date"
            />
            <KpiCard
              label="Risks with open plans"
              value={overview?.kpis.risksWithOpenPlans ?? "…"}
              icon={ListChecks}
              tone="info"
              hint="Planned or in-progress treatment"
            />
            <KpiCard
              label="Overdue actions"
              value={overview?.kpis.overdueActions ?? "…"}
              icon={AlertTriangle}
              tone="critical"
              hint="Open actions past their due date"
              tooltip="Only actions on live (planned or in-progress) plans count."
            />
            <KpiCard
              label="Completed actions"
              value={overview?.kpis.completedActions ?? "…"}
              icon={ClipboardCheck}
              tone="success"
              hint="Recorded with completion evidence"
            />
            <KpiCard
              label="Rising residual scores"
              value={overview?.kpis.increasingResidual ?? "…"}
              icon={TrendingUp}
              tone="warning"
              hint="Latest assessment higher than the previous one"
              tooltip="Derived from the immutable assessment history — never from treatment completion."
            />
            <KpiCard
              label="Awaiting reassessment"
              value={overview?.kpis.awaitingReassessment ?? "…"}
              icon={Gauge}
              hint="Treatment completed, no assessment since"
            />
          </section>

          {/* Distribution + trends */}
          <section className="grid gap-4 lg:grid-cols-[340px_1fr]">
            <Card className="border-border/70 shadow-none">
              <CardHeader>
                <CardTitle className="text-base">Residual risk by band</CardTitle>
                <CardDescription>
                  Active risks on the canonical 5×5 bands.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {overview === undefined ? (
                  <ListSkeleton rows={4} />
                ) : (
                  (["critical", "high", "medium", "low"] as const).map((band) => (
                    <BandBar
                      key={band}
                      band={band}
                      count={overview.bands[band]}
                      total={activeTotal}
                    />
                  ))
                )}
                {overview && overview.sampled.risks && (
                  <p className="text-xs text-muted-foreground">
                    Register exceeds the bounded monitoring window; figures
                    reflect the first {overview.bands.critical +
                      overview.bands.high +
                      overview.bands.medium +
                      overview.bands.low}{" "}
                    active records loaded.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card className="border-border/70 shadow-none">
              <CardHeader>
                <CardTitle className="text-base">
                  Assessment trend (average score)
                </CardTitle>
                <CardDescription>
                  Monthly averages from recorded assessments. Original
                  assessment dates are preserved; treatment completion is not a
                  score change.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {trends === undefined ? (
                  <ListSkeleton rows={3} />
                ) : trends.monthly.length === 0 ? (
                  <EmptyState
                    icon={Gauge}
                    title="No assessment history yet"
                    description="Record an assessment from a risk record to establish the score baseline and start the trend."
                  />
                ) : (
                  <>
                    <ChartContainer config={trendConfig} className="h-56 w-full">
                      <LineChart
                        data={trends.monthly}
                        margin={{ left: -18, right: 12 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="var(--border)"
                        />
                        <XAxis
                          dataKey="label"
                          stroke="var(--muted-foreground)"
                          fontSize={12}
                        />
                        <YAxis
                          stroke="var(--muted-foreground)"
                          fontSize={12}
                          domain={[0, 25]}
                        />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <ChartLegend content={<ChartLegendContent />} />
                        <Line
                          type="monotone"
                          dataKey="avgInherent"
                          stroke="var(--chart-2)"
                          strokeWidth={2}
                          dot={{ r: 2.5 }}
                        />
                        <Line
                          type="monotone"
                          dataKey="avgResidual"
                          stroke="var(--chart-1)"
                          strokeWidth={2}
                          dot={{ r: 2.5 }}
                        />
                      </LineChart>
                    </ChartContainer>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs">
                      <Badge variant="outline" className="gap-1">
                        <ArrowUpRight className="size-3 text-critical" aria-hidden />
                        {trends.movements.increased} increased
                      </Badge>
                      <Badge variant="outline" className="gap-1">
                        <TrendingDown className="size-3 text-success" aria-hidden />
                        {trends.movements.decreased} decreased
                      </Badge>
                      <Badge variant="outline">
                        {trends.movements.unchanged} unchanged
                      </Badge>
                      <Badge variant="outline">
                        {trends.movements.noHistory} with &lt;2 assessments
                      </Badge>
                      <span className="self-center text-muted-foreground">
                        {trends.totalAssessments} assessment
                        {trends.totalAssessments === 1 ? "" : "s"} on record
                      </span>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </section>

          {/* Overdue treatment actions */}
          <Card className="border-border/70 shadow-none">
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">
                  Overdue treatment actions
                </CardTitle>
                <CardDescription>
                  Open actions on live plans, oldest due date first.
                </CardDescription>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setFilter("overdue_treatment");
                  restartPagination();
                }}
              >
                View risks
                <ArrowRight className="size-3.5" aria-hidden />
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {overview === undefined ? (
                <div className="p-4">
                  <ListSkeleton rows={3} />
                </div>
              ) : overview.attention.overdueActions.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  No treatment action is past its due date.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Action</TableHead>
                      <TableHead>Risk</TableHead>
                      <TableHead>Owner</TableHead>
                      <TableHead>Due</TableHead>
                      <TableHead className="text-right">Overdue</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overview.attention.overdueActions.map((action) => (
                      <TableRow key={action.actionId}>
                        <TableCell>
                          <span className="block font-medium">
                            {action.description}
                          </span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {action.planReference}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Link
                            to={`/risk/register?risk=${action.riskId}`}
                            className="text-sm font-medium underline-offset-2 hover:underline"
                          >
                            <span className="font-mono text-xs text-muted-foreground">
                              {action.riskCode}
                            </span>
                            <span className="block">{action.riskTitle}</span>
                          </Link>
                        </TableCell>
                        <TableCell className="text-sm">{action.ownerName}</TableCell>
                        <TableCell className="text-sm">
                          {formatDate(action.dueDate)}
                        </TableCell>
                        <TableCell className="text-right text-sm font-medium text-critical">
                          {action.daysOverdue}d
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Treatment oversight */}
          <Card className="border-border/70 shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Treatment oversight</CardTitle>
              <CardDescription>
                Plans in progress with their owner, strategy, action progress
                and the register&apos;s current residual risk. An{" "}
                <span className="font-medium">Accept (proposal)</span> strategy
                is not an approved risk-acceptance decision.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {oversight === undefined ? (
                <div className="p-4">
                  <ListSkeleton rows={4} />
                </div>
              ) : oversight.rows.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  No treatment plan is currently open. Completed plans appear
                  once you select “Completed treatments awaiting reassessment”
                  in the list below.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Plan</TableHead>
                      <TableHead>Risk</TableHead>
                      <TableHead>Owner</TableHead>
                      <TableHead>Strategy</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Actions</TableHead>
                      <TableHead>Target</TableHead>
                      <TableHead className="text-right">Residual</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {oversight.rows.map((plan) => (
                      <TableRow key={plan.planId}>
                        <TableCell className="font-mono text-xs">
                          {plan.reference}
                        </TableCell>
                        <TableCell>
                          <Link
                            to={`/risk/register?risk=${plan.riskId}`}
                            className="underline-offset-2 hover:underline"
                          >
                            <span className="font-mono text-xs text-muted-foreground">
                              {plan.riskCode}
                            </span>
                            <span className="block text-sm font-medium">
                              {plan.riskTitle}
                            </span>
                          </Link>
                        </TableCell>
                        <TableCell className="text-sm">{plan.ownerName}</TableCell>
                        <TableCell className="text-sm">
                          {plan.acceptanceProposal ? (
                            <Badge
                              variant="outline"
                              className="border-warning/40 bg-warning/15 text-[10px] uppercase tracking-wide"
                            >
                              {plan.strategyLabel}
                            </Badge>
                          ) : (
                            plan.strategyLabel
                          )}
                        </TableCell>
                        <TableCell>
                          <StatusChip status={plan.status} />
                        </TableCell>
                        <TableCell className="min-w-40 text-xs">
                          <span className="tabular-nums">
                            {plan.completed}/{plan.total} done
                          </span>
                          <span className="block text-muted-foreground">
                            {plan.outstanding} outstanding
                            {plan.overdue > 0 && (
                              <span className="font-medium text-critical">
                                {" "}
                                · {plan.overdue} overdue
                              </span>
                            )}
                          </span>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary"
                              style={{ width: `${plan.progressPct}%` }}
                            />
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">
                          <span
                            className={
                              plan.targetOverdue
                                ? "font-medium text-critical"
                                : ""
                            }
                          >
                            {formatDate(plan.targetDate)}
                          </span>
                          {plan.targetOverdue && (
                            <span className="block text-xs text-critical">
                              overdue
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge
                            variant="outline"
                            className={`capitalize ${
                              plan.residualBand === "critical"
                                ? "border-critical/30 bg-critical/10 text-critical"
                                : plan.residualBand === "high"
                                  ? "border-warning/40 bg-warning/15"
                                  : plan.residualBand === "medium"
                                    ? "border-info/30 bg-info/10 text-info"
                                    : "border-success/30 bg-success/10 text-success"
                            }`}
                          >
                            {plan.residualBand}
                          </Badge>
                          <span className="mt-1 block text-xs text-muted-foreground tabular-nums">
                            score {plan.residualScore}
                          </span>
                          {plan.awaitingReassessment && (
                            <span className="mt-1 block text-xs text-warning">
                              reassess
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {oversight?.truncated && (
                <p className="px-4 pb-3 text-xs text-muted-foreground">
                  Showing the first {oversight.rows.length} of {oversight.total}{" "}
                  live plans.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Filtered risk list */}
          <section aria-label="Filtered risk lists" className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Select
                value={filter}
                onValueChange={(value) => {
                  setFilter(value as MonitoringFilter);
                  restartPagination();
                }}
              >
                <SelectTrigger className="w-full sm:w-64" aria-label="Monitoring filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FILTERS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  restartPagination();
                }}
                placeholder="Search code, title, owner or asset…"
                aria-label="Search monitored risks"
                className="w-full sm:max-w-xs"
              />
              <p className="text-xs text-muted-foreground">
                {activeFilter.description}
              </p>
            </div>

            {rows === undefined ? (
              <ListSkeleton rows={6} />
            ) : rows.length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                title={
                  search
                    ? "No risks match that search"
                    : filter === "all"
                      ? "No active risks recorded yet"
                      : "Nothing needs attention in this view"
                }
                description={
                  filter === "all"
                    ? "Create risk records in the register — monitoring derives every figure from them."
                    : "This is a good sign: no risk currently matches the selected condition."
                }
              />
            ) : (
              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Risk</TableHead>
                        <TableHead>Owner</TableHead>
                        <TableHead>Residual</TableHead>
                        <TableHead>Trend</TableHead>
                        <TableHead>Review</TableHead>
                        <TableHead>Treatment</TableHead>
                        <TableHead>Reassessment</TableHead>
                        <TableHead className="text-right">Detail</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row) => (
                        <TableRow key={row.riskId}>
                          <TableCell>
                            <Link
                              to={`/risk/register?risk=${row.riskId}`}
                              className="underline-offset-2 hover:underline"
                            >
                              <span className="font-mono text-xs text-muted-foreground">
                                {row.code}
                              </span>
                              <span className="block font-medium">
                                {row.title}
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                {row.category}
                              </span>
                            </Link>
                          </TableCell>
                          <TableCell className="text-sm">
                            {row.ownerName ?? "—"}
                          </TableCell>
                          <TableCell>
                            <RiskScoreBadge
                              likelihood={row.residualLikelihood}
                              impact={row.residualImpact}
                            />
                          </TableCell>
                          <TableCell>
                            <TrendIndicator row={row} />
                          </TableCell>
                          <TableCell className="text-sm">
                            <span
                              className={
                                row.reviewOverdue
                                  ? "font-medium text-critical"
                                  : ""
                              }
                            >
                              {row.reviewDue
                                ? formatDate(row.reviewDue)
                                : "Not scheduled"}
                            </span>
                            {row.reviewOverdue && (
                              <span className="block text-xs text-critical">
                                overdue
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            {row.plansTotal === 0 ? (
                              <span className="text-muted-foreground">
                                No plan
                              </span>
                            ) : (
                              <>
                                <span>
                                  {row.openPlans} open / {row.plansTotal} plan
                                  {row.plansTotal === 1 ? "" : "s"}
                                </span>
                                <span className="block text-muted-foreground">
                                  {row.actionsCompleted}/{row.actionsTotal}{" "}
                                  actions done
                                  {row.actionsOverdue > 0 && (
                                    <span className="font-medium text-critical">
                                      {" "}
                                      · {row.actionsOverdue} overdue
                                    </span>
                                  )}
                                </span>
                              </>
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            {row.awaitingReassessment ? (
                              <Badge
                                variant="outline"
                                className="border-warning/40 bg-warning/15"
                              >
                                Awaiting
                              </Badge>
                            ) : row.latestAssessmentDate ? (
                              <span className="text-muted-foreground">
                                {formatDate(row.latestAssessmentDate)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">
                                Never assessed
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button asChild size="sm" variant="outline">
                              <Link to={`/risk/register?risk=${row.riskId}`}>
                                Open
                              </Link>
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {rows === undefined
                  ? "Loading monitored risks…"
                  : `${rows.length} risk${rows.length === 1 ? "" : "s"} shown${
                      riskPage && !riskPage.isDone ? " (more available)" : ""
                    }`}
              </p>
              {riskPage && !riskPage.isDone && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setOlderRows((prev) => [...prev, ...riskPage.rows]);
                    setCursor(riskPage.continueCursor);
                  }}
                >
                  <Loader2 className="size-3.5" aria-hidden />
                  Load more
                </Button>
              )}
            </div>
          </section>
        </div>
      </MonitoringErrorBoundary>
    </AppLayout>
  );
}
