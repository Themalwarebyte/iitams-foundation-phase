import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  BCM_CRITICALITIES,
  BCM_CRITICALITY_LABELS,
  BCM_SERVICE_STATUSES,
  BCM_SERVICE_STATUS_LABELS,
  type BcmCriticality,
  type BcmServiceStatus,
} from "@/lib/bcm";
import {
  BcmBoundary,
  BcmDisclaimer,
  BcmUnauthorized,
  BiaStatusPill,
  CriticalityPill,
  Field,
  Metric,
  ServiceStatusPill,
} from "./BcmPrimitives";
import {
  Building2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
} from "lucide-react";
import { toast } from "sonner";

/**
 * /bcm/critical-services — Business Continuity Batch 1: service register.
 * ======================================================================
 * Organization-scoped register of the business services/processes that need
 * continuity planning. Reads need bcm.view; every write needs bcm.manage plus
 * an active membership, re-checked server-side. Users without bcm.manage get a
 * read-only register.
 *
 * The register deliberately stores descriptive ICT dependencies: IITAMS has no
 * canonical asset register yet, so no foreign key is invented here.
 */

type ServiceRow = {
  _id: Id<"businessServices">;
  reference: string;
  name: string;
  description: string;
  department: string;
  ownerUserId: Id<"users">;
  ownerLabel: string;
  operationalStatus: BcmServiceStatus;
  statusLabel: string;
  criticality: BcmCriticality;
  criticalityLabel: string;
  ictDependencies: string | null;
  keyDependencies: string;
  singlePointsOfFailure: string | null;
  createdAt: number;
  updatedAt: number;
};

const PAGE_SIZE = 25;

const EMPTY_FORM = {
  name: "",
  description: "",
  department: "",
  ownerUserId: "",
  operationalStatus: "active" as BcmServiceStatus,
  criticality: "medium" as BcmCriticality,
  ictDependencies: "",
  keyDependencies: "",
  singlePointsOfFailure: "",
};

type ServiceFormState = typeof EMPTY_FORM;

