import { Component, type ReactNode } from "react";
import { AppLayout } from "@/components/iitams/AppLayout";
import { Breadcrumbs, PageHeader } from "@/components/iitams/PageHeader";
import { EmptyState, ErrorState } from "@/components/iitams/audit/ListPageShell";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { LockKeyhole, ShieldAlert } from "lucide-react";

/**
 * Shared presentation helpers for Business Continuity Management
 * (Phase 4A — Batch 4.1). Small on purpose: a crash guard, an honest
 * unauthorized state, the status pills and one disclaimer that keeps the
 * module from claiming resilience it has not evidenced.
 */

export class BcmBoundary extends Component<
  { children: ReactNode; title: string },
  { message: string | null }
> {
  state = { message: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { message: error.message || "Unknown error" };
  }
  render() {
    if (this.state.message) {
      return (
        <AppLayout>
          <ErrorState
            message={`${this.props.title} could not load: ${this.state.message}`}
          />
        </AppLayout>
      );
    }
    return this.props.children;
  }
}

/** Honest state for a role without bcm.view. */
export function BcmUnauthorized({ path }: { path: string }) {
  return (
    <AppLayout>
      <Breadcrumbs path={path} />
      <PageHeader
        eyebrow="Business Continuity"
        title="Business Continuity is not available for your role"
        description="The continuity register and business impact analyses require the bcm.view permission. Ask an administrator if you need access."
      />
      <EmptyState
        icon={LockKeyhole}
        title="Access denied"
        description="Your role does not include bcm.view, so no continuity data is shown."
      />
    </AppLayout>
  );
}

const SERVICE_STATUS_TONES: Record<string, string> = {
  active: "bg-success/10 text-success border-success/25",
  degraded: "bg-warning/20 text-foreground/90 border-warning/45",
  suspended: "bg-info/10 text-info border-info/25",
  retired: "bg-muted text-muted-foreground border-border",
};

const CRITICALITY_TONES: Record<string, string> = {
  critical: "bg-critical/10 text-critical border-critical/30",
  high: "bg-warning/20 text-foreground/90 border-warning/45",
  medium: "bg-warning/10 text-foreground/90 border-warning/30",
  low: "bg-info/10 text-info border-info/25",
};

const BIA_STATUS_TONES: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-border",
  in_review: "bg-warning/15 text-foreground/90 border-warning/40",
  approved: "bg-success/10 text-success border-success/25",
  superseded: "bg-info/10 text-info border-info/25",
};

const IMPACT_TONES: Record<string, string> = {
  none: "bg-muted text-muted-foreground border-border",
  low: "bg-info/10 text-info border-info/25",
  moderate: "bg-warning/10 text-foreground/90 border-warning/30",
  high: "bg-warning/20 text-foreground/90 border-warning/45",
  severe: "bg-critical/10 text-critical border-critical/30",
};

function Pill({
  label,
  tone,
  className,
}: {
  label: string;
  tone?: string;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 font-medium",
        tone ?? "bg-muted text-muted-foreground border-border",
        className,
      )}
    >
      <span
        aria-hidden
        className="inline-block size-1.5 rounded-full bg-current opacity-70"
      />
      {label}
    </Badge>
  );
}

export function ServiceStatusPill({
  status,
  label,
}: {
  status: string;
  label: string;
}) {
  return <Pill label={label} tone={SERVICE_STATUS_TONES[status]} />;
}

export function CriticalityPill({
  criticality,
  label,
}: {
  criticality: string;
  label: string;
}) {
  return <Pill label={label} tone={CRITICALITY_TONES[criticality]} />;
}

export function BiaStatusPill({
  status,
  label,
}: {
  status: string;
  label: string;
}) {
  return <Pill label={label} tone={BIA_STATUS_TONES[status]} />;
}

export function ImpactSeverityPill({
  severity,
  label,
}: {
  severity: string;
  label: string;
}) {
  return <Pill label={label} tone={IMPACT_TONES[severity]} />;
}

/** Compact metric block used in the continuity headers. */
export function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-card px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", tone)}>
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Labelled form control wrapper used by both BCM forms. */
export function Field({
  label,
  hint,
  htmlFor,
  className,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * The module-wide honesty statement. A reviewed BIA is an analysis of recorded
 * impacts and objectives — never a tested continuity plan, a recovery exercise
 * or a resilience score.
 */
export function BcmDisclaimer({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        "flex items-start gap-2 text-xs text-muted-foreground",
        className,
      )}
    >
      <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        A business impact analysis records assessed impact and recovery
        objectives for one service. It is
        <strong className="font-medium"> not</strong> a tested business
        continuity or disaster-recovery plan, and no readiness or resilience
        score is derived from completed forms.
      </span>
    </p>
  );
}
