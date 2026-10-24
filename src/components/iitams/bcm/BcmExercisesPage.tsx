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
  BCM_EXERCISE_STATUSES,
  BCM_EXERCISE_STATUS_LABELS,
  BCM_EXERCISE_TYPES,
  BCM_EXERCISE_TYPE_LABELS,
  type BcmExerciseStatus,
  type BcmExerciseType,
} from "@/lib/bcm";
import {
  BcmBoundary,
  BcmUnauthorized,
  ExerciseDisclaimer,
  ExerciseStatusPill,
  Metric,
} from "./BcmPrimitives";
import { ExerciseFormDialog, emptyExerciseValues } from "./BcmExerciseForm";
import { ChevronLeft, ChevronRight, Plus, TestTube2 } from "lucide-react";

/**
 * /bcm/dr-tests — Business Continuity Batch 4.3: recovery exercise register.
 * ========================================================================
 * Every recorded exercise, the plan version it tests, its lifecycle state and
 * the findings it raised. Recording an exercise never runs one: this module is
 * a register of evidence and its independent review.
 */

type ExerciseRow = {
  _id: Id<"recoveryExercises">;
  reference: string;
  title: string;
  version: number;
  typeLabel: string;
  status: BcmExerciseStatus;
  statusLabel: string;
  planReference: string;
  planVersion: number;
  ownerLabel: string;
  facilitatorLabel: string;
  plannedStartAt: number;
  plannedEndAt: number;
  baseline: {
    biaReference: string | null;
    biaVersion: number | null;
    approved: boolean;
  };
  counts: {
    activities: number;
    performedActivities: number;
    measurements: number;
    strategies: number;
    findings: number;
    openFindings: number;
  };
};

const PAGE_SIZE = 25;

