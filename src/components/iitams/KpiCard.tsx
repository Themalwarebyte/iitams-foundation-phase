import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Info } from "lucide-react";
import { Link } from "react-router";

export interface KpiCardProps {
  /** Metric label, e.g. "Open findings" */
  label: string;
  /** Primary figure. */
  value: string | number;
  /** Optional unit/suffix rendered beside the value ("%", "of 25"...). */
  suffix?: string;
  icon: LucideIcon;
  /** Semantic tone for the icon tile. */
  tone?: "primary" | "success" | "warning" | "critical" | "info" | "neutral";
  /** Short interpretation, shown under the value. */
  hint?: string;
  /** Optional "why" explainer surfaced on hover/focus. */
  tooltip?: string;
  /** Optional destination for click-through. */
  href?: string;
  className?: string;
}

const TONES: Record<NonNullable<KpiCardProps["tone"]>, string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  warning: "bg-warning/15 text-foreground/90",
  critical: "bg-critical/10 text-critical",
  info: "bg-info/10 text-info",
  neutral: "bg-muted text-muted-foreground",
};

/**
 * Reusable KPI tile for the executive dashboard and module landing pages.
 * Renders as a link when `href` is provided.
 */
export function KpiCard({
  label,
  value,
  suffix,
  icon: Icon,
  tone = "primary",
  hint,
  tooltip,
  href,
  className,
}: KpiCardProps) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-lg",
            TONES[tone],
          )}
        >
          <Icon className="size-5" aria-hidden />
        </div>
        {tooltip && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`About ${label}`}
                  className="rounded-full p-1 text-muted-foreground/60 transition-colors hover:text-foreground"
                >
                  <Info className="size-3.5" aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-56 text-xs leading-5">
                {tooltip}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-3xl font-bold tracking-tight tabular-nums">
          {value}
        </span>
        {suffix && (
          <span className="text-sm font-medium text-muted-foreground">
            {suffix}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-sm font-medium text-foreground/90">{label}</p>
      {hint && <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p>}
    </>
  );

  const shell = cn(
    "border-border/70 shadow-none transition-colors",
    href && "hover:border-primary/40 hover:bg-accent/40",
    className,
  );

  if (href) {
    return (
      <Link to={href} className="focus-visible:outline-none">
        <Card className={cn(shell, "h-full cursor-pointer")}>
          <CardContent className="p-5">{body}</CardContent>
        </Card>
      </Link>
    );
  }

  return (
    <Card className={cn(shell, "h-full")}>
      <CardContent className="p-5">{body}</CardContent>
    </Card>
  );
}
