import { Link } from "react-router";
import { ChevronRight, Home, Construction } from "lucide-react";
import { NAV_INDEX } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export interface Crumb {
  label: string;
  href?: string;
}

/** Breadcrumbs with a fixed Home root; auto-derives from the nav index. */
export function Breadcrumbs({
  path,
  overrides,
  className,
}: {
  path: string;
  overrides?: Crumb[];
  className?: string;
}) {
  const entry = NAV_INDEX.get(path);
  const crumbs: Crumb[] =
    overrides ??
    [
      ...(entry ? [{ label: entry.group }] : []),
      { label: entry?.label ?? "Page" },
    ];

  return (
    <nav aria-label="Breadcrumb" className={cn("mb-5", className)}>
      <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        <li className="flex items-center gap-1">
          <Link
            to="/dashboard"
            className="flex items-center gap-1 rounded-sm hover:text-foreground"
          >
            <Home className="size-3.5" aria-hidden />
            <span className="sr-only sm:not-sr-only">Home</span>
          </Link>
        </li>
        {crumbs.map((crumb, i) => (
          <li key={`${crumb.label}-${i}`} className="flex items-center gap-1">
            <ChevronRight className="size-3.5 opacity-50" aria-hidden />
            {i === crumbs.length - 1 || !crumb.href ? (
              <span
                aria-current={i === crumbs.length - 1 ? "page" : undefined}
                className={cn(
                  i === crumbs.length - 1
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {crumb.label}
              </span>
            ) : (
              <Link to={crumb.href} className="rounded-sm hover:text-foreground">
                {crumb.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Standard page heading block with eyebrow, title and description. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between",
        className,
      )}
    >
      <div>
        {eyebrow && (
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">
            {eyebrow}
          </p>
        )}
        <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-[1.75rem]">
          {title}
        </h1>
        {description && (
          <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Phase-2 scaffolding view shown for not-yet-functional modules. */
export function ModulePlaceholder({
  icon: Icon,
  title,
  description,
  plannedFor = "Phase 2",
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  plannedFor?: string;
}) {
  return (
    <Card className="border-dashed border-border/80 bg-card/60 shadow-none">
      <CardHeader>
        <div className="flex items-center gap-3">
          {Icon && (
            <div className="flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="size-5" aria-hidden />
            </div>
          )}
          <div>
            <CardTitle className="text-lg">{title}</CardTitle>
            <CardDescription className="mt-1">{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <Badge variant="secondary" className="gap-1.5">
          <Construction className="size-3.5" aria-hidden />
          Planned for {plannedFor}
        </Badge>
        <p className="text-sm text-muted-foreground">
          The data model, permissions and navigation for this module already
          exist — functionality will be activated here in a subsequent phase
          without further schema changes.
        </p>
      </CardContent>
    </Card>
  );
}

export function ComingSoonActions({ backTo = "/dashboard" }: { backTo?: string }) {
  return (
    <Button variant="outline" asChild>
      <Link to={backTo}>Back to dashboard</Link>
    </Button>
  );
}