function ExercisesRegister() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [type, setType] = useState("all");
  const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  const data = useQuery(api.recoveryExercises.listExercises, {
    search: search || undefined,
    status: status === "all" ? undefined : status,
    type: type === "all" ? undefined : (type as BcmExerciseType),
    limit: PAGE_SIZE,
    cursor: cursors[pageIndex],
  });
  const options = useQuery(api.recoveryExercises.exerciseFormOptions, {});

  const resetPaging = (fn: () => void) => {
    setPageIndex(0);
    setCursors([undefined]);
    fn();
  };

  const rows: ExerciseRow[] = (data?.rows ?? []) as ExerciseRow[];
  const canManage = data?.canManage ?? false;
  const plans = (options?.plans ?? []) as Array<{
    _id: string;
    reference: string;
    title: string;
    version: number;
    biaReference: string | null;
    biaVersion: number | null;
    biaStatusAtLink: string | null;
  }>;
  const members = options?.members ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Business Continuity"
        title="Recovery exercises"
        description="Recorded tabletop exercises, walkthroughs, communications exercises, recovery simulations and controlled recovery tests — with the plan version tested, what was observed, what was measured and the independent review that accepted it."
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)} data-testid="bcm-exercise-new">
              <Plus className="mr-2 size-4" aria-hidden />
              Plan exercise
            </Button>
          ) : undefined
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Exercises recorded"
          value={data?.counts.total ?? "—"}
          hint={
            data
              ? `${data.counts.planned} planned · ${data.counts.scheduled} scheduled`
              : undefined
          }
        />
        <Metric
          label="In progress"
          value={data?.counts.inProgress ?? "—"}
          hint={
            data
              ? `${data.counts.completed} completed · ${data.counts.inReview} awaiting review`
              : undefined
          }
        />
        <Metric
          label="Reviewed and accepted"
          value={data?.counts.reviewed ?? "—"}
          hint="Independently reviewed records only"
          tone="text-success"
        />
        <Metric
          label="Open exercise findings"
          value={data?.counts.openFindings ?? "—"}
          hint="Open, in progress or awaiting verification"
          tone={data && data.counts.openFindings > 0 ? "text-critical" : undefined}
        />
      </div>

      {data?.counts.truncated ? (
        <p className="mb-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          Scope limitation: the register counts were computed over the first
          1,000 exercises. Counts are partial and are not presented as exact
          totals.
        </p>
      ) : null}

      <SearchFilterBar
        search={search}
        onSearch={(value) => resetPaging(() => setSearch(value))}
        searchPlaceholder="Search reference, title, plan, owner or facilitator…"
        filters={[
          {
            label: "Status",
            value: status,
            options: [
              { value: "all", label: "All statuses" },
              ...BCM_EXERCISE_STATUSES.map((value) => ({
                value,
                label: BCM_EXERCISE_STATUS_LABELS[value],
              })),
            ],
            onChange: (value) => resetPaging(() => setStatus(value)),
          },
          {
            label: "Type",
            value: type,
            options: [
              { value: "all", label: "All types" },
              ...BCM_EXERCISE_TYPES.map((value) => ({
                value,
                label: BCM_EXERCISE_TYPE_LABELS[value],
              })),
            ],
            onChange: (value) => resetPaging(() => setType(value)),
          },
        ]}
      />

      {!data ? (
        <ListSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={TestTube2}
          title={
            search || status !== "all" || type !== "all"
              ? "No exercises match these filters"
              : "No recovery exercises recorded yet"
          }
          description={
            canManage
              ? "Plan a tabletop, walkthrough, communications exercise or controlled recovery test against an approved continuity plan. Recording one does not execute recovery."
              : "Recovery exercises recorded by authorized users will appear here."
          }
        />
      ) : (
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Exercise</TableHead>
                <TableHead>Plan tested</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Evidence</TableHead>
                <TableHead>Findings</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row._id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/bcm/dr-tests/${row._id}`)}
                  data-testid={`bcm-exercise-row-${row.reference}`}
                >
                  <TableCell className="font-mono text-xs">
                    {row.reference}
                    <span className="ml-1 text-muted-foreground">v{row.version}</span>
                  </TableCell>
                  <TableCell>
                    <p className="font-medium">{row.title}</p>
                    <p className="text-xs text-muted-foreground">
                      Owner {row.ownerLabel} · Facilitator {row.facilitatorLabel}
                    </p>
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.planReference} v{row.planVersion}
                    <p className="text-muted-foreground">
                      {row.baseline.biaReference
                        ? `Baseline ${row.baseline.biaReference} v${row.baseline.biaVersion}${row.baseline.approved ? "" : " (not approved)"}`
                        : "No baseline linked"}
                    </p>
                  </TableCell>
                  <TableCell className="text-sm">{row.typeLabel}</TableCell>
                  <TableCell className="text-xs">
                    {formatDate(row.plannedStartAt)} → {formatDate(row.plannedEndAt)}
                  </TableCell>
                  <TableCell className="text-xs">
                    <p>
                      {row.counts.performedActivities}/{row.counts.activities} activities
                      performed
                    </p>
                    <p className="text-muted-foreground">
                      {row.counts.measurements} measurement(s) · {row.counts.strategies}{" "}
                      strategy(ies)
                    </p>
                  </TableCell>
                  <TableCell
                    className={`text-sm tabular-nums ${row.counts.openFindings > 0 ? "font-medium text-critical" : ""}`}
                  >
                    {row.counts.openFindings} open
                    <span className="ml-1 text-xs text-muted-foreground">
                      of {row.counts.findings}
                    </span>
                  </TableCell>
                  <TableCell>
                    <ExerciseStatusPill status={row.status} label={row.statusLabel} />
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
              ? " · register exceeds the 1,000-exercise count window"
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
              disabled={!data.hasMore || data.nextCursor === null}
              onClick={() => {
                if (data.nextCursor === null) return;
                setCursors((current) => {
                  const next = [...current];
                  next[pageIndex + 1] = data.nextCursor ?? undefined;
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

      <div className="mt-8">
        <ExerciseDisclaimer />
      </div>

      {canManage && options ? (
        <ExerciseFormDialog
          open={creating}
          onOpenChange={setCreating}
          plans={plans}
          members={members}
          initial={emptyExerciseValues(plans, members, options.currentUserId)}
          onSaved={(result) => {
            setCreating(false);
            if (result.exerciseId) {
              navigate(`/bcm/dr-tests/${result.exerciseId}`);
            }
          }}
        />
      ) : null}
    </>
  );
}

export function BcmExercisesPage({ path }: { path: string }) {
  const session = useQuery(api.session.getSession, {});
  if (session && !session.permissions?.bcm) return <BcmUnauthorized path={path} />;

  return (
    <AppLayout>
      <Breadcrumbs path={path} />
      <BcmBoundary title="Recovery exercises">
        <ExercisesRegister />
      </BcmBoundary>
    </AppLayout>
  );
}
