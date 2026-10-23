import { useState } from "react";
import { useQuery } from "convex/react";
import { useNavigate } from "react-router";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AppLayout } from "@/components/iitams/AppLayout";
import { Breadcrumbs, PageHeader } from "@/components/iitams/PageHeader";
import {
  EmptyState,
  ListSkeleton,
  SearchFilterBar,
} from "@/components/iitams/audit/ListPageShell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import {
  BCM_PLAN_STATUSES,
  BCM_PLAN_STATUS_LABELS,
  BCM_PRIORITIES,
  BCM_PRIORITY_LABELS,
  type BcmPlanStatus,
  type BcmPriority,
} from "@/lib/bcm";
import {
  BcmBoundary,
  BcmDisclaimer,
  BcmUnauthorized,
  Field,
  Metric,
  PlanStatusPill,
} from "./BcmPrimitives";
import { PlanFormDialog, emptyPlanValues } from "./BcmPlanForm";
import { ChevronLeft, ChevronRight, FileText, Plus } from "lucide-react";

/**
 * /bcm/plans — Business Continuity Batch 2: continuity plan register.
 * ==================================================================
 * Lists every plan the caller's organization has recorded, with its lifecycle
 * status, the services it covers, the baseline it relies on and its open
 * recovery gaps. Reads require bcm.view; authoring requires bcm.manage, and the
 * server remains authoritative for both.
 */

type PlanRow = {
  _id: Id<"continuityPlans">;
  reference: string;
  title: string;
  status: BcmPlanStatus;
  statusLabel: string;
  version: number;
  primaryService: { reference: string; name: string } | null;
  serviceCount: number;
  ownerLabel: string;
  recoveryPriority: BcmPriority;
  recoveryPriorityLabel: string;
  reviewDueAt: number;
  reviewOverdue: boolean;
  baseline: { biaReference: string | null; biaVersion: number | null };
  strategies: number;
  openGaps: number;
};

const PAGE_SIZE = 25;

