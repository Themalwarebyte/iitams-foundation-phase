import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AppLayout } from "@/components/iitams/AppLayout";
import { Breadcrumbs, PageHeader } from "@/components/iitams/PageHeader";
import { EmptyState, ListSkeleton } from "@/components/iitams/audit/ListPageShell";
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
import {
  COMPLIANCE_CONTROL_IDENTIFIER_MAX,
  COMPLIANCE_CONTROL_TITLE_MAX,
  COMPLIANCE_SOURCE_REFERENCE_MAX,
  COMPLIANCE_TEXT_MAX,
  CONTROL_APPLICABILITY,
  CONTROL_APPLICABILITY_LABELS,
  CONTROL_DOMAINS,
  CONTROL_DOMAIN_LABELS,
  CONTROL_IMPLEMENTATION_STATUSES,
  CONTROL_IMPLEMENTATION_STATUS_LABELS,
  type ControlApplicability,
  type ControlDomain,
  type ControlImplementationStatus,
} from "@/lib/compliance";
import {
  ComplianceBoundary,
  ComplianceUnauthorized,
  ImplementationStatusPill,
} from "./CompliancePrimitives";
import { KeyRound, Loader2, Plus, Search } from "lucide-react";
import { toast } from "sonner";

/**
 * /compliance/controls — Phase 3C Batch 1: control register.
 * ==========================================================
 * Controls are always linked to one of the organization's adopted frameworks,
 * carry an identifier unique within that framework, and record objective,
 * source reference, applicability, owner and implementation status. Reads need
 * compliance.view; writes need compliance.manage plus an active membership.
 */

type ControlRow = {
  _id: Id<"controls">;
  code: string;
  title: string;
  description: string | null;
  domain: ControlDomain | null;
  domainLabel: string | null;
  objective: string | null;
  sourceReference: string | null;
  applicability: ControlApplicability | null;
  applicabilityLabel: string | null;
  implementationStatus: ControlImplementationStatus;
  implementationStatusLabel: string;
  ownerUserId: string | null;
  ownerName: string | null;
  frameworkId: Id<"complianceFrameworks"> | null;
  effectiveness: string;
  createdAt: number;
  updatedAt: number;
};

type ControlPage = {
  rows: ControlRow[];
  continueCursor: string;
  isDone: boolean;
  framework: { _id: string; code: string; name: string; status: string } | null;
  summary: { total: number; byStatus: Record<string, number> };
};

type FrameworkOption = {
  _id: Id<"complianceFrameworks">;
  code: string;
  name: string;
};

const EMPTY_CONTROL = {
  identifier: "",
  title: "",
  description: "",
  domain: "",
  objective: "",
  sourceReference: "",
  applicability: "applicable" as ControlApplicability,
  ownerKey: "none",
  implementationStatus: "not_implemented" as ControlImplementationStatus,
};

