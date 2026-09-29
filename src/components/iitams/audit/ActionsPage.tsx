import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { RefreshCcw, Plus, BellRing, BadgeCheck } from "lucide-react";
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
import { StatusChip } from "@/components/iitams/badges";
import { formatRelative } from "@/lib/format";
import { ACTION_LABELS } from "@/lib/auditWorkflow";
import {
  ListPageShell,
  SearchFilterBar,
  DataTable,
  ListSkeleton,
  EmptyState,
} from "./ListPageShell";
import type { Column } from "./ListPageShell";

/**
 * Module 9 — Corrective action tracking: Open → In Progress → Completed →
 * Verified → Closed with overdue detection, reminders and verification.
 */

interface ActionRow {
  _id: string;
  title: string;
  description?: string;
  status: string;
  ownerName?: string;
  responsiblePerson?: string;
  dueDate?: number;
  completionEvidence?: string;
  computedOverdue: boolean;
  verifiedByName?: string;
  findingId?: string;
}

const ACTION_STATUSES = ["open", "in_progress", "completed", "verified", "closed", "overdue"] as const;

export function ActionsPage({ path }: { path: string }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);

  const session = useQuery(api.session.getSession);
  const canManage = session?.permissions?.auditManage === true;

  const rows = useQuery(api.auditFindings.listActions, {
    search: search || undefined,
    status: statusFilter === "all" ? undefined : statusFilter,
  });
  const sendReminders = useMutation(api.auditFindings.sendOverdueReminders);

  return (
    <ListPageShell
      path={path}
      eyebrow="Audit Management"
      title="Corrective Actions"
      description="Remediation tracking from finding to verified closure, with overdue indicators and reminders."
      actions={
        canManage && (
          <>
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  const res = await sendReminders({});
                  toast.success(
                    res.sent === 0
                      ? "No overdue reminders due"
                      : `${res.sent} reminder${res.sent === 1 ? "" : "s"} sent`,
                  );
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Failed");
                }
              }}
            >
              <BellRing className="size-4" aria-hidden /> Send reminders
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden /> New action
            </Button>
          </>
        )
      }
    >
      <SearchFilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search actions…"
        filters={[
          {
            label: "Status",
            value: statusFilter,
            onChange: setStatusFilter,
            options: [
              { value: "all", label: "All statuses" },
              ...ACTION_STATUSES.map((s) => ({ value: s, label: ACTION_LABELS[s] })),
            ],
          },
        ]}
      />

      {rows === undefined ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={RefreshCcw}
          title="No corrective actions"
          description="Corrective actions are created against findings to track remediation through to verified closure."
        />
      ) : (
        <ActionTable rows={rows} canManage={canManage} />
      )}

      <CreateActionDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </ListPageShell>
  );
}

function ActionTable({ rows, canManage }: { rows: ActionRow[]; canManage: boolean }) {
  const update = useMutation(api.auditFindings.updateAction);
  const verify = useMutation(api.auditFindings.verifyAction);
  const [editFor, setEditFor] = useState<ActionRow | null>(null);

  const columns: Column<ActionRow>[] = [
    {
      header: "Action",
      render: (r) => (
        <div className="min-w-0">
          <p className="truncate font-medium">
            {r.computedOverdue && (
              <span
                className="mr-1.5 inline-block size-2 rounded-full bg-critical align-middle"
                aria-label="Overdue"
              />
            )}
            {r.title}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {r.responsiblePerson ?? r.ownerName ?? "Unassigned"}
          </p>
        </div>
      ),
    },
    {
      header: "Status",
      render: (r) => <StatusChip status={r.status} />,
    },
    {
      header: "Due",
      render: (r) =>
        r.dueDate ? (
          <span className={r.computedOverdue ? "font-medium text-critical" : ""}>
            {formatRelative(r.dueDate)}
          </span>
        ) : (
          "—"
        ),
    },
    {
      header: "Verified by",
      render: (r) => r.verifiedByName ?? "—",
    },
    ...(canManage
      ? [
          {
            header: "",
            className: "w-56",
            render: (r: ActionRow) => (
              <div className="flex justify-end gap-1.5">
                {r.status === "completed" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={async () => {
                      try {
                        await verify({ id: r._id as never });
                        toast.success("Action verified");
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : "Failed");
                      }
                    }}
                  >
                    <BadgeCheck className="size-3.5" aria-hidden /> Verify
                  </Button>
                )}
                {r.status !== "verified" && r.status !== "closed" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={() => setEditFor(r)}
                  >
                    Update
                  </Button>
                )}
              </div>
            ),
          } satisfies Column<ActionRow>,
        ]
      : []),
  ];

  return (
    <>
      <DataTable columns={columns} rows={rows} rowKey={(r) => r._id} />
      <UpdateActionDialog row={editFor} onClose={() => setEditFor(null)} onUpdate={update} />
    </>
  );
}

function UpdateActionDialog({
  row,
  onClose,
  onUpdate,
}: {
  row: ActionRow | null;
  onClose: () => void;
  onUpdate: ReturnType<typeof useMutation<typeof api.auditFindings.updateAction>>;
}) {
  const [status, setStatus] = useState("in_progress");
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const key = row?._id ?? "none";

  return (
    <Dialog
      key={key}
      open={row !== null}
      onOpenChange={(o) => !o && onClose()}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Update action</DialogTitle>
          <DialogDescription>{row?.title}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACTION_STATUSES.filter((s) => s !== "overdue").map((s) => (
                  <SelectItem key={s} value={s}>
                    {ACTION_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ca-ev">Completion evidence</Label>
            <Textarea
              id="ca-ev"
              rows={3}
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder="Reference to evidence that the action is complete…"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              if (!row) return;
              setBusy(true);
              try {
                await onUpdate({
                  id: row._id as never,
                  status,
                  completionEvidence: evidence || undefined,
                });
                toast.success("Action updated");
                onClose();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateActionDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const findings = useQuery(api.auditFindings.list, open ? {} : "skip");
  const create = useMutation(api.auditFindings.createAction);
  const [findingId, setFindingId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [responsible, setResponsible] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);

  const openFindings = (findings ?? []).filter(
    (f) => f.status !== "closed" && f.status !== "resolved",
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New corrective action</DialogTitle>
          <DialogDescription>
            Created in the Open state; track to completion and verification.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Finding *</Label>
            <Select value={findingId} onValueChange={setFindingId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select the finding" />
              </SelectTrigger>
              <SelectContent>
                {openFindings.map((f) => (
                  <SelectItem key={f._id} value={f._id}>
                    {f.code} — {f.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ca-title">Action description *</Label>
            <Input
              id="ca-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ca-desc">Detail</Label>
            <Textarea
              id="ca-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ca-resp">Responsible person</Label>
              <Input
                id="ca-resp"
                value={responsible}
                onChange={(e) => setResponsible(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ca-due">Due date</Label>
              <Input
                id="ca-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!findingId || !title || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await create({
                  findingId: findingId as never,
                  title,
                  description: description || undefined,
                  responsiblePerson: responsible || undefined,
                  dueDate: dueDate ? new Date(dueDate).getTime() : undefined,
                });
                toast.success("Corrective action created");
                setTitle("");
                setDescription("");
                setResponsible("");
                setDueDate("");
                onClose();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Create action
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
