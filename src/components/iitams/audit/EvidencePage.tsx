import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Database, Plus, Download, ShieldCheck } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
 * Module 7 — Evidence management UI. Uploads go directly from the browser to
 * Convex file storage; the server computes the SHA-256 integrity hash via a
 * scheduled action and gates restricted downloads behind audit-management
 * roles, logging every access to the immutable audit log.
 */

interface EvidenceRow {
  _id: string;
  filename: string;
  fileType: string;
  sizeBytes: number;
  classification: string;
  sha256: string;
  source?: string;
  description?: string;
  status: string;
  createdAt: number;
}

const CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"] as const;
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/csv",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/json",
  "application/zip",
];

export function EvidencePage({ path }: { path: string }) {
  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState("all");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [verifyFor, setVerifyFor] = useState<EvidenceRow | null>(null);

  const session = useQuery(api.session.getSession);
  const canManage = session?.permissions?.auditManage === true;

  const rows = useQuery(api.auditEvidence.list, {
    search: search || undefined,
    classification:
      classFilter === "all" ? undefined : (classFilter as DataClassification),
  });

  const columns: Column<EvidenceRow>[] = [
    {
      header: "File",
      render: (r) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{r.filename}</p>
          <p className="truncate text-xs text-muted-foreground">
            {r.description ?? r.source ?? "—"}
          </p>
        </div>
      ),
    },
    {
      header: "Class.",
      render: (r) => (
        <ClassificationBadge classification={r.classification as DataClassification} />
      ),
    },
    {
      header: "Size",
      className: "w-20 tabular-nums",
      render: (r) => `${Math.max(1, Math.round(r.sizeBytes / 1024))} KB`,
    },
    {
      header: "Integrity (SHA-256)",
      render: (r) => (
        <button
          type="button"
          className="group flex items-center gap-1.5 text-left font-mono text-xs"
          aria-label={`Verify integrity of ${r.filename}`}
          onClick={() => setVerifyFor(r)}
        >
          {r.sha256 ? (
            <>
              <ShieldCheck
                className="size-3.5 shrink-0 text-success"
                aria-hidden
              />
              <span className="truncate">
                {r.sha256.slice(0, 16)}…
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">Computing…</span>
          )}
        </button>
      ),
    },
    {
      header: "Status",
      render: (r) => <StatusChip status={r.status} />,
    },
    {
      header: "Uploaded",
      render: (r) => formatRelative(r.createdAt),
    },
    {
      header: "",
      className: "w-10",
      render: (r) => (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Download ${r.filename}`}
          onClick={async () => {
            try {
              const res = await download({ evidenceId: r._id as never });
              if (res.url) window.open(res.url, "_blank", "noopener");
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Download failed");
            }
          }}
        >
          <Download className="size-4" aria-hidden />
        </Button>
      ),
    },
  ];

  const download = useMutation(api.auditEvidence.getDownloadUrl);

  return (
    <ListPageShell
      path={path}
      eyebrow="Audit Management"
      title="Evidence"
      description="Secure evidence repository with server-computed SHA-256 integrity hashes, classification-aware access control and full access logging."
      actions={
        canManage && (
          <Button onClick={() => setUploadOpen(true)}>
            <Plus className="size-4" aria-hidden /> Upload evidence
          </Button>
        )
      }
    >
      <SearchFilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search files, sources, descriptions…"
        filters={[
          {
            label: "Classification",
            value: classFilter,
            onChange: setClassFilter,
            options: [
              { value: "all", label: "All classifications" },
              ...CLASSIFICATIONS.map((c) => ({
                value: c,
                label: statusLabel(c),
              })),
            ],
          },
        ]}
      />

      {rows === undefined ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Database}
          title="No evidence records"
          description="Upload evidence with classification metadata. Files are hashed (SHA-256) server-side for integrity and every download is logged."
          action={
            canManage && (
              <Button onClick={() => setUploadOpen(true)}>
                <Plus className="size-4" aria-hidden /> Upload first file
              </Button>
            )
          }
        />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(r) => r._id} />
      )}

      <UploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} />
      <IntegrityDialog row={verifyFor} onClose={() => setVerifyFor(null)} />
    </ListPageShell>
  );
}

// ---------------------------------------------------------------------------
// Upload dialog (browser → storage PUT → confirm)
// ---------------------------------------------------------------------------

function UploadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const getUrl = useMutation(api.auditEvidence.generateUploadUrl);
  const confirm = useMutation(api.auditEvidence.confirmUpload);
  const [file, setFile] = useState<File | null>(null);
  const [classification, setClassification] = useState<string>("internal");
  const [source, setSource] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    try {
      setProgress("Requesting secure upload URL…");
      const uploadUrl: string = await getUrl({});
      setProgress("Uploading file…");
      const res = await fetch(uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!res.ok) throw new Error("File upload failed");
      const { storageId } = (await res.json()) as { storageId: string };
      setProgress("Hashing & registering evidence…");
      await confirm({
        storageId: storageId as never,
        filename: file.name,
        fileType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        classification: classification as never,
        source: source || undefined,
        description: description || undefined,
      });
      toast.success("Evidence uploaded and hashed");
      setFile(null);
      setSource("");
      setDescription("");
      if (fileRef.current) fileRef.current.value = "";
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload evidence</DialogTitle>
          <DialogDescription>
            Max 10 MB. Allowed: PDF, Office, CSV, images, JSON, ZIP. The server
            computes the SHA-256 integrity hash after upload.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ev-file">File *</Label>
            <Input
              ref={fileRef}
              id="ev-file"
              type="file"
              accept={ALLOWED_TYPES.join(",")}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                if (f && f.size > MAX_BYTES) {
                  toast.error("File exceeds the 10 MB limit");
                  return;
                }
                if (f && !ALLOWED_TYPES.includes(f.type)) {
                  toast.error(`Unsupported file type: ${f.type || "unknown"}`);
                  return;
                }
                setFile(f);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Classification *</Label>
            <Select value={classification} onValueChange={setClassification}>
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
            <Label htmlFor="ev-src">Source</Label>
            <Input
              id="ev-src"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="e.g. IAM export from AD, 2026-09"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ev-desc">Description</Label>
            <Input
              id="ev-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {progress && (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {progress}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button disabled={!file || busy} onClick={submit}>
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Integrity dialog
// ---------------------------------------------------------------------------

function IntegrityDialog({
  row,
  onClose,
}: {
  row: EvidenceRow | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={row !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Evidence integrity</DialogTitle>
          <DialogDescription>
            SHA-256 digest computed server-side at upload.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="font-medium">{row?.filename}</p>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              SHA-256
            </p>
            <p className="mt-1 break-all font-mono text-xs">{row?.sha256}</p>
          </div>
          <p className="text-xs text-muted-foreground">
            Any modification of the underlying bytes after hashing changes the
            digest and is detected by scheduled integrity verification.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Badge import kept for the restricted-access notice
void Badge;
