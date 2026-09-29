import { useQuery } from "convex/react";
import type { LucideIcon } from "lucide-react";
import { Search, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { AppLayout } from "@/components/iitams/AppLayout";
import { Breadcrumbs, PageHeader } from "@/components/iitams/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Shared shell for Phase-2 audit module list pages: breadcrumbs, header,
 * search + filter bar, table, and the standard empty/loading/error states.
 * Permission-aware actions are passed in by each page.
 */

export function SearchFilterBar({
  search,
  onSearch,
  searchPlaceholder = "Search…",
  filters,
  className,
}: {
  search: string;
  onSearch: (value: string) => void;
  searchPlaceholder?: string;
  filters?: {
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
  }[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-4 flex flex-col gap-3 sm:flex-row sm:items-end",
        className,
      )}
    >
      <div className="relative flex-1 sm:max-w-sm">
        <Label htmlFor="audit-search" className="sr-only">
          Search
        </Label>
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          id="audit-search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={searchPlaceholder}
          className="pl-8"
        />
        {search && (
          <button
            type="button"
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground"
            onClick={() => onSearch("")}
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>
      {filters?.map((f) => (
        <div key={f.label} className="min-w-36">
          <Label className="sr-only" htmlFor={`filter-${f.label}`}>
            {f.label}
          </Label>
          <Select value={f.value} onValueChange={f.onChange}>
            <SelectTrigger id={`filter-${f.label}`} className="w-full">
              <SelectValue placeholder={f.label} />
            </SelectTrigger>
            <SelectContent>
              {f.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ))}
    </div>
  );
}

export interface Column<T> {
  header: string;
  className?: string;
  render: (row: T) => React.ReactNode;
}

/** Minimal table primitive with responsive card fallback styling. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border/70 bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/70 text-left">
            {columns.map((c) => (
              <th
                key={c.header}
                scope="col"
                className={cn(
                  "px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground",
                  c.className,
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                "border-b border-border/40 last:border-0",
                onRowClick && "cursor-pointer transition-colors hover:bg-muted/40",
              )}
            >
              {columns.map((c) => (
                <td key={c.header} className={cn("px-3 py-2.5 align-middle", c.className)}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <Empty className="rounded-lg border border-dashed border-border/80 bg-card/60">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

/** Error banner with retry — thrown Convex errors surface here. */
export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-critical/30 bg-critical/5 px-4 py-3 text-sm text-critical"
    >
      {message}
      {onRetry && (
        <Button variant="outline" size="sm" className="ml-3" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export interface ListPageShellProps {
  path: string;
  eyebrow: string;
  title: string;
  description: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

/** Standard page wrapper (AppLayout + breadcrumbs + header). */
export function ListPageShell({
  path,
  eyebrow,
  title,
  description,
  actions,
  children,
}: ListPageShellProps) {
  const demoFlag = useQuery(api.dashboard.executive, {});
  return (
    <AppLayout>
      <Breadcrumbs path={path} />
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
        actions={
          <>
            {demoFlag?.isDemoData && (
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Demo data
              </span>
            )}
            {actions}
          </>
        }
      />
      {children}
    </AppLayout>
  );
}
