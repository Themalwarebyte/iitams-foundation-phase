import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AppLayout } from "@/components/iitams/AppLayout";
import { Breadcrumbs, PageHeader } from "@/components/iitams/PageHeader";
import { EmptyState, ListSkeleton } from "@/components/iitams/audit/ListPageShell";
import { KpiCard } from "@/components/iitams/KpiCard";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { formatDate } from "@/lib/format";
import {
  COMPLIANCE_FRAMEWORK_STATUS_LABELS,
  COMPLIANCE_FRAMEWORK_STATUSES,
  COMPLIANCE_AUTHORITY_MAX,
  COMPLIANCE_IDENTIFIER_MAX,
  COMPLIANCE_NAME_MAX,
  COMPLIANCE_TEXT_MAX,
  COMPLIANCE_VERSION_MAX,
  type ComplianceFrameworkStatus,
} from "@/lib/compliance";
import {
  ComplianceBoundary,
  ComplianceUnauthorized,
  FrameworkStatusPill,
  ImplementationDisclaimer,
} from "./CompliancePrimitives";
import {
  ClipboardList,
  Layers,
  Loader2,
  Plus,
  Search,
  SquareStack,
} from "lucide-react";
import { toast } from "sonner";

/**
 * /compliance/frameworks — Phase 3C Batch 1: framework catalogue.
 * =============================================================
 * The organization's ADOPTED framework register: identifiers, versions,
 * issuing authority, scope, lifecycle status and creation metadata, each with
 * its control register. Reads need compliance.view; every write needs
 * compliance.manage (re-checked server-side) plus an active membership, and the
 * page degrades to a read-only directory for viewers.
 *
 * No compliance percentage is displayed for current records: this batch records
 * frameworks and controls only.
 */

type FrameworkRow = {
  _id: Id<"complianceFrameworks">;
  name: string;
  code: string;
  version: string | null;
  issuingAuthority: string | null;
  description: string | null;
  scope: string | null;
  effectiveDate: number | null;
  status: ComplianceFrameworkStatus;
  statusLabel: string;
  createdByLabel: string | null;
  createdAt: number;
  updatedAt: number;
  counts: {
    controls: number;
    implemented: number;
    inProgress: number;
    notImplemented: number;
    notApplicable: number;
    planned: number;
    truncated: boolean;
  };
};

type FrameworkPage = {
  rows: FrameworkRow[];
  continueCursor: string;
  isDone: boolean;
  summary: { total: number; active: number; planned: number; retired: number };
};

type FrameworkDetail = FrameworkRow & {
  controls: Array<{
    _id: Id<"controls">;
    code: string;
    title: string;
    domain: string | null;
    domainLabel: string | null;
    implementationStatus: string;
    implementationStatusLabel: string;
    ownerName: string | null;
    sourceReference: string | null;
  }>;
  controlsTruncated: boolean;
};

const EMPTY_FORM = {
  name: "",
  identifier: "",
  version: "",
  issuingAuthority: "",
  description: "",
  scope: "",
  effectiveDate: "",
  status: "active" as ComplianceFrameworkStatus,
};

function toTimestamp(value: string): number | undefined {
  if (!value) return undefined;
  const ts = new Date(`${value}T00:00:00`).getTime();
  return Number.isNaN(ts) ? undefined : ts;
}

