import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Globe, Plus, Archive, ArchiveRestore, History, RotateCcw } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { StatusChip, ClassificationBadge, statusLabel } from "@/components/iitams/badges";
import { formatRelative } from "@/lib/format";
import type { DataClassification } from "@/lib/severity";
import {
  ListPageShell,
  SearchFilterBar,
  DataTable,
  ListSkeleton,
  EmptyState,
} from "./ListPageShell";
import type { Column } from "./ListPageShell";

/**
 * Module 1 — Audit Universe page. Repository of auditable ICT entities with
 * create/edit/archive lifecycle, search, filters and audit history.
 */

const CATEGORIES = [
  "Application",
  "Database",
  "Network",
  "Server",
  "Cloud Service",
  "Digital Service",
  "ICT Process",
  "Security Platform",
  "Third Party Service",
  "Other",
] as const;

const CRITICALITY = ["very_low", "low", "medium", "high", "very_high"] as const;
const SEVERITIES = ["critical", "high", "medium", "low", "informational"] as const;
const CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"] as const;

interface UniverseRow {
  _id: string;
  code: string;
  name: string;
  description?: string;
  category?: string;
  owner?: string;
  businessUnit?: string;
  technologyType?: string;
  criticality?: string;
  businessImpact?: string;
  dataClassification?: string;
  regulatoryImportance?: string;
  securityExposure?: string;
  status?: string;
  createdAt: number;
  updatedAt: number;
}

function criticalityLabel(v?: string): string {
  return v ? statusLabel(v) : "—";
}

