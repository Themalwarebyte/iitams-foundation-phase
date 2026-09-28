import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  CLASSIFICATION_META,
  SEVERITY_META,
  type DataClassification,
  type Severity,
} from "@/lib/severity";
import { ShieldCheck, AlertTriangle } from "lucide-react";
import { Progress } from "@/components/ui/progress";

/** Severity indicator — icon + label + colour (never colour alone). */
export function SeverityBadge({
  severity,
  className,
}: {
  severity: Severity;
  className?: string;
}) {
  const meta = SEVERITY_META[severity];
  const Icon = meta.icon;
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 font-medium", meta.badge, className)}
    >
      <Icon className="size-3" aria-hidden />
      {meta.label}
    </Badge>
  );
}

const STATUS_CHIP: Record<string, string> = {
  // generic lifecycle states
  open: "bg-critical/10 text-critical border-critical/25",
  in_progress: "bg-info/10 text-info border-info/25",
  in_remediation: "bg-info/10 text-info border-info/25",
  planned: "bg-muted text-muted-foreground border-border",
  scheduled: "bg-muted text-muted-foreground border-border",
  draft: "bg-muted text-muted-foreground border-border",
  approved: "bg-success/10 text-success border-success/25",
  completed: "bg-success/10 text-success border-success/25",
  resolved: "bg-success/10 text-success border-success/25",
  implemented: "bg-success/10 text-success border-success/25",
  verified: "bg-success/10 text-success border-success/25",
  treated: "bg-success/10 text-success border-success/25",
  effective: "bg-success/10 text-success border-success/25",
  mitigating: "bg-info/10 text-info border-info/25",
  assessing: "bg-info/10 text-info border-info/25",
  fieldwork: "bg-info/10 text-info border-info/25",
  reporting: "bg-info/10 text-info border-info/25",
  in_execution: "bg-info/10 text-info border-info/25",
  confirmed: "bg-warning/15 text-foreground/90 border-warning/40",
  partially_effective: "bg-warning/15 text-foreground/90 border-warning/40",
  not_started: "bg-muted text-muted-foreground border-border",
  not_tested: "bg-muted text-muted-foreground border-border",
  failed: "bg-critical/10 text-critical border-critical/25",
  overdue: "bg-critical/10 text-critical border-critical/25",
  ineffective: "bg-critical/10 text-critical border-critical/25",
  risk_accepted: "bg-warning/15 text-foreground/90 border-warning/40",
  accepted: "bg-warning/15 text-foreground/90 border-warning/40",
  false_positive: "bg-muted text-muted-foreground border-border",
  remediated: "bg-success/10 text-success border-success/25",
  closed: "bg-muted text-muted-foreground border-border",
  cancelled: "bg-muted text-muted-foreground border-border",
  deferred: "bg-muted text-muted-foreground border-border",
};

/** Human label for snake_case status values. */
export function statusLabel(status: string): string {
  return status
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function StatusChip({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 font-medium",
        STATUS_CHIP[status] ?? "bg-muted text-muted-foreground border-border",
        className,
      )}
    >
      <span
        aria-hidden
        className="inline-block size-1.5 rounded-full bg-current opacity-70"
      />
      {statusLabel(status)}
      <span className="sr-only"> status</span>
    </Badge>
  );
}

/** Data classification indicator (visual only in Phase 1). */
export function ClassificationBadge({
  classification,
  className,
}: {
  classification: DataClassification;
  className?: string;
}) {
  const meta = CLASSIFICATION_META[classification];
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 font-medium uppercase tracking-wide text-[10px]", meta.className, className)}
    >
      <ShieldCheck className="size-3" aria-hidden />
      {meta.label}
    </Badge>
  );
}

/** Residual-risk indicator on the 5x5 model (score = likelihood × impact). */
export function RiskScoreBadge({
  likelihood,
  impact,
  className,
}: {
  likelihood: number;
  impact: number;
  className?: string;
}) {
  const score = likelihood * impact;
  const level =
    score >= 15 ? "Critical" : score >= 10 ? "High" : score >= 5 ? "Medium" : "Low";
  const Icon = score >= 10 ? AlertTriangle : ShieldCheck;
  const tone =
    score >= 15
      ? "bg-critical/10 text-critical border-critical/30"
      : score >= 10
        ? "bg-warning/15 text-foreground/90 border-warning/40"
        : score >= 5
          ? "bg-info/10 text-info border-info/30"
          : "bg-success/10 text-success border-success/30";
  return (
    <Badge variant="outline" className={cn("gap-1 font-medium", tone, className)}>
      <Icon className="size-3" aria-hidden />
      {level}
      <span className="sr-only">
        {" "}
        ({score} of 25)
      </span>
      <span aria-hidden className="tabular-nums text-[10px] opacity-70">
        {score}
      </span>
    </Badge>
  );
}

/** Compact labelled progress meter used in lists and tables. */
export function ProgressMeter({
  value,
  label,
  className,
}: {
  value: number;
  label?: string;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={cn("min-w-24", className)}>
      {label && (
        <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
          <span>{label}</span>
          <span className="tabular-nums font-medium text-foreground">
            {clamped}%
          </span>
        </div>
      )}
      <Progress
        value={clamped}
        aria-label={label ? `${label}: ${clamped}%` : `${clamped}%`}
        className="h-1.5"
      />
    </div>
  );
}