function toDateInput(value: number | null): string {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

function FrameworkFormDialog({
  framework,
  onClose,
}: {
  framework: FrameworkRow | null;
  onClose: () => void;
}) {
  const createFramework = useMutation(api.compliance.createFramework);
  const updateFramework = useMutation(api.compliance.updateFramework);
  const [form, setForm] = useState(() =>
    framework
      ? {
          name: framework.name,
          identifier: framework.code,
          version: framework.version ?? "",
          issuingAuthority: framework.issuingAuthority ?? "",
          description: framework.description ?? "",
          scope: framework.scope ?? "",
          effectiveDate: toDateInput(framework.effectiveDate),
          status: framework.status,
        }
      : EMPTY_FORM,
  );
  const [busy, setBusy] = useState(false);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit() {
    setBusy(true);
    try {
      if (framework) {
        await updateFramework({
          frameworkId: framework._id,
          name: form.name,
          version: form.version,
          issuingAuthority: form.issuingAuthority,
          description: form.description,
          scope: form.scope,
          effectiveDate: toTimestamp(form.effectiveDate),
          status: form.status,
        });
        toast.success(`Framework ${framework.code} updated.`);
      } else {
        const result = await createFramework({
          name: form.name,
          identifier: form.identifier,
          version: form.version,
          issuingAuthority: form.issuingAuthority,
          description: form.description,
          scope: form.scope,
          effectiveDate: toTimestamp(form.effectiveDate),
          status: form.status,
        });
        toast.success(`Framework added (${result.frameworkId ? "recorded" : "recorded"}).`);
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
            {framework ? `Edit ${framework.code}` : "Add framework"}
          </DialogTitle>
          <DialogDescription>
            An adopted framework belongs to your organization only. Identifiers
            are unique within the organization.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="framework-name">Framework name</Label>
            <Input
              id="framework-name"
              value={form.name}
              maxLength={COMPLIANCE_NAME_MAX}
              onChange={(e) => set("name", e.target.value)}
              placeholder="ISO/IEC 27001:2022"
            />
          </div>
          <div>
            <Label htmlFor="framework-identifier">Identifier</Label>
            <Input
              id="framework-identifier"
              value={form.identifier}
              maxLength={COMPLIANCE_IDENTIFIER_MAX}
              disabled={framework !== null}
              onChange={(e) => set("identifier", e.target.value)}
              placeholder="ISO-27001"
            />
            {framework && (
              <p className="mt-1 text-xs text-muted-foreground">
                Identifiers are immutable — controls and audit entries reference
                them.
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="framework-version">Version</Label>
            <Input
              id="framework-version"
              value={form.version}
              maxLength={COMPLIANCE_VERSION_MAX}
              onChange={(e) => set("version", e.target.value)}
              placeholder="2022"
            />
          </div>
          <div>
            <Label htmlFor="framework-authority">Issuing authority / source</Label>
            <Input
              id="framework-authority"
              value={form.issuingAuthority}
              maxLength={COMPLIANCE_AUTHORITY_MAX}
              onChange={(e) => set("issuingAuthority", e.target.value)}
              placeholder="ISO/IEC"
            />
          </div>
          <div>
            <Label htmlFor="framework-effective">Effective date</Label>
            <Input
              id="framework-effective"
              type="date"
              value={form.effectiveDate}
              onChange={(e) => set("effectiveDate", e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="framework-status">Lifecycle status</Label>
            <Select
              value={form.status}
              onValueChange={(value) =>
                set("status", value as ComplianceFrameworkStatus)
              }
            >
              <SelectTrigger id="framework-status" aria-label="Lifecycle status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMPLIANCE_FRAMEWORK_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {COMPLIANCE_FRAMEWORK_STATUS_LABELS[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="framework-description">Description</Label>
            <Textarea
              id="framework-description"
              value={form.description}
              maxLength={COMPLIANCE_TEXT_MAX}
              rows={3}
              onChange={(e) => set("description", e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="framework-scope">Scope</Label>
            <Textarea
              id="framework-scope"
              value={form.scope}
              maxLength={COMPLIANCE_TEXT_MAX}
              rows={2}
              onChange={(e) => set("scope", e.target.value)}
              placeholder="Which systems, services or departments the adoption covers"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !form.name || (!framework && !form.identifier)}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
            {framework ? "Save framework" : "Create framework"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function FrameworkDetailDialog({
  frameworkId,
  canManage,
  onClose,
  onEdit,
}: {
  frameworkId: Id<"complianceFrameworks">;
  canManage: boolean;
  onClose: () => void;
  onEdit: (framework: FrameworkRow) => void;
}) {
  const detail = useQuery(api.compliance.getFramework, {
    frameworkId,
  }) as FrameworkDetail | null | undefined;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {detail ? `${detail.code} — ${detail.name}` : "Framework"}
          </DialogTitle>
          <DialogDescription>
            Adopted framework record with its control register.
          </DialogDescription>
        </DialogHeader>

        {detail === undefined ? (
          <ListSkeleton rows={4} />
        ) : detail === null ? (
          <EmptyState
            icon={SquareStack}
            title="Framework not available"
            description="This framework does not exist in your organization."
          />
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ["Version", detail.version ?? "—"],
                ["Issuing authority", detail.issuingAuthority ?? "—"],
                ["Effective date", detail.effectiveDate ? formatDate(detail.effectiveDate) : "—"],
                ["Controls", `${detail.counts.controls} recorded`],
                ["Created", `${formatDate(detail.createdAt)}${detail.createdByLabel ? ` by ${detail.createdByLabel}` : ""}`],
                ["Last updated", formatDate(detail.updatedAt)],
              ].map(([label, value]) => (
                <div key={label}>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {label}
                  </p>
                  <p className="text-sm">{value}</p>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                Status
              </span>
              <FrameworkStatusPill status={detail.status} label={detail.statusLabel} />
            </div>
            {detail.description && (
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Description
                </p>
                <p className="text-sm text-muted-foreground">{detail.description}</p>
              </div>
            )}
            {detail.scope && (
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Scope
                </p>
                <p className="text-sm text-muted-foreground">{detail.scope}</p>
              </div>
            )}

            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Controls in this framework</h3>
                {canManage && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      onEdit(detail);
                      onClose();
                    }}
                  >
                    Edit framework
                  </Button>
                )}
              </div>
              {detail.controls.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/80 px-3 py-4 text-sm text-muted-foreground">
                  No controls recorded against this framework yet. Add controls
                  from the Control Register.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Identifier</TableHead>
                      <TableHead>Control</TableHead>
                      <TableHead>Domain</TableHead>
                      <TableHead>Implementation</TableHead>
                      <TableHead>Owner</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.controls.map((control) => (
                      <TableRow key={control._id}>
                        <TableCell className="font-mono text-xs">
                          {control.code}
                        </TableCell>
                        <TableCell>{control.title}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {control.domainLabel ?? "—"}
                        </TableCell>
                        <TableCell>{control.implementationStatusLabel}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {control.ownerName ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {detail.controlsTruncated && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Showing the first 500 controls; open the Control Register for
                  the full, paginated list.
                </p>
              )}
            </div>
            <ImplementationDisclaimer />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ComplianceFrameworksPage() {
  const session = useQuery(api.session.getSession);
  const canView = session?.permissions?.compliance === true;
  const canManage = session?.permissions?.complianceManage === true;

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [olderRows, setOlderRows] = useState<FrameworkRow[]>([]);
  const [selectedId, setSelectedId] = useState<Id<"complianceFrameworks"> | null>(
    null,
  );
  const [formTarget, setFormTarget] = useState<{
    framework: FrameworkRow | null;
  } | null>(null);

  const page = useQuery(
    api.compliance.listFrameworks,
    canView
      ? {
          ...(search.trim() ? { search: search.trim() } : {}),
          ...(status !== "all"
            ? { status: status as ComplianceFrameworkStatus }
            : {}),
          ...(cursor ? { cursor } : {}),
        }
      : "skip",
  ) as FrameworkPage | undefined;

  const rows = useMemo(() => {
    if (!page) return undefined;
    if (cursor === null) return page.rows;
    const byId = new Map<string, FrameworkRow>();
    for (const row of [...olderRows, ...page.rows]) byId.set(row._id, row);
    return [...byId.values()];
  }, [page, olderRows, cursor]);

  if (session && !canView) {
    return <ComplianceUnauthorized />;
  }

  return (
    <AppLayout>
      <Breadcrumbs path="/compliance/frameworks" />
      <PageHeader
        eyebrow="Compliance"
        title="Framework directory"
        description="The frameworks your organization has adopted, with the controls recorded against each one. This register stores adoption and implementation records only — it does not assert a compliance score."
        actions={
          canManage ? (
            <Button onClick={() => setFormTarget({ framework: null })}>
              <Plus className="mr-2 size-4" aria-hidden />
              Add framework
            </Button>
          ) : undefined
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Frameworks"
          value={page?.summary.total ?? 0}
          icon={Layers}
          tone="primary"
          hint="Adopted in your organization"
        />
        <KpiCard
          label="Active"
          value={page?.summary.active ?? 0}
          icon={SquareStack}
          tone="success"
          hint="Currently in force"
        />
        <KpiCard
          label="Planned"
          value={page?.summary.planned ?? 0}
          icon={ClipboardList}
          tone="info"
          hint="Adoption planned"
        />
        <KpiCard
          label="Retired"
          value={page?.summary.retired ?? 0}
          icon={ClipboardList}
          tone="neutral"
          hint="No longer in force"
        />
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="relative flex-1 sm:max-w-sm">
          <Label htmlFor="framework-search" className="sr-only">
            Search frameworks
          </Label>
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            id="framework-search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setCursor(null);
              setOlderRows([]);
            }}
            placeholder="Search by name, identifier, version or authority"
            className="pl-8"
          />
        </div>
        <div className="w-full sm:w-48">
          <Label htmlFor="framework-status-filter">Lifecycle status</Label>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value);
              setCursor(null);
              setOlderRows([]);
            }}
          >
            <SelectTrigger id="framework-status-filter" aria-label="Lifecycle status filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {COMPLIANCE_FRAMEWORK_STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {COMPLIANCE_FRAMEWORK_STATUS_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {rows === undefined ? (
        <ListSkeleton rows={5} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={SquareStack}
          title="No frameworks yet"
          description={
            canManage
              ? "Add the first framework your organization has adopted to start the control register."
              : "No framework has been recorded for your organization yet."
          }
          action={
            canManage ? (
              <Button onClick={() => setFormTarget({ framework: null })}>
                Add framework
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Adopted frameworks</CardTitle>
            <CardDescription>
              Identifiers are unique within your organization. Select a framework
              to open its record and controls.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Identifier</TableHead>
                  <TableHead>Framework</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Authority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Controls</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row._id}>
                    <TableCell className="font-mono text-xs">{row.code}</TableCell>
                    <TableCell>
                      <button
                        type="button"
                        className="text-left font-medium hover:underline"
                        onClick={() => setSelectedId(row._id)}
                      >
                        {row.name}
                      </button>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.version ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.issuingAuthority ?? "—"}
                    </TableCell>
                    <TableCell>
                      <FrameworkStatusPill
                        status={row.status}
                        label={row.statusLabel}
                      />
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {row.counts.controls}
                      {row.counts.controls > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {" "}
                          ({row.counts.implemented} implemented)
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.effectiveDate ? formatDate(row.effectiveDate) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setSelectedId(row._id)}
                      >
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {page && !page.isDone && (
              <Button
                variant="outline"
                size="sm"
                className="mt-3 w-full"
                onClick={() => {
                  setOlderRows((prev) => [...prev, ...page.rows]);
                  setCursor(page.continueCursor);
                }}
              >
                Load older frameworks
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <div className="mt-4">
        <ImplementationDisclaimer />
      </div>

      {formTarget && (
        <FrameworkFormDialog
          framework={formTarget.framework}
          onClose={() => setFormTarget(null)}
        />
      )}
      {selectedId && (
        <FrameworkDetailDialog
          frameworkId={selectedId}
          canManage={canManage}
          onClose={() => setSelectedId(null)}
          onEdit={(framework) => setFormTarget({ framework })}
        />
      )}
    </AppLayout>
  );
}

/** Route entry — wraps the page in its own crash guard. */
export default function ComplianceFrameworksRoute() {
  return (
    <ComplianceBoundary title="Framework directory">
      <ComplianceFrameworksPage />
    </ComplianceBoundary>
  );
}