export function UniversePage({ path }: { path: string }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [status, setStatusFilter] = useState("active");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<UniverseRow | null>(null);
  const [historyFor, setHistoryFor] = useState<UniverseRow | null>(null);

  // Server remains authoritative; this only hides affordances the role lacks.
  const session = useQuery(api.session.getSession);
  const canManage = session?.permissions?.auditManage === true;
  const rows = useQuery(api.auditUniverse.list, {
    search: search || undefined,
    category: category === "all" ? undefined : (category as never),
    status: status === "all" ? undefined : (status as never),
    sort: "name",
  });

  const createItem = useMutation(api.auditUniverse.create);
  const updateItem = useMutation(api.auditUniverse.update);
  const setItemStatus = useMutation(api.auditUniverse.setStatus);

  const columns: Column<UniverseRow>[] = useMemo(
    () => [
      {
        header: "Code",
        className: "w-24 font-mono text-xs",
        render: (r) => r.code,
      },
      {
        header: "Name",
        render: (r) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{r.name}</p>
            {r.description && (
              <p className="truncate text-xs text-muted-foreground">{r.description}</p>
            )}
          </div>
        ),
      },
      {
        header: "Category",
        render: (r) => r.category ?? "—",
      },
      {
        header: "Owner",
        render: (r) => r.owner ?? "—",
      },
      {
        header: "Criticality",
        render: (r) => criticalityLabel(r.criticality),
      },
      {
        header: "Data class.",
        render: (r) =>
          r.dataClassification ? (
            <ClassificationBadge classification={r.dataClassification as DataClassification} />
          ) : (
            "—"
          ),
      },
      {
        header: "Status",
        render: (r) => <StatusChip status={r.status ?? "active"} />,
      },
      {
        header: "",
        className: "w-10",
        render: (r) => (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Audit history for ${r.name}`}
            onClick={(e) => {
              e.stopPropagation();
              setHistoryFor(r);
            }}
          >
            <History className="size-4" aria-hidden />
          </Button>
        ),
      },
    ],
    [],
  );

  return (
    <ListPageShell
      path={path}
      eyebrow="Audit Management"
      title="Audit Universe"
      description="Central repository of auditable ICT entities — systems, services, infrastructure and processes that may require audit coverage."
      actions={
        canManage && (
          <Button
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="size-4" aria-hidden />
            New item
          </Button>
        )
      }
    >
      <SearchFilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search by name, code, owner…"
        filters={[
          {
            label: "Category",
            value: category,
            onChange: setCategory,
            options: [
              { value: "all", label: "All categories" },
              ...CATEGORIES.map((c) => ({ value: c, label: c })),
            ],
          },
          {
            label: "Status",
            value: status,
            onChange: setStatusFilter,
            options: [
              { value: "active", label: "Active" },
              { value: "inactive", label: "Inactive" },
              { value: "archived", label: "Archived" },
              { value: "all", label: "All statuses" },
            ],
          },
        ]}
      />

      {rows === undefined ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No audit universe items"
          description="Add the ICT systems, services and processes that may require audit coverage. Items drive risk-based planning."
          action={
            canManage && (
              <Button
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
              >
                <Plus className="size-4" aria-hidden /> Add first item
              </Button>
            )
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r._id}
          onRowClick={(r) => {
            setEditing(r);
            setDialogOpen(true);
          }}
        />
      )}

      <UniverseItemDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        onSubmit={async (values) => {
          try {
            if (editing) {
              const patch: Record<string, unknown> = { id: editing._id };
              for (const [k, v] of Object.entries(values)) {
                if (v !== undefined && v !== "") patch[k] = v;
              }
              await updateItem(patch as never);
              toast.success("Audit universe item updated");
            } else {
              await createItem({
                name: values.name ?? "",
                description: values.description,
                category: (values.category ?? "Application") as never,
                owner: values.owner,
                businessUnit: values.businessUnit,
                technologyType: values.technologyType,
                criticality: (values.criticality ?? "medium") as never,
                businessImpact: values.businessImpact,
                dataClassification: (values.dataClassification ?? "internal") as never,
                regulatoryImportance: (values.regulatoryImportance ?? "medium") as never,
                securityExposure: values.securityExposure as never,
                inherentRisk: (values.inherentRisk ?? "medium") as never,
              });
              toast.success("Audit universe item created");
            }
            setDialogOpen(false);
            setEditing(null);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Operation failed");
          }
        }}
        onArchive={async (row, archived) => {
          try {
            await setItemStatus({
              id: row._id as never,
              status: (archived ? "archived" : "active") as never,
            });
            toast.success(archived ? "Item archived" : "Item restored");
            setEditing(null);
            setDialogOpen(false);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Operation failed");
          }
        }}
      />

      <HistoryDialog row={historyFor} onClose={() => setHistoryFor(null)} />
    </ListPageShell>
  );
}

// ---------------------------------------------------------------------------
// Create / edit dialog
// ---------------------------------------------------------------------------

interface FormValues {
  name?: string;
  description?: string;
  category?: string;
  owner?: string;
  businessUnit?: string;
  technologyType?: string;
  criticality?: string;
  businessImpact?: string;
  dataClassification?: string;
  regulatoryImportance?: string;
  securityExposure?: string;
  inherentRisk?: string;
}

function UniverseItemDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: UniverseRow | null;
  onSubmit: (values: FormValues) => Promise<void>;
  onArchive: (row: UniverseRow, archived: boolean) => Promise<void>;
}) {
  // Remount on target change so form state resets cleanly.
  return (
    <UniverseItemDialogInner
      key={props.editing?._id ?? "new"}
      {...props}
    />
  );
}

function UniverseItemDialogInner({
  open,
  onOpenChange,
  editing,
  onSubmit,
  onArchive,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: UniverseRow | null;
  onSubmit: (values: FormValues) => Promise<void>;
  onArchive: (row: UniverseRow, archived: boolean) => Promise<void>;
}) {
  const [values, setValues] = useState<FormValues>(
    editing
      ? {
          name: editing.name,
          description: editing.description,
          category: editing.category,
          owner: editing.owner,
          businessUnit: editing.businessUnit,
          technologyType: editing.technologyType,
          criticality: editing.criticality,
          businessImpact: editing.businessImpact,
          dataClassification: editing.dataClassification,
          regulatoryImportance: editing.regulatoryImportance,
          securityExposure: editing.securityExposure,
          inherentRisk: undefined,
        }
      : {},
  );
  const [saving, setSaving] = useState(false);

  const set = (key: keyof FormValues) => (value: string) =>
    setValues((v) => ({ ...v, [key]: value }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit ${editing.code}` : "New audit universe item"}
          </DialogTitle>
          <DialogDescription>
            Describe the ICT entity, its owner and its risk attributes. These
            feed the risk-based audit priority scoring.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="u-name">Name *</Label>
            <Input
              id="u-name"
              value={values.name ?? ""}
              onChange={(e) => set("name")(e.target.value)}
              placeholder="e.g. Core Banking Platform"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="u-desc">Description</Label>
            <Textarea
              id="u-desc"
              rows={2}
              value={values.description ?? ""}
              onChange={(e) => set("description")(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Category *</Label>
            <Select value={values.category ?? "Application"} onValueChange={set("category")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="u-owner">Owner</Label>
            <Input
              id="u-owner"
              value={values.owner ?? ""}
              onChange={(e) => set("owner")(e.target.value)}
              placeholder="e.g. ICT Directorate"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="u-bu">Business unit</Label>
            <Input
              id="u-bu"
              value={values.businessUnit ?? ""}
              onChange={(e) => set("businessUnit")(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="u-tech">Technology type</Label>
            <Input
              id="u-tech"
              value={values.technologyType ?? ""}
              onChange={(e) => set("technologyType")(e.target.value)}
              placeholder="e.g. Web application, Oracle DB…"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Business criticality *</Label>
            <Select value={values.criticality ?? "medium"} onValueChange={set("criticality")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CRITICALITY.map((c) => (
                  <SelectItem key={c} value={c}>
                    {statusLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Data classification *</Label>
            <Select
              value={values.dataClassification ?? "internal"}
              onValueChange={set("dataClassification")}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLASSIFICATIONS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {statusLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Regulatory importance *</Label>
            <Select
              value={values.regulatoryImportance ?? "medium"}
              onValueChange={set("regulatoryImportance")}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CRITICALITY.map((c) => (
                  <SelectItem key={c} value={c}>
                    {statusLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Security exposure</Label>
            <Select
              value={values.securityExposure ?? "medium"}
              onValueChange={set("securityExposure")}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CRITICALITY.map((c) => (
                  <SelectItem key={c} value={c}>
                    {statusLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {!editing && (
            <div className="space-y-1.5">
              <Label>Inherent risk (severity)</Label>
              <Select
                value={values.inherentRisk ?? "medium"}
                onValueChange={set("inherentRisk")}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {statusLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="u-impact">Business impact</Label>
            <Textarea
              id="u-impact"
              rows={2}
              value={values.businessImpact ?? ""}
              onChange={(e) => set("businessImpact")(e.target.value)}
              placeholder="What happens to service delivery if this asset fails?"
            />
          </div>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {editing ? (
            <Button
              variant={editing.status === "archived" ? "outline" : "destructive"}
              onClick={() => onArchive(editing, editing.status !== "archived")}
            >
              {editing.status === "archived" ? (
                <>
                  <ArchiveRestore className="size-4" aria-hidden /> Restore
                </>
              ) : (
                <>
                  <Archive className="size-4" aria-hidden /> Archive
                </>
              )}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              disabled={!values.name || saving}
              onClick={async () => {
                setSaving(true);
                await onSubmit(values);
                setSaving(false);
              }}
            >
              {editing ? "Save changes" : "Create item"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Audit history dialog
// ---------------------------------------------------------------------------

function HistoryDialog({
  row,
  onClose,
}: {
  row: UniverseRow | null;
  onClose: () => void;
}) {
  const history = useQuery(
    api.auditUniverse.history,
    row ? { id: row._id as never } : "skip",
  );
  return (
    <Dialog open={row !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Audit history — {row?.code}</DialogTitle>
          <DialogDescription>
            Entries from the immutable audit log for this item.
          </DialogDescription>
        </DialogHeader>
        <ol className="max-h-80 space-y-3 overflow-y-auto text-sm">
          {history === undefined && (
            <li className="text-muted-foreground">Loading…</li>
          )}
          {history?.length === 0 && (
            <li className="text-muted-foreground">No recorded changes yet.</li>
          )}
          {history?.map((h) => (
            <li key={h._id} className="flex gap-2.5">
              <RotateCcw className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0">
                <p className="font-medium">{h.summary ?? h.action}</p>
                <p className="text-xs text-muted-foreground">
                  {h.actorLabel ?? "System"} · {formatRelative(h.createdAt)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </DialogContent>
    </Dialog>
  );
}