function ServiceFormDialog({
  service,
  members,
  onClose,
}: {
  service: ServiceRow | null;
  members: Array<{ userId: Id<"users">; label: string }>;
  onClose: () => void;
}) {
  const createService = useMutation(api.businessServices.createService);
  const updateService = useMutation(api.businessServices.updateService);
  const [form, setForm] = useState<ServiceFormState>(() =>
    service
      ? {
          name: service.name,
          description: service.description,
          department: service.department,
          ownerUserId: String(service.ownerUserId),
          operationalStatus: service.operationalStatus,
          criticality: service.criticality,
          ictDependencies: service.ictDependencies ?? "",
          keyDependencies: service.keyDependencies,
          singlePointsOfFailure: service.singlePointsOfFailure ?? "",
        }
      : EMPTY_FORM,
  );
  const [busy, setBusy] = useState(false);

  function set<K extends keyof ServiceFormState>(
    key: K,
    value: ServiceFormState[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit() {
    if (!form.ownerUserId) {
      toast.error("Select the responsible owner for this service.");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: form.name,
        description: form.description,
        department: form.department,
        ownerUserId: form.ownerUserId as Id<"users">,
        operationalStatus: form.operationalStatus,
        criticality: form.criticality,
        ictDependencies: form.ictDependencies || undefined,
        keyDependencies: form.keyDependencies,
        singlePointsOfFailure: form.singlePointsOfFailure || undefined,
      };
      if (service) {
        await updateService({ serviceId: service._id, ...payload });
        toast.success(`Service ${service.reference} updated.`);
      } else {
        const result = await createService(payload);
        toast.success(`Service ${result.reference} registered.`);
      }
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {service
              ? `Amend ${service.reference}`
              : "Register a business service or process"}
          </DialogTitle>
          <DialogDescription>
            Record what the service is, who owns it and how critical it is.
            Impact and recovery objectives are recorded in the business impact
            analysis.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <Field label="Name" htmlFor="svc-name">
            <Input
              id="svc-name"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Citizen payments processing"
            />
          </Field>
          <Field label="Description" htmlFor="svc-description">
            <Textarea
              id="svc-description"
              rows={3}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="What the service delivers, to whom, and through which channels."
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Department / business function" htmlFor="svc-dept">
              <Input
                id="svc-dept"
                value={form.department}
                onChange={(e) => set("department", e.target.value)}
                placeholder="Finance & revenue"
              />
            </Field>
            <Field label="Responsible owner" htmlFor="svc-owner">
              <Select
                value={form.ownerUserId}
                onValueChange={(value) => set("ownerUserId", value)}
              >
                <SelectTrigger id="svc-owner">
                  <SelectValue placeholder="Select an active member" />
                </SelectTrigger>
                <SelectContent>
                  {members.map((member) => (
                    <SelectItem key={member.userId} value={member.userId}>
                      {member.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Operational status" htmlFor="svc-status">
              <Select
                value={form.operationalStatus}
                onValueChange={(value) =>
                  set("operationalStatus", value as BcmServiceStatus)
                }
              >
                <SelectTrigger id="svc-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BCM_SERVICE_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {BCM_SERVICE_STATUS_LABELS[status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Criticality classification" htmlFor="svc-criticality">
              <Select
                value={form.criticality}
                onValueChange={(value) =>
                  set("criticality", value as BcmCriticality)
                }
              >
                <SelectTrigger id="svc-criticality">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BCM_CRITICALITIES.map((level) => (
                    <SelectItem key={level} value={level}>
                      {BCM_CRITICALITY_LABELS[level]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field
            label="Related ICT systems or services (descriptive)"
            htmlFor="svc-ict"
            hint="IITAMS has no canonical asset register yet, so record the systems and providers by name. No asset record is created."
          >
            <Textarea
              id="svc-ict"
              rows={2}
              value={form.ictDependencies}
              onChange={(e) => set("ictDependencies", e.target.value)}
              placeholder="Payment switch (vendor-hosted), core banking API, SMTP relay"
            />
          </Field>
          <Field label="Key operational dependencies" htmlFor="svc-dependencies">
            <Textarea
              id="svc-dependencies"
              rows={3}
              value={form.keyDependencies}
              onChange={(e) => set("keyDependencies", e.target.value)}
              placeholder="People, suppliers, facilities, data feeds and interfaces the service depends on."
            />
          </Field>
          <Field
            label="Single points of failure (optional)"
            htmlFor="svc-spof"
          >
            <Textarea
              id="svc-spof"
              rows={2}
              value={form.singlePointsOfFailure}
              onChange={(e) => set("singlePointsOfFailure", e.target.value)}
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
            {service ? "Save changes" : "Register service"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ServiceDetailDialog({
  serviceId,
  canManage,
  members,
  onClose,
}: {
  serviceId: Id<"businessServices">;
  canManage: boolean;
  members: Array<{ userId: Id<"users">; label: string }>;
  onClose: () => void;
}) {
  const detail = useQuery(api.businessServices.getService, { serviceId });
  const [editing, setEditing] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {detail ? `${detail.service.reference} — ${detail.service.name}` : "Business service"}
          </DialogTitle>
          <DialogDescription>
            Description, ownership, dependencies and every BIA version recorded
            for this service.
          </DialogDescription>
        </DialogHeader>

        {!detail ? (
          <ListSkeleton rows={3} />
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <CriticalityPill
                criticality={detail.service.criticality}
                label={detail.service.criticalityLabel}
              />
              <ServiceStatusPill
                status={detail.service.operationalStatus}
                label={detail.service.statusLabel}
              />
              <span className="text-xs text-muted-foreground">
                Owner: {detail.service.ownerLabel} · {detail.service.department}
              </span>
            </div>

            <p className="text-sm leading-6 text-foreground/90">
              {detail.service.description}
            </p>

            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Key operational dependencies
                </dt>
                <dd className="mt-1 whitespace-pre-line">
                  {detail.service.keyDependencies}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Related ICT systems (descriptive)
                </dt>
                <dd className="mt-1 whitespace-pre-line">
                  {detail.service.ictDependencies ?? "Not recorded"}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Single points of failure
                </dt>
                <dd className="mt-1 whitespace-pre-line">
                  {detail.service.singlePointsOfFailure ?? "Not recorded"}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Recorded
                </dt>
                <dd className="mt-1">
                  {formatDate(detail.service.createdAt)} · updated{" "}
                  {formatDate(detail.service.updatedAt)}
                </dd>
              </div>
            </dl>

            <section>
              <h3 className="text-sm font-semibold">Business impact analyses</h3>
              {detail.bias.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  No BIA has been recorded for this service yet. A service
                  without a BIA has no documented recovery objective.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-border/60 rounded-md border border-border/60">
                  {detail.bias.map((bia) => (
                    <li
                      key={bia._id}
                      className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                    >
                      <span>
                        <span className="font-medium">{bia.reference}</span> v
                        {bia.version} — {bia.title}
                      </span>
                      <span className="flex items-center gap-2">
                        <BiaStatusPill status={bia.status} label={bia.status} />
                        <span className="text-xs text-muted-foreground">
                          Review due {formatDate(bia.reviewDueAt)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="text-sm font-semibold">History</h3>
              {detail.history.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  No history recorded.
                </p>
              ) : (
                <ul className="mt-2 space-y-2 text-sm">
                  {detail.history.map((event) => (
                    <li
                      key={event._id}
                      className="rounded-md border border-border/60 px-3 py-2"
                    >
                      <p>{event.summary}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {event.actorLabel} · {formatDate(event.createdAt)}
                        {event.reason ? ` · ${event.reason}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {canManage && detail ? (
            <Button
              onClick={() => setEditing(true)}
              data-testid="bcm-service-edit"
            >
              Amend service
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
      {editing && detail ? (
        <ServiceFormDialog
          service={detail.service}
          members={members}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </Dialog>
  );
}

function ServicesRegister() {
  const [search, setSearch] = useState("");
  const [criticality, setCriticality] = useState("all");
  const [status, setStatus] = useState("all");
  const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [selected, setSelected] = useState<Id<"businessServices"> | null>(null);
  const [creating, setCreating] = useState(false);

  const cursor = cursors[pageIndex];
  const data = useQuery(api.businessServices.listServices, {
    search: search || undefined,
    criticality:
      criticality === "all" ? undefined : (criticality as BcmCriticality),
    status: status === "all" ? undefined : (status as BcmServiceStatus),
    limit: PAGE_SIZE,
    cursor,
  });
  const options = useQuery(api.businessServices.formOptions, {});
  const summary = useQuery(api.businessImpactAnalyses.continuitySummary, {});

  const resetPaging = (fn: () => void) => {
    setPageIndex(0);
    setCursors([undefined]);
    fn();
  };

  const rows: ServiceRow[] = data?.rows ?? [];
  const canManage = data?.canManage ?? false;

  return (
    <>
      <PageHeader
        eyebrow="Business Continuity"
        title="Critical services and processes"
        description="The organization-scoped register of business services and processes that require continuity planning, their owners and their criticality."
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)} data-testid="bcm-service-new">
              <Plus className="mr-2 size-4" aria-hidden />
              Register service
            </Button>
          ) : undefined
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Registered services"
          value={summary?.services.total ?? "—"}
          hint={summary ? `${summary.services.active} not retired` : undefined}
        />
        <Metric
          label="High / critical"
          value={
            summary
              ? summary.services.critical + summary.services.high
              : "—"
          }
          hint="Criticality classification only"
          tone="text-critical"
        />
        <Metric
          label="Missing a BIA"
          value={summary?.coverage.missingBia ?? "—"}
          hint="Active services with no analysis"
        />
        <Metric
          label="Awaiting review"
          value={summary?.review.awaitingReview ?? "—"}
          hint={
            summary
              ? `${summary.review.overdueReassessment} approved BIAs overdue`
              : undefined
          }
        />
      </div>

      {summary?.truncated.services || summary?.truncated.bias ? (
        <p className="mb-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          Scope limitation: the summary was computed over the first 2,000
          records. Counts are partial and are not presented as exact totals.
        </p>
      ) : null}

      <SearchFilterBar
        search={search}
        onSearch={(value) => resetPaging(() => setSearch(value))}
        searchPlaceholder="Search reference, name, department or owner…"
        filters={[
          {
            label: "Criticality",
            value: criticality,
            options: [
              { value: "all", label: "All criticalities" },
              ...BCM_CRITICALITIES.map((level) => ({
                value: level,
                label: BCM_CRITICALITY_LABELS[level],
              })),
            ],
            onChange: (value) => resetPaging(() => setCriticality(value)),
          },
          {
            label: "Status",
            value: status,
            options: [
              { value: "all", label: "All statuses" },
              ...BCM_SERVICE_STATUSES.map((value) => ({
                value,
                label: BCM_SERVICE_STATUS_LABELS[value],
              })),
            ],
            onChange: (value) => resetPaging(() => setStatus(value)),
          },
        ]}
      />

      {!data ? (
        <ListSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={
            search || criticality !== "all" || status !== "all"
              ? "No services match these filters"
              : "No business services registered yet"
          }
          description={
            canManage
              ? "Register the services and processes whose disruption would matter, then record a business impact analysis for each one."
              : "No continuity register has been recorded for your organization yet."
          }
        />
      ) : (
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Service / process</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Criticality</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Recorded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row._id}
                  className="cursor-pointer"
                  onClick={() => setSelected(row._id)}
                  data-testid={`bcm-service-row-${row.reference}`}
                >
                  <TableCell className="font-mono text-xs">{row.reference}</TableCell>
                  <TableCell>
                    <p className="font-medium">{row.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.department}
                    </p>
                  </TableCell>
                  <TableCell className="text-sm">{row.ownerLabel}</TableCell>
                  <TableCell>
                    <CriticalityPill
                      criticality={row.criticality}
                      label={row.criticalityLabel}
                    />
                  </TableCell>
                  <TableCell>
                    <ServiceStatusPill
                      status={row.operationalStatus}
                      label={row.statusLabel}
                    />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(row.createdAt)}
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
              ? " · register exceeds the 2,000-record read window"
              : ` · ${data.counts.total} registered in total`}
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

      <BcmDisclaimer className="mt-6" />

      {creating ? (
        <ServiceFormDialog
          service={null}
          members={options?.members ?? []}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {selected ? (
        <ServiceDetailDialog
          serviceId={selected}
          canManage={canManage}
          members={options?.members ?? []}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}

export function BcmServicesPage({ path }: { path: string }) {
  const session = useQuery(api.session.getSession, {});
  if (session && !session.permissions?.bcm) return <BcmUnauthorized path={path} />;

  return (
    <AppLayout>
      <Breadcrumbs path={path} />
      <BcmBoundary title="Business services">
        <ServicesRegister />
      </BcmBoundary>
    </AppLayout>
  );
}