function PlansRegister() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [priority, setPriority] = useState("all");
  const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createdRef, setCreatedRef] = useState<string | null>(null);
  const navigate = useNavigate();

  const data = useQuery(api.continuityPlans.listPlans, {
    search: search || undefined,
    status: status === "all" ? undefined : status,
    priority: priority === "all" ? undefined : (priority as BcmPriority),
    limit: PAGE_SIZE,
    cursor: cursors[pageIndex],
  });
  const options = useQuery(api.continuityPlans.planFormOptions, {});

  const resetPaging = (fn: () => void) => {
    setPageIndex(0);
    setCursors([undefined]);
    fn();
  };

  const rows: PlanRow[] = (data?.rows ?? []) as PlanRow[];
  const canManage = data?.canManage ?? false;

  return (
    <>
      <PageHeader
        eyebrow="Business Continuity"
        title="Continuity plans"
        description="Versioned, independently reviewed continuity plans: the services they cover, the recovery strategies documented for them and the gaps that remain open."
        actions={
          canManage ? (
            <Button
              onClick={() => {
                setCreatedRef(null);
                setCreating(true);
              }}
              data-testid="bcm-plan-new"
            >
              <Plus className="mr-2 size-4" aria-hidden />
              New plan
            </Button>
          ) : undefined
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Plans recorded"
          value={data?.counts.total ?? "—"}
          hint={data ? `${data.counts.draft} draft` : undefined}
        />
        <Metric
          label="Approved"
          value={data?.counts.approved ?? "—"}
          hint={data ? `${data.counts.inReview} awaiting review` : undefined}
          tone="text-success"
        />
        <Metric
          label="Returned for revision"
          value={data?.counts.returned ?? "—"}
          hint="Reviewer rejected the submitted version"
        />
        <Metric
          label="Open recovery gaps"
          value={data?.counts.openGaps ?? "—"}
          hint="Recorded gaps not yet resolved or accepted"
          tone={data && data.counts.openGaps > 0 ? "text-critical" : undefined}
        />
      </div>

      {data?.counts.truncated ? (
        <p className="mb-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          Scope limitation: the register counts were computed over the first
          1,000 plans. Counts are partial and are not presented as exact totals.
        </p>
      ) : null}

      <SearchFilterBar
        search={search}
        onSearch={(value) => resetPaging(() => setSearch(value))}
        searchPlaceholder="Search reference, title, purpose, owner or service…"
        filters={[
          {
            label: "Status",
            value: status,
            options: [
              { value: "all", label: "All statuses" },
              ...BCM_PLAN_STATUSES.map((value) => ({
                value,
                label: BCM_PLAN_STATUS_LABELS[value],
              })),
            ],
            onChange: (value) => resetPaging(() => setStatus(value)),
          },
          {
            label: "Priority",
            value: priority,
            options: [
              { value: "all", label: "All priorities" },
              ...BCM_PRIORITIES.map((value) => ({
                value,
                label: BCM_PRIORITY_LABELS[value],
              })),
            ],
            onChange: (value) => resetPaging(() => setPriority(value)),
          },
        ]}
      />

      {createdRef ? (
        <p
          className="mb-4 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success"
          role="status"
        >
          Continuity plan {createdRef} created as a draft. Open it to document
          recovery strategies and gaps.
        </p>
      ) : null}

      {!data ? (
        <ListSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={
            search || status !== "all" || priority !== "all"
              ? "No continuity plans match these filters"
              : "No continuity plans recorded yet"
          }
          description={
            canManage
              ? "Create a plan for a business service with an approved impact analysis, then document the strategies that would restore it."
              : "Continuity plans recorded by authorized users will appear here."
          }
        />
      ) : (
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Baseline</TableHead>
                <TableHead>Strategies</TableHead>
                <TableHead>Open gaps</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Review</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row._id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/bcm/plans/${row._id}`)}
                  data-testid={`bcm-plan-row-${row.reference}`}
                >
                  <TableCell className="font-mono text-xs">
                    {row.reference}
                    <span className="ml-1 text-muted-foreground">v{row.version}</span>
                  </TableCell>
                  <TableCell>
                    <p className="font-medium">{row.title}</p>
                    <p className="text-xs text-muted-foreground">
                      Owner {row.ownerLabel}
                    </p>
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.primaryService?.name ?? "Service unavailable"}
                    {row.serviceCount > 1 ? (
                      <span className="ml-1 text-xs text-muted-foreground">
                        +{row.serviceCount - 1}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-sm">{row.recoveryPriorityLabel}</TableCell>
                  <TableCell className="text-xs">
                    {row.baseline.biaReference
                      ? `${row.baseline.biaReference} v${row.baseline.biaVersion}`
                      : "None linked"}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">{row.strategies}</TableCell>
                  <TableCell
                    className={`text-sm tabular-nums ${row.openGaps > 0 ? "font-medium text-critical" : ""}`}
                  >
                    {row.openGaps}
                  </TableCell>
                  <TableCell>
                    <PlanStatusPill status={row.status} label={row.statusLabel} />
                  </TableCell>
                  <TableCell
                    className={`text-xs ${row.reviewOverdue ? "font-medium text-critical" : "text-muted-foreground"}`}
                  >
                    {formatDate(row.reviewDueAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {data && (pageIndex > 0 || data.hasMore) ? (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-xs text-muted-foreground">
            Page {pageIndex + 1}
            {data.counts.truncated
              ? " · register exceeds the 1,000-plan count window"
              : ` · ${data.counts.total} recorded in total`}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pageIndex === 0}
              onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
            >
              <ChevronLeft className="mr-1 size-4" aria-hidden />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!data.hasMore}
              onClick={() => {
                if (!data.nextCursor) return;
                setCursors((prev) => {
                  const next = prev.slice(0, pageIndex + 1);
                  next.push(data.nextCursor ?? undefined);
                  return next;
                });
                setPageIndex((index) => index + 1);
              }}
            >
              Next
              <ChevronRight className="ml-1 size-4" aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}

      <Field
        label="Lifecycle"
        hint="Draft → submitted for review → approved (or returned for revision). An approved version is frozen: corrections open a numbered revision that must be reviewed again."
        className="mt-6"
      >
        <p className="text-xs text-muted-foreground">
          A plan record is documentation, not evidence that recovery has been
          exercised.
        </p>
      </Field>

      <BcmDisclaimer className="mt-4" />

      {creating && options ? (
        <PlanFormDialog
          open={creating}
          onOpenChange={setCreating}
          services={options.services}
          bias={options.bias}
          members={options.members}
          initial={emptyPlanValues(
            options.services,
            options.members,
            String(options.currentUserId),
          )}
          onSaved={(planId) => {
            setCreatedRef(`created`);
            navigate(`/bcm/plans/${planId}`);
          }}
        />
      ) : null}
    </>
  );
}

export function BcmPlansPage({ path }: { path: string }) {
  const session = useQuery(api.session.getSession, {});
  if (session && !session.permissions?.bcm) return <BcmUnauthorized path={path} />;

  return (
    <AppLayout>
      <Breadcrumbs path={path} />
      <BcmBoundary title="Continuity plans">
        <PlansRegister />
      </BcmBoundary>
    </AppLayout>
  );
}