function ControlFormDialog({
  control,
  frameworks,
  defaultFrameworkId,
  onClose,
}: {
  control: ControlRow | null;
  frameworks: FrameworkOption[];
  defaultFrameworkId: Id<"complianceFrameworks"> | null;
  onClose: () => void;
}) {
  const createControl = useMutation(api.compliance.createControl);
  const updateControl = useMutation(api.compliance.updateControl);
  const owners = useQuery(api.compliance.controlOwners, {}) as
    | Array<{ userId: string; label: string; email: string | null }>
    | undefined;
  const [frameworkId, setFrameworkId] = useState<string | null>(
    control?.frameworkId ?? defaultFrameworkId ?? frameworks[0]?._id ?? null,
  );
  const [form, setForm] = useState(() =>
    control
      ? {
          identifier: control.code,
          title: control.title,
          description: control.description ?? "",
          domain: control.domain ?? "",
          objective: control.objective ?? "",
          sourceReference: control.sourceReference ?? "",
          applicability: control.applicability ?? "applicable",
          ownerKey: control.ownerUserId ?? "none",
          implementationStatus: control.implementationStatus,
        }
      : EMPTY_CONTROL,
  );
  const [busy, setBusy] = useState(false);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit() {
    if (!frameworkId && !control) {
      toast.error("Select the framework this control belongs to.");
      return;
    }
    setBusy(true);
    try {
      const ownerUserId =
        form.ownerKey !== "none"
          ? (form.ownerKey as Id<"users">)
          : undefined;
      if (control) {
        await updateControl({
          controlId: control._id,
          title: form.title,
          description: form.description,
          ...(form.domain ? { domain: form.domain as ControlDomain } : {}),
          objective: form.objective,
          sourceReference: form.sourceReference,
          applicability: form.applicability,
          implementationStatus: form.implementationStatus,
          ...(ownerUserId ? { ownerUserId } : { ownerName: undefined }),
        });
        toast.success(`Control ${control.code} updated.`);
      } else {
        const result = await createControl({
          frameworkId: frameworkId as Id<"complianceFrameworks">,
          identifier: form.identifier,
          title: form.title,
          description: form.description,
          ...(form.domain ? { domain: form.domain as ControlDomain } : {}),
          objective: form.objective,
          sourceReference: form.sourceReference,
          applicability: form.applicability,
          implementationStatus: form.implementationStatus,
          ...(ownerUserId ? { ownerUserId } : {}),
        });
        toast.success(`Control recorded (${result.controlId ? form.identifier : form.identifier}).`);
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
            {control ? `Edit control ${control.code}` : "Add control"}
          </DialogTitle>
          <DialogDescription>
            Controls are linked to one adopted framework. Identifiers are unique
            within that framework.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          {!control && (
            <div className="sm:col-span-2">
              <Label htmlFor="control-framework">Framework</Label>
              <Select
                value={frameworkId ?? undefined}
                onValueChange={(value) => setFrameworkId(value)}
              >
                <SelectTrigger id="control-framework" aria-label="Framework">
                  <SelectValue placeholder="Select a framework" />
                </SelectTrigger>
                <SelectContent>
                  {frameworks.map((framework) => (
                    <SelectItem key={framework._id} value={framework._id}>
                      {framework.code} — {framework.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {frameworks.length === 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Add a framework first: every control belongs to one.
                </p>
              )}
            </div>
          )}
          <div>
            <Label htmlFor="control-identifier">Control identifier</Label>
            <Input
              id="control-identifier"
              value={form.identifier}
              maxLength={COMPLIANCE_CONTROL_IDENTIFIER_MAX}
              disabled={control !== null}
              onChange={(e) => set("identifier", e.target.value)}
              placeholder="A.5.1"
            />
          </div>
          <div>
            <Label htmlFor="control-title">Title</Label>
            <Input
              id="control-title"
              value={form.title}
              maxLength={COMPLIANCE_CONTROL_TITLE_MAX}
              onChange={(e) => set("title", e.target.value)}
              placeholder="Policies for information security"
            />
          </div>
          <div>
            <Label htmlFor="control-domain">Control domain</Label>
            <Select
              value={form.domain || "none"}
              onValueChange={(value) => set("domain", value === "none" ? "" : value)}
            >
              <SelectTrigger id="control-domain" aria-label="Control domain">
                <SelectValue placeholder="Unclassified" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Unclassified</SelectItem>
                {CONTROL_DOMAINS.map((domain) => (
                  <SelectItem key={domain} value={domain}>
                    {CONTROL_DOMAIN_LABELS[domain]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="control-applicability">Applicability</Label>
            <Select
              value={form.applicability}
              onValueChange={(value) =>
                set("applicability", value as ControlApplicability)
              }
            >
              <SelectTrigger id="control-applicability" aria-label="Applicability">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTROL_APPLICABILITY.map((value) => (
                  <SelectItem key={value} value={value}>
                    {CONTROL_APPLICABILITY_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="control-owner">Control owner</Label>
            <Select
              value={form.ownerKey}
              onValueChange={(value) => set("ownerKey", value)}
            >
              <SelectTrigger id="control-owner" aria-label="Control owner">
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Unassigned</SelectItem>
                {(owners ?? []).map((owner) => (
                  <SelectItem key={owner.userId} value={owner.userId}>
                    {owner.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="control-implementation">Implementation status</Label>
            <Select
              value={form.implementationStatus}
              onValueChange={(value) =>
                set("implementationStatus", value as ControlImplementationStatus)
              }
            >
              <SelectTrigger
                id="control-implementation"
                aria-label="Implementation status"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTROL_IMPLEMENTATION_STATUSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {CONTROL_IMPLEMENTATION_STATUS_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="control-objective">Control objective</Label>
            <Textarea
              id="control-objective"
              value={form.objective}
              maxLength={COMPLIANCE_TEXT_MAX}
              rows={2}
              onChange={(e) => set("objective", e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="control-description">Description</Label>
            <Textarea
              id="control-description"
              value={form.description}
              maxLength={COMPLIANCE_TEXT_MAX}
              rows={3}
              onChange={(e) => set("description", e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="control-source">Requirement / source reference</Label>
            <Input
              id="control-source"
              value={form.sourceReference}
              maxLength={COMPLIANCE_SOURCE_REFERENCE_MAX}
              onChange={(e) => set("sourceReference", e.target.value)}
              placeholder="Clause 5.2 of the framework text, adoption note…"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={busy || !form.title || (!control && !form.identifier)}
          >
            {busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
            {control ? "Save control" : "Create control"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ControlDetailDialog({
  control,
  canManage,
  onEdit,
  onClose,
}: {
  control: ControlRow;
  canManage: boolean;
  onEdit: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {control.code} — {control.title}
          </DialogTitle>
          <DialogDescription>
            Control register record. Objectives and implementation are stated by
            the organization; no test result is recorded in this batch.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            ["Domain", control.domainLabel ?? "Unclassified"],
            ["Applicability", control.applicabilityLabel ?? "—"],
            ["Implementation", control.implementationStatusLabel],
            ["Owner", control.ownerName ?? "Unassigned"],
            ["Effectiveness", control.effectiveness === "not_tested" ? "Not tested" : control.effectiveness],
            ["Source reference", control.sourceReference ?? "—"],
          ].map(([label, value]) => (
            <div key={label}>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {label}
              </p>
              <p className="text-sm">{value}</p>
            </div>
          ))}
        </div>
        {control.objective && (
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Objective
            </p>
            <p className="text-sm text-muted-foreground">{control.objective}</p>
          </div>
        )}
        {control.description && (
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Description
            </p>
            <p className="text-sm text-muted-foreground">{control.description}</p>
          </div>
        )}
        <DialogFooter>
          {canManage && (
            <Button variant="secondary" onClick={onEdit}>
              Edit control
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ComplianceControlsPage() {
  const session = useQuery(api.session.getSession);
  const canView = session?.permissions?.compliance === true;
  const canManage = session?.permissions?.complianceManage === true;

  const [search, setSearch] = useState("");
  const [frameworkFilter, setFrameworkFilter] = useState<string>("all");
  const [domainFilter, setDomainFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [olderRows, setOlderRows] = useState<ControlRow[]>([]);
  const [formTarget, setFormTarget] = useState<{
    control: ControlRow | null;
  } | null>(null);
  const [detail, setDetail] = useState<ControlRow | null>(null);

  const frameworks = useQuery(
    api.compliance.listFrameworks,
    canView ? { numItems: 100 } : "skip",
  ) as { rows: FrameworkOption[] } | undefined;

  const page = useQuery(
    api.compliance.listControls,
    canView
      ? {
          ...(frameworkFilter !== "all"
            ? { frameworkId: frameworkFilter as Id<"complianceFrameworks"> }
            : {}),
          ...(domainFilter !== "all"
            ? { domain: domainFilter as ControlDomain }
            : {}),
          ...(statusFilter !== "all"
            ? { implementationStatus: statusFilter as ControlImplementationStatus }
            : {}),
          ...(search.trim() ? { search: search.trim() } : {}),
          ...(cursor ? { cursor } : {}),
        }
      : "skip",
  ) as ControlPage | undefined;

  /** A filter change invalidates any accumulated page cursor. */
  function resetPaging() {
    setCursor(null);
    setOlderRows([]);
  }

  const rows = useMemo(() => {
    if (!page) return undefined;
    if (cursor === null) return page.rows;
    const byId = new Map<string, ControlRow>();
    for (const row of [...olderRows, ...page.rows]) byId.set(row._id, row);
    return [...byId.values()];
  }, [page, olderRows, cursor]);

  if (session && !canView) {
    return <ComplianceUnauthorized />;
  }

  const frameworkOptions = frameworks?.rows ?? [];

  return (
    <AppLayout>
      <Breadcrumbs path="/compliance/controls" />
      <PageHeader
        eyebrow="Compliance"
        title="Control register"
        description="Controls recorded against your adopted frameworks, with owner, applicability and implementation status. Implementation is an operational statement, not a test result or a compliance percentage."
        actions={
          canManage ? (
            <Button
              onClick={() => setFormTarget({ control: null })}
              disabled={frameworkOptions.length === 0}
            >
              <Plus className="mr-2 size-4" aria-hidden />
              Add control
            </Button>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end">
        <div className="relative flex-1 lg:max-w-sm">
          <Label htmlFor="control-search" className="sr-only">
            Search controls
          </Label>
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            id="control-search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetPaging();
            }}
            placeholder="Search identifier, title, source reference or owner"
            className="pl-8"
          />
        </div>
        <div className="w-full lg:w-64">
          <Label htmlFor="control-framework-filter">Framework</Label>
          <Select
            value={frameworkFilter}
            onValueChange={(value) => {
              setFrameworkFilter(value);
              resetPaging();
            }}
          >
            <SelectTrigger id="control-framework-filter" aria-label="Framework filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All frameworks</SelectItem>
              {frameworkOptions.map((framework) => (
                <SelectItem key={framework._id} value={framework._id}>
                  {framework.code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-full lg:w-52">
          <Label htmlFor="control-domain-filter">Domain</Label>
          <Select
            value={domainFilter}
            onValueChange={(value) => {
              setDomainFilter(value);
              resetPaging();
            }}
          >
            <SelectTrigger id="control-domain-filter" aria-label="Domain filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All domains</SelectItem>
              {CONTROL_DOMAINS.map((domain) => (
                <SelectItem key={domain} value={domain}>
                  {CONTROL_DOMAIN_LABELS[domain]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-full lg:w-52">
          <Label htmlFor="control-status-filter">Implementation</Label>
          <Select
            value={statusFilter}
            onValueChange={(value) => {
              setStatusFilter(value);
              resetPaging();
            }}
          >
            <SelectTrigger id="control-status-filter" aria-label="Implementation filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {CONTROL_IMPLEMENTATION_STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {CONTROL_IMPLEMENTATION_STATUS_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {rows === undefined ? (
        <ListSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No controls match"
          description={
            frameworkOptions.length === 0
              ? "Add an adopted framework first — every control belongs to one."
              : "Adjust the filters or add a control to the register."
          }
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Control register</CardTitle>
            <CardDescription>
              {page?.framework
                ? `Controls linked to ${page.framework.code} — ${page.framework.name}.`
                : "Controls across every adopted framework in your organization."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Identifier</TableHead>
                  <TableHead>Control</TableHead>
                  <TableHead>Domain</TableHead>
                  <TableHead>Implementation</TableHead>
                  <TableHead>Applicability</TableHead>
                  <TableHead>Owner</TableHead>
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
                        onClick={() => setDetail(row)}
                      >
                        {row.title}
                      </button>
                      {row.sourceReference && (
                        <span className="block text-xs text-muted-foreground">
                          {row.sourceReference}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.domainLabel ?? "—"}
                    </TableCell>
                    <TableCell>
                      <ImplementationStatusPill
                        status={row.implementationStatus}
                        label={row.implementationStatusLabel}
                      />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.applicabilityLabel ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.ownerName ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDetail(row)}
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
                Load more controls
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {formTarget && (
        <ControlFormDialog
          control={formTarget.control}
          frameworks={frameworkOptions}
          defaultFrameworkId={
            frameworkFilter !== "all"
              ? (frameworkFilter as Id<"complianceFrameworks">)
              : null
          }
          onClose={() => setFormTarget(null)}
        />
      )}
      {detail && (
        <ControlDetailDialog
          control={detail}
          canManage={canManage}
          onEdit={() => {
            setFormTarget({ control: detail });
            setDetail(null);
          }}
          onClose={() => setDetail(null)}
        />
      )}
    </AppLayout>
  );
}

/** Route entry — wraps the page in its own crash guard. */
export default function ComplianceControlsRoute() {
  return (
    <ComplianceBoundary title="Control register">
      <ComplianceControlsPage />
    </ComplianceBoundary>
  );
}
