import { Component, type ReactNode } from "react";
import { AppLayout } from "@/components/iitams/AppLayout";
import { Breadcrumbs, PageHeader } from "@/components/iitams/PageHeader";
import { EmptyState, ErrorState } from "@/components/iitams/audit/ListPageShell";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { LockKeyhole } from "lucide-react";

/**
 * Shared presentation helpers for the Cybersecurity Assurance module.
 * Deliberately small: a crash guard, an honest unauthorized state and the
 * severity/status pills that both registers use.
 */

export class CyberBoundary extends Component<
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

/** Honest state for a role without cyber.view. */
export function CyberUnauthorized({ path }: { path: string }) {
  return (
    <AppLayout>
      <Breadcrumbs path={path} />
      <PageHeader
        eyebrow="Cybersecurity Assurance"
        title="Cybersecurity Assurance is not available for your role"
        description="Assessment and vulnerability registers require the cyber.view permission. Ask an administrator if you need access."
      />
      <EmptyState
        icon={LockKeyhole}
        title="Access denied"
        description="Your role does not include cyber.view, so no assessment or vulnerability data is shown."
      />
    </AppLayout>
  );
}

const SEVERITY_TONES: Record<string, string> = {
  critical: "bg-critical/10 text-critical border-critical/30",
  high: "bg-warning/20 text-foreground/90 border-warning/45",
  medium: "bg-warning/10 text-foreground/90 border-warning/30",
  low: "bg-info/10 text-info border-info/25",
  informational: "bg-muted text-muted-foreground border-border",
};

const VULNERABILITY_TONES: Record<string, string> = {
  open: "bg-info/10 text-info border-info/25",
  confirmed: "bg-warning/15 text-foreground/90 border-warning/40",
  in_remediation: "bg-warning/15 text-foreground/90 border-warning/40",
  remediated: "bg-info/10 text-info border-info/25",
  verified: "bg-success/10 text-success border-success/25",
  risk_accepted: "bg-muted text-muted-foreground border-border",
  false_positive: "bg-muted text-muted-foreground border-border",
  closed: "bg-success/10 text-success border-success/25",
};

const ASSESSMENT_TONES: Record<string, string> = {
  scheduled: "bg-info/10 text-info border-info/25",
  in_progress: "bg-warning/15 text-foreground/90 border-warning/40",
  completed: "bg-success/10 text-success border-success/25",
  cancelled: "bg-muted text-muted-foreground border-border",
};

const ACTION_TONES: Record<string, string> = {
  open: "bg-info/10 text-info border-info/25",
  in_progress: "bg-warning/15 text-foreground/90 border-warning/40",
  completed: "bg-info/10 text-info border-info/25",
  verified: "bg-success/10 text-success border-success/25",
  closed: "bg-success/10 text-success border-success/25",
  cancelled: "bg-muted text-muted-foreground border-border",
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

export function SeverityPill({
  severity,
  label,
}: {
  severity: string;
  label: string;
}) {
  return <Pill label={label} tone={SEVERITY_TONES[severity]} />;
}

export function VulnerabilityStatusPill({
  status,
  label,
}: {
  status: string;
  label: string;
}) {
  return <Pill label={label} tone={VULNERABILITY_TONES[status]} />;
}

export function AssessmentStatusPill({
  status,
  label,
}: {
  status: string;
  label: string;
}) {
  return <Pill label={label} tone={ASSESSMENT_TONES[status]} />;
}

export function ActionStatusPill({
  status,
  label,
}: {
  status: string;
  label: string;
}) {
  return <Pill label={label} tone={ACTION_TONES[status]} />;
}

/** Compact metric block used in the register headers. */
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
