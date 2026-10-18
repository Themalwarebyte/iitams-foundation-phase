import { Component, type ReactNode } from "react";
import { AppLayout } from "@/components/iitams/AppLayout";
import { Breadcrumbs, PageHeader } from "@/components/iitams/PageHeader";
import { EmptyState, ErrorState } from "@/components/iitams/audit/ListPageShell";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { LockKeyhole, ShieldAlert } from "lucide-react";

/**
 * Shared presentation helpers for the Compliance module (Phase 3C Batch 1).
 * Kept deliberately small: both compliance pages need the same crash guard,
 * unauthorized state and status pill, and nothing else is abstracted.
 */

/** Test-friendly crash guard so a query error never blanks the page. */
export class ComplianceBoundary extends Component<
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
          <ErrorState message={`${this.props.title} could not load: ${this.state.message}`} />
        </AppLayout>
      );
    }
    return this.props.children;
  }
}

/** Honest state for a role without compliance.view. */
export function ComplianceUnauthorized() {
  return (
    <AppLayout>
      <Breadcrumbs path="/compliance/frameworks" />
      <PageHeader
        eyebrow="Compliance"
        title="Compliance is not available for your role"
        description="Framework and control registers require the compliance.view permission. Ask an administrator if you need access."
      />
      <EmptyState
        icon={LockKeyhole}
        title="Access denied"
        description="Your role does not include compliance.view, so no framework or control data is shown."
      />
    </AppLayout>
  );
}

const FRAMEWORK_STATUS_TONES: Record<string, string> = {
  active: "bg-success/10 text-success border-success/25",
  planned: "bg-info/10 text-info border-info/25",
  retired: "bg-muted text-muted-foreground border-border",
};

const IMPLEMENTATION_TONES: Record<string, string> = {
  implemented: "bg-success/10 text-success border-success/25",
  in_progress: "bg-info/10 text-info border-info/25",
  planned: "bg-warning/15 text-foreground/90 border-warning/40",
  not_implemented: "bg-muted text-muted-foreground border-border",
  not_applicable: "bg-muted text-muted-foreground border-border",
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

export function FrameworkStatusPill({
  status,
  label,
}: {
  status: string;
  label: string;
}) {
  return <Pill label={label} tone={FRAMEWORK_STATUS_TONES[status]} />;
}

export function ImplementationStatusPill({
  status,
  label,
}: {
  status: string;
  label: string;
}) {
  return <Pill label={label} tone={IMPLEMENTATION_TONES[status]} />;
}

/** Legend explaining that implementation is not a test result. */
export function ImplementationDisclaimer({ className }: { className?: string }) {
  return (
    <p className={cn("flex items-start gap-2 text-xs text-muted-foreground", className)}>
      <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        Implementation status records how far a control has been deployed. It is
        <strong className="font-medium"> not</strong> a test result and not a
        compliance score: control testing, evidence mapping and assessment
        percentages arrive in a later batch.
      </span>
    </p>
  );
}
