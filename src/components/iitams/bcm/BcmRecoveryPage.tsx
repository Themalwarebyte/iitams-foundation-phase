import { useQuery } from "convex/react";
import { Link } from "react-router";
import { api } from "@/convex/_generated/api";
import { AppLayout } from "@/components/iitams/AppLayout";
import { Breadcrumbs, PageHeader } from "@/components/iitams/PageHeader";
import { EmptyState, ListSkeleton } from "@/components/iitams/audit/ListPageShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import { formatMinutes, type BcmCriticality } from "@/lib/bcm";
import {
  BcmBoundary,
  BcmDisclaimer,
  BcmUnauthorized,
  BiaStatusPill,
  CriticalityPill,
  Metric,
} from "./BcmPrimitives";
import { Fingerprint, Timer } from "lucide-react";

/**
 * /bcm/rto-rpo — recovery objectives per business service.
 * =======================================================
 * A truthful summary of the objectives recorded in each service's current BIA.
 * Durations are stored in normalized minutes and rendered from those values, so
 * the summary can never drift from the record. Nothing here is a readiness
 * score or a claim that recovery has been tested.
 */

type ObjectiveRow = {
  biaId: string;
  serviceReference: string | null;
  serviceName: string;
  criticality: BcmCriticality | null;
  reference: string;
  version: number;
  status: string;
  rtoMinutes: number;
  rtoLabel: string;
  rpoMinutes: number | null;
  rpoLabel: string;
  mtpdMinutes: number | null;
  mtpdLabel: string;
  minimumServiceLevel: string;
  recoveryPriority: string;
  recoveryPriorityLabel: string;
  reviewDueAt: number;
  overdue: boolean;
};

function RecoverySummary() {
  const data = useQuery(api.businessImpactAnalyses.recoveryObjectives, {});

  if (!data) return <ListSkeleton rows={6} />;

  const rows = data.objectives as ObjectiveRow[];

  return (
    <>
      <PageHeader
        eyebrow="Business Continuity"
        title="Recovery objectives"
        description="The recovery time, recovery point and maximum tolerable disruption recorded for each active business service, with recovery priority and the minimum acceptable service level during a disruption."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Services with objectives"
          value={data.counts.servicesWithObjectives}
          hint="Latest non-superseded BIA per service"
        />
        <Metric
          label="P1 services"
          value={data.counts.p1}
          hint="Restore first"
          tone="text-critical"
        />
        <Metric
          label="RPO recorded"
          value={data.counts.rpoRecorded}
          hint="Data recovery objective present"
        />
        <Metric
          label="Overdue review"
          value={data.counts.overdue}
          hint="Approved BIA past its review date"
        />
      </div>

      {data.truncated ? (
        <p className="mb-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          Scope limitation: this summary covers the first 2,000 services and
          2,000 analyses. The totals above are partial and are not presented as
          complete coverage.
        </p>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={Fingerprint}
          title="No recovery objectives recorded"
          description="Objectives are recorded inside a business impact analysis. Register a service and record its BIA to establish an RTO and, where data recovery matters, an RPO."
        />
      ) : (
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Service</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>RTO</TableHead>
                <TableHead>RPO</TableHead>
                <TableHead>MTPD</TableHead>
                <TableHead>Analysis</TableHead>
                <TableHead>Review due</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.biaId}>
                  <TableCell>
                    <p className="font-medium">{row.serviceName}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.serviceReference ?? "—"}
                    </p>
                    {row.criticality ? (
                      <div className="mt-1">
                        <CriticalityPill
                          criticality={row.criticality}
                          label={row.criticality}
                        />
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.recoveryPriorityLabel}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {formatMinutes(row.rtoMinutes)}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {row.rpoMinutes === null
                      ? "Not recorded"
                      : formatMinutes(row.rpoMinutes)}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {row.mtpdMinutes === null
                      ? "—"
                      : formatMinutes(row.mtpdMinutes)}
                  </TableCell>
                  <TableCell>
                    <p className="font-mono text-xs">
                      {row.reference} v{row.version}
                    </p>
                    <div className="mt-1">
                      <BiaStatusPill status={row.status} label={row.status} />
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    <span className={row.overdue ? "text-critical" : undefined}>
                      {formatDate(row.reviewDueAt)}
                      {row.overdue ? " · overdue" : ""}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" asChild>
          <Link to="/bcm/bia">
            <Timer className="mr-2 size-4" aria-hidden />
            Open the business impact analyses
          </Link>
        </Button>
        <p className="text-xs text-muted-foreground">
          The minimum acceptable service level for each service is recorded in
          its BIA.
        </p>
      </div>

      <BcmDisclaimer className="mt-6" />
    </>
  );
}

export function BcmRecoveryPage({ path }: { path: string }) {
  const session = useQuery(api.session.getSession, {});
  if (session && !session.permissions?.bcm)
    return <BcmUnauthorized path={path} />;

  return (
    <AppLayout>
      <Breadcrumbs path={path} />
      <BcmBoundary title="Recovery objectives">
        <RecoverySummary />
      </BcmBoundary>
    </AppLayout>
  );
}
