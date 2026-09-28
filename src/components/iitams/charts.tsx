import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { SEVERITY_META, type Severity } from "@/lib/severity";
import { statusLabel } from "./badges";

const chartCard =
  "border-border/70 shadow-none transition-colors hover:border-primary/30";

/** Findings / vulnerabilities by severity — horizontal stacked bars. */
export function SeverityBarChart({
  title,
  description,
  data,
  className,
}: {
  title: string;
  description?: string;
  data: Partial<Record<Severity, number>>;
  className?: string;
}) {
  const rows = (["critical", "high", "medium", "low", "informational"] as const)
    .map((sev) => ({
      severity: SEVERITY_META[sev].label,
      count: data[sev] ?? 0,
      fill: SEVERITY_META[sev].color,
    }))
    .filter((r) => r.count > 0 || r.severity !== "Informational");

  return (
    <Card className={cn(chartCard, className)}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={Object.fromEntries(
            rows.map((r) => [r.severity.toLowerCase(), { label: r.severity, color: r.fill }]),
          ) as ChartConfig}
          className="h-56 w-full"
        >
          <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16 }}>
            <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis type="number" allowDecimals={false} stroke="var(--muted-foreground)" fontSize={12} />
            <YAxis
              type="category"
              dataKey="severity"
              width={92}
              stroke="var(--muted-foreground)"
              fontSize={12}
            />
            <ChartTooltip content={<ChartTooltipContent hideLabel />} />
            <Bar dataKey="count" radius={[0, 4, 4, 0]} barSize={18}>
              {rows.map((row) => (
                <Cell key={row.severity} fill={row.fill} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/** Open-risk trend over time (single or dual series). */
export function TrendLineChart({
  title,
  description,
  data,
  className,
}: {
  title: string;
  description?: string;
  data: { label: string; openRisks: number; criticalHigh: number }[];
  className?: string;
}) {
  const config = {
    openRisks: { label: "Open risks", color: "var(--chart-1)" },
    criticalHigh: { label: "Critical / high", color: "var(--chart-5)" },
  } satisfies ChartConfig;

  return (
    <Card className={cn(chartCard, className)}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="h-56 w-full">
          <LineChart data={data} margin={{ left: -18, right: 12 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="label" stroke="var(--muted-foreground)" fontSize={12} />
            <YAxis stroke="var(--muted-foreground)" fontSize={12} allowDecimals={false} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <ChartLegend content={<ChartLegendContent />} />
            <Line
              type="monotone"
              dataKey="openRisks"
              stroke="var(--chart-1)"
              strokeWidth={2}
              dot={{ r: 2.5 }}
            />
            <Line
              type="monotone"
              dataKey="criticalHigh"
              stroke="var(--chart-5)"
              strokeWidth={2}
              dot={{ r: 2.5 }}
            />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/** Compliance score by framework — horizontal bars. */
export function FrameworkBarChart({
  title,
  description,
  data,
  className,
}: {
  title: string;
  description?: string;
  data: { name: string; score: number }[];
  className?: string;
}) {
  const config = {
    score: { label: "Compliance", color: "var(--chart-2)" },
  } satisfies ChartConfig;

  return (
    <Card className={cn(chartCard, className)}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {data.length === 0 && (
          <p className="text-sm text-muted-foreground">No frameworks recorded.</p>
        )}
        {data.map((f) => (
          <div key={f.name}>
            <div className="mb-1.5 flex items-center justify-between gap-4 text-sm">
              <span className="truncate font-medium">{f.name}</span>
              <span className="tabular-nums text-muted-foreground">
                {Math.round(f.score)}%
              </span>
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
              role="meter"
              aria-valuenow={Math.round(f.score)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${f.name} compliance`}
            >
              <div
                className="h-full rounded-full bg-chart-2 transition-all"
                style={{ width: `${Math.max(2, Math.min(100, f.score))}%` }}
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Control effectiveness — radial gauge. */
export function EffectivenessGauge({
  title,
  description,
  value,
  caption,
  className,
}: {
  title: string;
  description?: string;
  /** 0-100 */
  value: number;
  caption?: string;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const data = [{ name: "score", value: clamped, fill: "var(--chart-2)" }];
  const config = {
    score: { label: "Effectiveness", color: "var(--chart-2)" },
  } satisfies ChartConfig;

  return (
    <Card className={cn(chartCard, className)}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="mx-auto h-44 w-full max-w-56">
          <RadialBarChart
            data={data}
            startAngle={90}
            endAngle={-270}
            innerRadius={58}
            outerRadius={80}
          >
            <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
            <RadialBar dataKey="value" cornerRadius={8} background />
          </RadialBarChart>
        </ChartContainer>
        <p className="-mt-28 pb-20 text-center text-3xl font-bold tabular-nums">
          {clamped}%
        </p>
        {caption && (
          <p className="mt-2 text-center text-xs text-muted-foreground">{caption}</p>
        )}
      </CardContent>
    </Card>
  );
}

const HEAT_ORDER = [5, 4, 3, 2, 1] as const;
const HEAT_TONE: Record<string, string> = {
  critical: "bg-critical text-critical-foreground",
  high: "bg-warning text-warning-foreground",
  medium: "bg-info text-info-foreground",
  low: "bg-success/15 text-success border border-success/30",
  empty: "bg-muted/60 text-muted-foreground/40",
};

function heatTone(score: number): string {
  if (score >= 15) return HEAT_TONE.critical;
  if (score >= 10) return HEAT_TONE.high;
  if (score >= 5) return HEAT_TONE.medium;
  return HEAT_TONE.low;
}

/** 5×5 residual risk heat map (likelihood × impact). */
export function RiskHeatMap({
  title,
  description,
  cells,
  className,
}: {
  title: string;
  description?: string;
  /** Map of "likelihood-impact" → count, e.g. { "3-5": 2 } */
  cells: Record<string, number>;
  className?: string;
}) {
  return (
    <Card className={cn(chartCard, className)}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="flex-1">
            <div
              role="table"
              aria-label="Residual risk heat map, likelihood by impact"
              className="grid grid-cols-6 gap-1.5"
            >
              {/* header row */}
              <div />
              {[1, 2, 3, 4, 5].map((imp) => (
                <div
                  key={imp}
                  className="text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                >
                  I{imp}
                </div>
              ))}
              {HEAT_ORDER.map((lik) => (
                <HeatRow key={lik} likelihood={lik} cells={cells} />
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Impact →</span>
              <span>Cells show the number of open risks.</span>
            </div>
          </div>
          <div className="flex shrink-0 flex-row gap-3 text-xs sm:flex-col">
            {(["critical", "high", "medium", "low"] as const).map((k) => (
              <div key={k} className="flex items-center gap-1.5">
                <span aria-hidden className={cn("size-3 rounded-sm", HEAT_TONE[k])} />
                <span className="capitalize">{k}</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function HeatRow({
  likelihood,
  cells,
}: {
  likelihood: number;
  cells: Record<string, number>;
}) {
  return (
    <>
      <div className="flex items-center justify-end pr-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        L{likelihood}
      </div>
      {[1, 2, 3, 4, 5].map((imp) => {
        const count = cells[`${likelihood}-${imp}`] ?? 0;
        const score = likelihood * imp;
        return (
          <div
            key={imp}
            title={`Likelihood ${likelihood} × impact ${imp}: ${count} risk${count === 1 ? "" : "s"}`}
            className={cn(
              "flex h-10 items-center justify-center rounded-md text-sm font-semibold tabular-nums transition-transform",
              count > 0 ? heatTone(score) : HEAT_TONE.empty,
            )}
          >
            {count > 0 ? count : ""}
          </div>
        );
      })}
    </>
  );
}

export { statusLabel };
