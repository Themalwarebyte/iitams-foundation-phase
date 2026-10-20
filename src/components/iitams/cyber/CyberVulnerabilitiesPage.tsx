import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AppLayout } from "@/components/iitams/AppLayout";
import { Breadcrumbs, PageHeader } from "@/components/iitams/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  EmptyState,
  ListSkeleton,
} from "@/components/iitams/audit/ListPageShell";
import {
  ActionStatusPill,
  CyberBoundary,
  CyberUnauthorized,
  Metric,
  SeverityPill,
  VulnerabilityStatusPill,
} from "./CyberPrimitives";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  CVSS_MAX,
  CYBER_ASSET_NAME_MAX,
  CYBER_COMPLETION_NOTES_MIN,
  CYBER_DESCRIPTION_MAX,
  CYBER_EVIDENCE_CLASSIFICATIONS,
  CYBER_REASON_MIN,
  CYBER_SEVERITIES,
  CYBER_SEVERITY_LABELS,
  CYBER_TEXT_MAX,
  CYBER_TITLE_MAX,
  CYBER_VERIFICATION_NOTES_MIN,
  CYBER_VULNERABILITY_SOURCES,
  CYBER_VULNERABILITY_SOURCE_LABELS,
  CYBER_VULNERABILITY_STATUSES,
  CYBER_VULNERABILITY_STATUS_LABELS,
  type CyberSeverity,
  type CyberVulnerabilitySource,
  type CyberVulnerabilityStatus,
} from "@/lib/cyber";
import {
  AlertTriangle,
  Bug,
  CalendarClock,
  CheckCircle2,
  CircleSlash,
  Download,
  FileCheck2,
  Link2,
  ListChecks,
  Loader2,
  PlayCircle,
  Plus,
  Search,
  ShieldCheck,
  ShieldX,
  Upload,
  UserCheck,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

/**
 * Cybersecurity Assurance — vulnerability register (Phase 4A — Batch 1).
 * =====================================================================
 * Registers vulnerabilities with an explicitly governed lifecycle, validates
 * CVSS independently of severity, and tracks remediation actions whose
 * completion is a claim that a DIFFERENT authorized user must verify.
 * Residual risk is never re-scored here: linking an ICT risk row is a
 * traceability link only.
 */

type VulnerabilityRow = {
  _id: Id<"vulnerabilities">;
  reference: string | null;
  title: string;
  description: string | null;
  assetName: string;
  cveId: string | null;
  severity: CyberSeverity;
  severityLabel: string;
  severityRank: number;
  cvssScore: number | null;
  cvssVector: string | null;
  source: CyberVulnerabilitySource | null;
  sourceLabel: string | null;
  status: CyberVulnerabilityStatus;
  statusLabel: string;
  open: boolean;
  discoveredAt: number;
  remediationDue: number | null;
  assessmentId: string | null;
  ownerUserId: string | null;
  ownerLabel: string | null;
  remediationNotes: string | null;
  riskId: string | null;
  remediatedAt: number | null;
  remediatedByUserId: string | null;
  remediatedByLabel: string | null;
  verifiedAt: number | null;
  verifiedByUserId: string | null;
  verifiedByLabel: string | null;
  verificationNotes: string | null;
  closedAt: number | null;
  closureReason: string | null;
  overdue: boolean;
  actions: {
    total: number;
    outstanding: number;
    mandatoryOutstanding: number;
    completedUnverified: number;
    verified: number;
    cancelled: number;
    overdue: number;
  };
  createdAt: number;
  updatedAt: number;
};

type ActionRow = {
  _id: Id<"vulnerabilityRemediationActions">;
  reference: string;
  description: string;
  ownerLabel: string;
  ownerUserId: string | null;
  dueDate: number | null;
  mandatory: boolean;
  status: string;
  statusLabel: string;
  progressNotes: string | null;
  evidenceIds: string[];
  completedAt: number | null;
  completedByUserId: string | null;
  completedByLabel: string | null;
  completionNotes: string | null;
  verifiedAt: number | null;
  verifiedByLabel: string | null;
  verificationNotes: string | null;
  cancelledAt: number | null;
  cancelledByLabel: string | null;
  cancelReason: string | null;
  overdue: boolean;
  createdAt: number;
  updatedAt: number;
};

type EventRow = {
  _id: string;
  type: string;
  actorLabel: string;
  summary: string;
  reason: string | null;
  createdAt: number;
};

type EvidenceRow = {
  _id: Id<"cyberEvidence">;
  filename: string;
  fileType: string;
  sizeBytes: number;
  classification: string;
  description: string | null;
  integrity: string;
  uploadedByLabel: string;
  createdAt: number;
};

type Detail = {
  vulnerability: VulnerabilityRow;
  actions: ActionRow[];
  events: EventRow[];
  evidence: EvidenceRow[];
  assessment: {
    assessmentId: string;
    reference: string | null;
    name: string;
    status: string;
  } | null;
  risk: { riskId: string; code: string; title: string; status: string } | null;
  closureBlockers: string[];
  canManage: boolean;
  currentUserId: string;
};

function dateInput(value: number | null): string {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

function timestamp(value: string): number | undefined {
  if (!value) return undefined;
  const ts = new Date(`${value}T00:00:00`).getTime();
  return Number.isNaN(ts) ? undefined : ts;
}

// ---------------------------------------------------------------------------
// Register form
// ---------------------------------------------------------------------------

function VulnerabilityFormDialog({
  editing,
  onClose,
}: {
  editing: VulnerabilityRow | null;
  onClose: () => void;
}) {
  const options = useQuery(api.cyberAssessments.cyberFormOptions, {}) as
    | {
        assessments: Array<{
          assessmentId: string;
          reference: string | null;
          name: string;
        }>;
        members: Array<{ userId: string; label: string }>;
        risks: Array<{ riskId: string; code: string; title: string }>;
      }
    | undefined;
  const create = useMutation(api.cyberVulnerabilities.createVulnerability);
  const update = useMutation(api.cyberVulnerabilities.updateVulnerability);
  const [form, setForm] = useState({
    title: editing?.title ?? "",
    assetName: editing?.assetName ?? "",
    description: editing?.description ?? "",
    severity: editing?.severity ?? ("medium" as CyberSeverity),
    cvssScore:
      editing?.cvssScore === null || editing?.cvssScore === undefined
        ? ""
        : String(editing.cvssScore),
    cvssVector: editing?.cvssVector ?? "",
    cveId: editing?.cveId ?? "",
    source: editing?.source ?? "",
    assessmentId: editing?.assessmentId ?? "",
    ownerUserId: editing?.ownerUserId ?? "",
    riskId: editing?.riskId ?? "",
    // Blank means "today", which the server stamps when no date is supplied.
    discoveredAt: dateInput(editing?.discoveredAt ?? null),
    remediationDue: dateInput(editing?.remediationDue ?? null),
    remediationNotes: editing?.remediationNotes ?? "",
  });
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const payload = {
        title: form.title,
        assetName: form.assetName,
        description: form.description || undefined,
        severity: form.severity,
        cvssScore: form.cvssScore.trim() ? Number(form.cvssScore) : undefined,
        cvssVector: form.cvssVector || undefined,
        cveId: form.cveId || undefined,
        source: form.source
          ? (form.source as CyberVulnerabilitySource)
          : undefined,
        assessmentId: form.assessmentId
          ? (form.assessmentId as Id<"securityAssessments">)
          : undefined,
        ownerUserId: form.ownerUserId
          ? (form.ownerUserId as Id<"users">)
          : undefined,
        remediationDue: timestamp(form.remediationDue),
        remediationNotes: form.remediationNotes || undefined,
        riskId: form.riskId ? (form.riskId as Id<"risks">) : undefined,
      };
      if (editing) {
        await update({ vulnerabilityId: editing._id, ...payload });
        toast.success("Vulnerability updated");
      } else {
        const result = await create({
          ...payload,
          discoveredAt: timestamp(form.discoveredAt),
        });
        toast.success(`Vulnerability ${result.reference} recorded`);
      }
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit vulnerability" : "Record a vulnerability"}
          </DialogTitle>
          <DialogDescription>
            Severity and CVSS are independent: enter the assessor's real CVSS
            base score only when one exists. No score is ever invented.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="vuln-title">Title</Label>
            <Input
              id="vuln-title"
              value={form.title}
              maxLength={CYBER_TITLE_MAX}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Unpatched TLS library on public gateway"
            />
          </div>
          <div>
            <Label htmlFor="vuln-asset">Affected asset or system</Label>
            <Input
              id="vuln-asset"
              value={form.assetName}
              maxLength={CYBER_ASSET_NAME_MAX}
              onChange={(e) => setForm({ ...form, assetName: e.target.value })}
              placeholder="api-gateway-01"
            />
          </div>
          <div>
            <Label>Severity</Label>
            <Select
              value={form.severity}
              onValueChange={(value) =>
                setForm({ ...form, severity: value as CyberSeverity })
              }
            >
              <SelectTrigger aria-label="Severity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CYBER_SEVERITIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {CYBER_SEVERITY_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="vuln-cvss">CVSS base score (optional)</Label>
            <Input
              id="vuln-cvss"
              type="number"
              min={0}
              max={CVSS_MAX}
              step={0.1}
              value={form.cvssScore}
              onChange={(e) => setForm({ ...form, cvssScore: e.target.value })}
              placeholder="7.5"
            />
          </div>
          <div>
            <Label htmlFor="vuln-vector">CVSS vector (optional)</Label>
            <Input
              id="vuln-vector"
              value={form.cvssVector}
              onChange={(e) => setForm({ ...form, cvssVector: e.target.value })}
              placeholder="CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"
            />
          </div>
          <div>
            <Label htmlFor="vuln-cve">CVE identifier (optional)</Label>
            <Input
              id="vuln-cve"
              value={form.cveId}
              onChange={(e) => setForm({ ...form, cveId: e.target.value })}
              placeholder="CVE-2026-12345"
            />
          </div>
          <div>
            <Label>Discovery method</Label>
            <Select
              value={form.source || "none"}
              onValueChange={(value) =>
                setForm({ ...form, source: value === "none" ? "" : value })
              }
            >
              <SelectTrigger aria-label="Discovery method">
                <SelectValue placeholder="Not recorded" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not recorded</SelectItem>
                {CYBER_VULNERABILITY_SOURCES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {CYBER_VULNERABILITY_SOURCE_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Related assessment</Label>
            <Select
              value={form.assessmentId || "none"}
              onValueChange={(value) =>
                setForm({ ...form, assessmentId: value === "none" ? "" : value })
              }
            >
              <SelectTrigger aria-label="Related assessment">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not linked</SelectItem>
                {(options?.assessments ?? []).map((row) => (
                  <SelectItem key={row.assessmentId} value={row.assessmentId}>
                    {row.reference ? `${row.reference} · ` : ""}
                    {row.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Owner</Label>
            <Select
              value={form.ownerUserId || "me"}
              onValueChange={(value) =>
                setForm({ ...form, ownerUserId: value === "me" ? "" : value })
              }
            >
              <SelectTrigger aria-label="Owner">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="me">Recorded by me</SelectItem>
                {(options?.members ?? []).map((member) => (
                  <SelectItem key={member.userId} value={member.userId}>
                    {member.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Linked ICT risk (optional)</Label>
            <Select
              value={form.riskId || "none"}
              onValueChange={(value) =>
                setForm({ ...form, riskId: value === "none" ? "" : value })
              }
            >
              <SelectTrigger aria-label="Linked risk">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not linked</SelectItem>
                {(options?.risks ?? []).map((row) => (
                  <SelectItem key={row.riskId} value={row.riskId}>
                    {row.code} · {row.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="vuln-discovered">Discovered</Label>
            <Input
              id="vuln-discovered"
              type="date"
              value={form.discoveredAt}
              disabled={Boolean(editing)}
              onChange={(e) => setForm({ ...form, discoveredAt: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="vuln-due">Remediation target date</Label>
            <Input
              id="vuln-due"
              type="date"
              value={form.remediationDue}
              onChange={(e) =>
                setForm({ ...form, remediationDue: e.target.value })
              }
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="vuln-description">Description</Label>
            <Textarea
              id="vuln-description"
              rows={3}
              maxLength={CYBER_DESCRIPTION_MAX}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="vuln-remediation-notes">Remediation notes</Label>
            <Textarea
              id="vuln-remediation-notes"
              rows={2}
              maxLength={CYBER_TEXT_MAX}
              value={form.remediationNotes}
              onChange={(e) =>
                setForm({ ...form, remediationNotes: e.target.value })
              }
              placeholder="Notes are not a completion claim; the lifecycle records that separately."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={
              busy ||
              form.title.trim().length < 4 ||
              form.assetName.trim().length < 2
            }
          >
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            {editing ? "Save changes" : "Record vulnerability"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Reusable note/reason dialog
// ---------------------------------------------------------------------------

function NoteDialog({
  title,
  description,
  label,
  placeholder,
  minLength,
  submitLabel,
  destructive,
  onClose,
  onSubmit,
}: {
  title: string;
  description: string;
  label: string;
  placeholder: string;
  minLength: number;
  submitLabel: string;
  destructive?: boolean;
  onClose: () => void;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div>
          <Label htmlFor="note-dialog-field">{label}</Label>
          <Textarea
            id="note-dialog-field"
            rows={4}
            value={value}
            maxLength={CYBER_TEXT_MAX}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Minimum {minLength} characters. Recorded permanently with your name.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={busy || value.trim().length < minLength}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit(value.trim());
                onClose();
              } catch (error) {
                toast.error(
                  error instanceof Error ? error.message : "Action failed",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Action assignment
// ---------------------------------------------------------------------------

function ActionFormDialog({
  vulnerabilityId,
  onClose,
}: {
  vulnerabilityId: Id<"vulnerabilities">;
  onClose: () => void;
}) {
  const options = useQuery(api.cyberAssessments.cyberFormOptions, {}) as
    | { members: Array<{ userId: string; label: string }> }
    | undefined;
  const create = useMutation(api.cyberActions.createRemediationAction);
  const [form, setForm] = useState({
    description: "",
    ownerUserId: "",
    dueDate: "",
    mandatory: true,
    progressNotes: "",
  });
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign remediation action</DialogTitle>
          <DialogDescription>
            Actions are explicit work. Completion is recorded separately from
            independent verification.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="action-description">Action</Label>
            <Textarea
              id="action-description"
              rows={3}
              maxLength={CYBER_TEXT_MAX}
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              placeholder="Patch the affected gateway and produce a scan report proving the fix"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Owner</Label>
              <Select
                value={form.ownerUserId || "me"}
                onValueChange={(value) =>
                  setForm({
                    ...form,
                    ownerUserId: value === "me" ? "" : value,
                  })
                }
              >
                <SelectTrigger aria-label="Action owner">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="me">Recorded by me</SelectItem>
                  {(options?.members ?? []).map((member) => (
                    <SelectItem key={member.userId} value={member.userId}>
                      {member.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="action-due">Due date</Label>
              <Input
                id="action-due"
                type="date"
                value={form.dueDate}
                onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.mandatory}
              onChange={(e) =>
                setForm({ ...form, mandatory: e.target.checked })
              }
            />
            Mandatory before the vulnerability can be closed
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy || form.description.trim().length < 10}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await create({
                  vulnerabilityId,
                  description: form.description,
                  ownerUserId: form.ownerUserId
                    ? (form.ownerUserId as Id<"users">)
                    : undefined,
                  dueDate: timestamp(form.dueDate),
                  mandatory: form.mandatory,
                  progressNotes: form.progressNotes || undefined,
                });
                toast.success(`Action ${result.reference} assigned`);
                onClose();
              } catch (error) {
                toast.error(
                  error instanceof Error ? error.message : "Could not assign",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Assign action
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

type DialogKind =
  | "remediate"
  | "verify"
  | "accept"
  | "false_positive"
  | "close"
  | "reopen"
  | "action_complete"
  | "action_verify"
  | "action_fail"
  | "action_cancel"
  | "link_risk";

function DetailDialog({
  vulnerabilityId,
  onClose,
}: {
  vulnerabilityId: Id<"vulnerabilities">;
  onClose: () => void;
}) {
  const detail = useQuery(api.cyberVulnerabilities.getVulnerability, {
    vulnerabilityId,
  }) as Detail | undefined;
  const confirmVuln = useMutation(
    api.cyberVulnerabilities.confirmVulnerability,
  );
  const startRemediation = useMutation(
    api.cyberVulnerabilities.startVulnerabilityRemediation,
  );
  const markRemediated = useMutation(
    api.cyberVulnerabilities.markVulnerabilityRemediated,
  );
  const verifyVulnerability = useMutation(
    api.cyberVulnerabilities.verifyVulnerability,
  );
  const acceptRisk = useMutation(
    api.cyberVulnerabilities.acceptVulnerabilityRisk,
  );
  const falsePositive = useMutation(
    api.cyberVulnerabilities.markVulnerabilityFalsePositive,
  );
  const closeVulnerability = useMutation(
    api.cyberVulnerabilities.closeVulnerability,
  );
  const reopenVulnerability = useMutation(
    api.cyberVulnerabilities.reopenVulnerability,
  );
  const linkRisk = useMutation(api.cyberVulnerabilities.linkVulnerabilityRisk);
  const startAction = useMutation(api.cyberActions.startRemediationAction);
  const completeAction = useMutation(
    api.cyberActions.completeRemediationAction,
  );
  const verifyAction = useMutation(api.cyberActions.verifyRemediationAction);
  const failAction = useMutation(
    api.cyberActions.failRemediationVerification,
  );
  const closeAction = useMutation(api.cyberActions.closeRemediationAction);
  const cancelAction = useMutation(api.cyberActions.cancelRemediationAction);
  const generateUploadUrl = useMutation(
    api.cyberEvidence.generateEvidenceUploadUrl,
  );
  const confirmUpload = useMutation(api.cyberEvidence.confirmEvidenceUpload);
  const downloadEvidence = useMutation(api.cyberEvidence.evidenceDownloadUrl);

  const options = useQuery(api.cyberAssessments.cyberFormOptions, {}) as
    | { risks: Array<{ riskId: string; code: string; title: string }> }
    | undefined;

  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [activeAction, setActiveAction] = useState<ActionRow | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [classification, setClassification] = useState("internal");
  const [uploading, setUploading] = useState(false);
  const [riskChoice, setRiskChoice] = useState("");

  const vulnerability = detail?.vulnerability;
  const canManage = detail?.canManage === true;

  async function runTransition(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toast.error("Choose a file to upload");
      return;
    }
    setUploading(true);
    try {
      const url = await generateUploadUrl();
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
        },
        body: file,
      });
      if (!response.ok) throw new Error("Upload failed");
      const body = (await response.json()) as { storageId?: string };
      if (!body.storageId) throw new Error("Upload did not return a storage id");
      await confirmUpload({
        storageId: body.storageId as Id<"_storage">,
        vulnerabilityId,
        filename: file.name,
        fileType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        classification: classification as
          | "public"
          | "internal"
          | "confidential"
          | "restricted",
      });
      toast.success("Evidence recorded; integrity hashing scheduled");
      if (fileRef.current) fileRef.current.value = "";
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  const noteDialog = (() => {
    if (!dialog || !vulnerability) return null;
    if (dialog === "remediate") {
      return (
        <NoteDialog
          title="Record remediation"
          description="This records that the fix was applied. It is NOT verification: a different authorized user must verify it before the record can be closed."
          label="Remediation notes"
          placeholder="Patch applied to all three gateway nodes and change record raised"
          minLength={CYBER_COMPLETION_NOTES_MIN}
          submitLabel="Record remediation"
          onClose={() => setDialog(null)}
          onSubmit={async (notes) => {
            await markRemediated({ vulnerabilityId, notes });
            toast.success("Remediation recorded; awaiting verification");
          }}
        />
      );
    }
    if (dialog === "verify") {
      return (
        <NoteDialog
          title="Verify remediation"
          description="You must be a different person from whoever recorded the remediation. Your verification is recorded permanently."
          label="Verification notes"
          placeholder="Re-scanned the gateway; the reported CVE no longer appears"
          minLength={CYBER_VERIFICATION_NOTES_MIN}
          submitLabel="Verify"
          onClose={() => setDialog(null)}
          onSubmit={async (notes) => {
            await verifyVulnerability({ vulnerabilityId, notes });
            toast.success("Remediation verified");
          }}
        />
      );
    }
    if (dialog === "accept") {
      return (
        <NoteDialog
          title="Accept the risk"
          description="Risk acceptance is recorded with your reason. It does not change any ICT risk score — residual risk stays with the Risk Assessment workflow."
          label="Reason"
          placeholder="Compensating controls reduce likelihood; accepted until the platform is retired"
          minLength={CYBER_REASON_MIN}
          submitLabel="Accept risk"
          destructive
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            await acceptRisk({ vulnerabilityId, reason });
            toast.success("Risk accepted");
          }}
        />
      );
    }
    if (dialog === "false_positive") {
      return (
        <NoteDialog
          title="Mark false positive"
          description="Record why the finding does not apply. The record stays in the register as a false positive."
          label="Rationale"
          placeholder="Scanner matched a banner version that is not deployed"
          minLength={CYBER_REASON_MIN}
          submitLabel="Mark false positive"
          destructive
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            await falsePositive({ vulnerabilityId, reason });
            toast.success("Marked as false positive");
          }}
        />
      );
    }
    if (dialog === "close") {
      return (
        <NoteDialog
          title="Close vulnerability"
          description={
            detail && detail.closureBlockers.length > 0
              ? `Resolve the outstanding actions first: ${detail.closureBlockers.join("; ")}`
              : "Closing keeps the full history. Only a verified, risk-accepted or false-positive record can be closed."
          }
          label="Closure reason"
          placeholder="Verified remediation confirmed by the security team"
          minLength={CYBER_REASON_MIN}
          submitLabel="Close vulnerability"
          onClose={() => setDialog(null)}
          onSubmit={async (closureReason) => {
            await closeVulnerability({ vulnerabilityId, closureReason });
            toast.success("Vulnerability closed");
          }}
        />
      );
    }
    if (dialog === "reopen") {
      return (
        <NoteDialog
          title="Reopen vulnerability"
          description="Reopening clears the remediation and verification stamps so the new cycle starts fresh; the earlier history is preserved."
          label="Reason"
          placeholder="Regression detected in the latest scan"
          minLength={CYBER_REASON_MIN}
          submitLabel="Reopen"
          destructive
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            await reopenVulnerability({ vulnerabilityId, reason });
            toast.success("Vulnerability reopened");
          }}
        />
      );
    }
    if (dialog === "action_complete") {
      return (
        <NoteDialog
          title="Complete remediation action"
          description="Completion is a claim. A different authorized user must verify the work before the action can be closed."
          label="Completion notes"
          placeholder="Configuration applied and change record CHG-1042 attached"
          minLength={CYBER_COMPLETION_NOTES_MIN}
          submitLabel="Report complete"
          onClose={() => setDialog(null)}
          onSubmit={async (completionNotes) => {
            await completeAction({ actionId: activeAction!._id, completionNotes });
            toast.success("Action reported complete; awaiting verification");
          }}
        />
      );
    }
    if (dialog === "action_verify") {
      return (
        <NoteDialog
          title="Verify remediation action"
          description="The implementer cannot verify their own action."
          label="Verification notes"
          placeholder="Inspected the change record and confirmed the configuration"
          minLength={CYBER_VERIFICATION_NOTES_MIN}
          submitLabel="Verify action"
          onClose={() => setDialog(null)}
          onSubmit={async (verificationNotes) => {
            await verifyAction({
              actionId: activeAction!._id,
              verificationNotes,
            });
            toast.success("Action verified");
          }}
        />
      );
    }
    if (dialog === "action_fail") {
      return (
        <NoteDialog
          title="Reject completion claim"
          description="The action returns to active remediation and the rejection is recorded."
          label="Reason"
          placeholder="Configuration was applied to only one of the three nodes"
          minLength={CYBER_VERIFICATION_NOTES_MIN}
          submitLabel="Return to remediation"
          destructive
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            await failAction({ actionId: activeAction!._id, reason });
            toast.success("Completion claim rejected");
          }}
        />
      );
    }
    if (dialog === "action_cancel") {
      return (
        <NoteDialog
          title="Cancel remediation action"
          description="Cancelling is permanent and recorded with your reason."
          label="Cancellation reason"
          placeholder="Superseded by the platform upgrade work"
          minLength={CYBER_REASON_MIN}
          submitLabel="Cancel action"
          destructive
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            await cancelAction({ actionId: activeAction!._id, reason });
            toast.success("Action cancelled");
          }}
        />
      );
    }
    return null;
  })();

  return (
    <>
      <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
        <DialogContent className="max-w-4xl max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              {vulnerability?.reference ?? "Vulnerability"}
              <span className="text-muted-foreground">{vulnerability?.title}</span>
              {vulnerability ? (
                <VulnerabilityStatusPill
                  status={vulnerability.status}
                  label={vulnerability.statusLabel}
                />
              ) : null}
            </DialogTitle>
            <DialogDescription>
              {vulnerability
                ? `${vulnerability.assetName}${
                    vulnerability.cveId ? ` · ${vulnerability.cveId}` : ""
                  }`
                : "Loading vulnerability…"}
            </DialogDescription>
          </DialogHeader>

          {!detail || !vulnerability ? (
            <ListSkeleton rows={4} />
          ) : (
            <div className="space-y-6">
              <div className="grid gap-3 sm:grid-cols-4">
                <Metric
                  label="Severity"
                  value={vulnerability.severityLabel}
                  hint={
                    vulnerability.cvssScore === null
                      ? "No CVSS score recorded"
                      : `CVSS ${vulnerability.cvssScore.toFixed(1)}`
                  }
                />
                <Metric
                  label="Discovered"
                  value={formatDate(vulnerability.discoveredAt)}
                />
                <Metric
                  label="Remediation due"
                  value={formatDate(vulnerability.remediationDue)}
                  tone={vulnerability.overdue ? "text-critical" : undefined}
                  hint={vulnerability.overdue ? "Overdue" : undefined}
                />
                <Metric
                  label="Actions"
                  value={`${vulnerability.actions.outstanding} open / ${vulnerability.actions.total}`}
                  hint={
                    vulnerability.actions.completedUnverified > 0
                      ? `${vulnerability.actions.completedUnverified} awaiting verification`
                      : undefined
                  }
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Owner
                  </p>
                  <p className="text-sm">{vulnerability.ownerLabel ?? "—"}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Discovery method
                  </p>
                  <p className="text-sm">{vulnerability.sourceLabel ?? "—"}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Related assessment
                  </p>
                  <p className="text-sm">
                    {detail.assessment
                      ? `${detail.assessment.reference ?? ""} ${detail.assessment.name}`
                      : "Not linked"}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Linked ICT risk
                  </p>
                  <p className="text-sm">
                    {detail.risk
                      ? `${detail.risk.code} · ${detail.risk.title}`
                      : "Not linked"}
                  </p>
                </div>
              </div>

              {vulnerability.description ? (
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Description
                  </p>
                  <p className="text-sm whitespace-pre-wrap">
                    {vulnerability.description}
                  </p>
                </div>
              ) : null}
              {vulnerability.remediationNotes ? (
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Remediation notes
                  </p>
                  <p className="text-sm whitespace-pre-wrap">
                    {vulnerability.remediationNotes}
                  </p>
                </div>
              ) : null}
              {vulnerability.remediatedAt ? (
                <div className="rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
                  <p>
                    Remediation recorded by{" "}
                    <strong>{vulnerability.remediatedByLabel ?? "—"}</strong> on{" "}
                    {formatDateTime(vulnerability.remediatedAt)}.
                    {vulnerability.verifiedAt
                      ? ` Verified by ${vulnerability.verifiedByLabel ?? "—"} on ${formatDateTime(vulnerability.verifiedAt)}.`
                      : " Independent verification is still outstanding."}
                  </p>
                  {vulnerability.verificationNotes ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {vulnerability.verificationNotes}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {vulnerability.closureReason ? (
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Closure reason
                  </p>
                  <p className="text-sm whitespace-pre-wrap">
                    {vulnerability.closureReason}
                  </p>
                </div>
              ) : null}

              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    <ListChecks className="size-4" aria-hidden />
                    Remediation actions
                  </h3>
                  {canManage && vulnerability.status !== "closed" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setAssigning(true)}
                    >
                      <Plus className="mr-1 size-4" aria-hidden />
                      Assign action
                    </Button>
                  ) : null}
                </div>
                {detail.actions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No remediation actions assigned yet.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {detail.actions.map((action) => (
                      <li
                        key={action._id}
                        className="rounded-lg border border-border/70 p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                              <span className="font-mono text-xs text-muted-foreground">
                                {action.reference}
                              </span>
                              {action.description}
                              <ActionStatusPill
                                status={action.status}
                                label={action.statusLabel}
                              />
                              {action.mandatory ? (
                                <Badge variant="outline" className="text-[10px]">
                                  Mandatory
                                </Badge>
                              ) : null}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {action.ownerLabel} · due{" "}
                              <span className={action.overdue ? "text-critical" : ""}>
                                {formatDate(action.dueDate)}
                              </span>
                            </p>
                            {action.completionNotes ? (
                              <p className="mt-1 text-xs">
                                Completed claim: {action.completionNotes}
                                {action.completedByLabel
                                  ? ` — ${action.completedByLabel}`
                                  : ""}
                              </p>
                            ) : null}
                            {action.verificationNotes ? (
                              <p className="mt-1 text-xs text-muted-foreground">
                                Verification: {action.verificationNotes}
                              </p>
                            ) : null}
                            {action.cancelReason ? (
                              <p className="mt-1 text-xs text-muted-foreground">
                                Cancelled: {action.cancelReason}
                              </p>
                            ) : null}
                          </div>
                          {canManage ? (
                            <div className="flex flex-wrap gap-1">
                              {action.status === "open" ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() =>
                                    runTransition(
                                      () => startAction({ actionId: action._id }),
                                      "Action started",
                                    )
                                  }
                                >
                                  <PlayCircle className="mr-1 size-4" aria-hidden />
                                  Start
                                </Button>
                              ) : null}
                              {action.status === "open" ||
                              action.status === "in_progress" ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => {
                                    setActiveAction(action);
                                    setDialog("action_complete");
                                  }}
                                >
                                  <CheckCircle2
                                    className="mr-1 size-4"
                                    aria-hidden
                                  />
                                  Complete
                                </Button>
                              ) : null}
                              {action.status === "completed" ? (
                                <>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={
                                      action.completedByUserId ===
                                      detail.currentUserId
                                    }
                                    title={
                                      action.completedByUserId ===
                                      detail.currentUserId
                                        ? "The implementer cannot verify their own action"
                                        : undefined
                                    }
                                    onClick={() => {
                                      setActiveAction(action);
                                      setDialog("action_verify");
                                    }}
                                  >
                                    <UserCheck
                                      className="mr-1 size-4"
                                      aria-hidden
                                    />
                                    Verify
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={
                                      action.completedByUserId ===
                                      detail.currentUserId
                                    }
                                    onClick={() => {
                                      setActiveAction(action);
                                      setDialog("action_fail");
                                    }}
                                  >
                                    <XCircle
                                      className="mr-1 size-4"
                                      aria-hidden
                                    />
                                    Reject
                                  </Button>
                                </>
                              ) : null}
                              {action.status === "verified" ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() =>
                                    runTransition(
                                      () => closeAction({ actionId: action._id }),
                                      "Action closed",
                                    )
                                  }
                                >
                                  <ShieldCheck
                                    className="mr-1 size-4"
                                    aria-hidden
                                  />
                                  Close
                                </Button>
                              ) : null}
                              {action.status === "open" ||
                              action.status === "in_progress" ||
                              action.status === "completed" ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => {
                                    setActiveAction(action);
                                    setDialog("action_cancel");
                                  }}
                                >
                                  <CircleSlash
                                    className="mr-1 size-4"
                                    aria-hidden
                                  />
                                  Cancel
                                </Button>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <FileCheck2 className="size-4" aria-hidden />
                  Evidence
                </h3>
                {detail.evidence.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No evidence recorded for this vulnerability.
                  </p>
                ) : (
                  <ul className="divide-y divide-border/70 rounded-lg border border-border/70">
                    {detail.evidence.map((row) => (
                      <li
                        key={row._id}
                        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                      >
                        <span className="min-w-0">
                          <span className="block truncate">{row.filename}</span>
                          <span className="text-xs text-muted-foreground">
                            {row.classification} · integrity {row.integrity} ·{" "}
                            {row.uploadedByLabel}
                          </span>
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            try {
                              const result = await downloadEvidence({
                                evidenceId: row._id,
                              });
                              window.open(
                                result.url,
                                "_blank",
                                "noopener,noreferrer",
                              );
                            } catch (error) {
                              toast.error(
                                error instanceof Error
                                  ? error.message
                                  : "Evidence unavailable",
                              );
                            }
                          }}
                        >
                          <Download className="mr-1 size-4" aria-hidden />
                          Open
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {canManage ? (
                  <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-border/80 p-3">
                    <div className="min-w-0 flex-1">
                      <Label htmlFor="evidence-file">Add evidence</Label>
                      <input
                        id="evidence-file"
                        ref={fileRef}
                        type="file"
                        className="mt-1 block w-full text-xs"
                        aria-label="Evidence file"
                      />
                    </div>
                    <div>
                      <Label>Classification</Label>
                      <Select
                        value={classification}
                        onValueChange={setClassification}
                      >
                        <SelectTrigger
                          className="w-36"
                          aria-label="Evidence classification"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CYBER_EVIDENCE_CLASSIFICATIONS.map((value) => (
                            <SelectItem key={value} value={value}>
                              {value}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button onClick={upload} disabled={uploading}>
                      {uploading ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <Upload className="mr-2 size-4" aria-hidden />
                      )}
                      Upload
                    </Button>
                  </div>
                ) : null}
              </div>

              <div>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <CalendarClock className="size-4" aria-hidden />
                  History
                </h3>
                <ol className="space-y-2 border-l border-border/70 pl-4">
                  {detail.events.length === 0 ? (
                    <li className="text-sm text-muted-foreground">
                      No history recorded.
                    </li>
                  ) : (
                    detail.events.map((event) => (
                      <li key={event._id} className="text-sm">
                        <p>{event.summary}</p>
                        <p className="text-xs text-muted-foreground">
                          {event.actorLabel} · {formatDateTime(event.createdAt)}
                        </p>
                        {event.reason ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {event.reason}
                          </p>
                        ) : null}
                      </li>
                    ))
                  )}
                </ol>
              </div>

              <DialogFooter className="flex-wrap gap-2">
                {canManage ? (
                  <>
                    {vulnerability.status === "open" ? (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          runTransition(
                            () => confirmVuln({ vulnerabilityId }),
                            "Vulnerability confirmed",
                          )
                        }
                      >
                        <ShieldCheck className="mr-2 size-4" aria-hidden />
                        Confirm
                      </Button>
                    ) : null}
                    {vulnerability.status === "confirmed" ? (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          runTransition(
                            () => startRemediation({ vulnerabilityId }),
                            "Remediation started",
                          )
                        }
                      >
                        <PlayCircle className="mr-2 size-4" aria-hidden />
                        Start remediation
                      </Button>
                    ) : null}
                    {vulnerability.status === "confirmed" ||
                    vulnerability.status === "in_remediation" ? (
                      <Button
                        size="sm"
                        onClick={() => setDialog("remediate")}
                      >
                        <CheckCircle2 className="mr-2 size-4" aria-hidden />
                        Record remediation
                      </Button>
                    ) : null}
                    {vulnerability.status === "remediated" ? (
                      <Button
                        size="sm"
                        disabled={
                          vulnerability.remediatedByUserId ===
                          detail.currentUserId
                        }
                        title={
                          vulnerability.remediatedByUserId ===
                          detail.currentUserId
                            ? "The person who recorded remediation cannot verify it"
                            : undefined
                        }
                        onClick={() => setDialog("verify")}
                      >
                        <UserCheck className="mr-2 size-4" aria-hidden />
                        Verify
                      </Button>
                    ) : null}
                    {vulnerability.status === "open" ||
                    vulnerability.status === "confirmed" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDialog("false_positive")}
                      >
                        <CircleSlash className="mr-2 size-4" aria-hidden />
                        False positive
                      </Button>
                    ) : null}
                    {vulnerability.status === "open" ||
                    vulnerability.status === "confirmed" ||
                    vulnerability.status === "in_remediation" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDialog("accept")}
                      >
                        <AlertTriangle className="mr-2 size-4" aria-hidden />
                        Accept risk
                      </Button>
                    ) : null}
                    {vulnerability.status === "verified" ||
                    vulnerability.status === "risk_accepted" ||
                    vulnerability.status === "false_positive" ? (
                      <Button size="sm" onClick={() => setDialog("close")}>
                        <ShieldCheck className="mr-2 size-4" aria-hidden />
                        Close
                      </Button>
                    ) : null}
                    {vulnerability.status === "closed" ||
                    vulnerability.status === "verified" ||
                    vulnerability.status === "risk_accepted" ||
                    vulnerability.status === "false_positive" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDialog("reopen")}
                      >
                        <XCircle className="mr-2 size-4" aria-hidden />
                        Reopen
                      </Button>
                    ) : null}
                    {!detail.risk ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDialog("link_risk")}
                      >
                        <Link2 className="mr-2 size-4" aria-hidden />
                        Link ICT risk
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <Badge variant="outline" className="gap-1">
                    <ShieldX className="size-3.5" aria-hidden />
                    Read-only
                  </Badge>
                )}
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {assigning ? (
        <ActionFormDialog
          vulnerabilityId={vulnerabilityId}
          onClose={() => setAssigning(false)}
        />
      ) : null}
      {noteDialog}

      {dialog === "link_risk" ? (
        <Dialog open onOpenChange={(open) => (!open ? setDialog(null) : undefined)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Link an ICT risk</DialogTitle>
              <DialogDescription>
                This is a traceability link only. It never modifies the risk's
                likelihood, impact or residual score.
              </DialogDescription>
            </DialogHeader>
            <Select value={riskChoice} onValueChange={setRiskChoice}>
              <SelectTrigger aria-label="ICT risk">
                <SelectValue placeholder="Choose a risk" />
              </SelectTrigger>
              <SelectContent>
                {(options?.risks ?? []).map((risk) => (
                  <SelectItem key={risk.riskId} value={risk.riskId}>
                    {risk.code} · {risk.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button
                disabled={!riskChoice || busy}
                onClick={() =>
                  runTransition(async () => {
                    await linkRisk({
                      vulnerabilityId,
                      riskId: riskChoice as Id<"risks">,
                    });
                    toast.success("Risk linked");
                    setDialog(null);
                  }, "Risk linked")
                }
              >
                Link risk
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

function CyberVulnerabilitiesInner() {
  const session = useQuery(api.session.getSession);
  const canView = session?.permissions?.cyber === true;
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<VulnerabilityRow | null>(null);
  const [detailId, setDetailId] = useState<Id<"vulnerabilities"> | null>(null);

  const data = useQuery(
    api.cyberVulnerabilities.listVulnerabilities,
    canView
      ? {
          search: search || undefined,
          status:
            status === "all"
              ? undefined
              : (status as CyberVulnerabilityStatus),
          severity:
            severity === "all" ? undefined : (severity as CyberSeverity),
          overdueOnly: overdueOnly || undefined,
        }
      : "skip",
  ) as
    | {
        rows: VulnerabilityRow[];
        summary: {
          total: number;
          open: number;
          critical: number;
          high: number;
          overdue: number;
          unverified: number;
          riskAccepted: number;
          verified: number;
          closed: number;
          canManage: boolean;
          currentUserId: string;
        };
      }
    | undefined;

  if (session === undefined) {
    return (
      <AppLayout>
        <Breadcrumbs path="/cyber/vulnerabilities" />
        <ListSkeleton rows={6} />
      </AppLayout>
    );
  }
  if (!canView) return <CyberUnauthorized path="/cyber/vulnerabilities" />;

  const rows = data?.rows ?? [];
  const summary = data?.summary;
  const canManage = summary?.canManage === true;

  return (
    <AppLayout>
      <Breadcrumbs path="/cyber/vulnerabilities" />
      <PageHeader
        eyebrow="Cybersecurity Assurance"
        title="Vulnerabilities"
        description="Organization-scoped vulnerability records with explicit remediation, independent verification and closure. Severity and CVSS are recorded independently; residual risk remains with the ICT Risk Assessment workflow."
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="mr-2 size-4" aria-hidden />
              Record vulnerability
            </Button>
          ) : undefined
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Records" value={summary?.total ?? 0} />
        <Metric label="Open" value={summary?.open ?? 0} />
        <Metric
          label="Critical / high open"
          value={`${summary?.critical ?? 0} / ${summary?.high ?? 0}`}
          tone={(summary?.critical ?? 0) > 0 ? "text-critical" : undefined}
        />
        <Metric
          label="Overdue"
          value={summary?.overdue ?? 0}
          tone={(summary?.overdue ?? 0) > 0 ? "text-critical" : undefined}
          hint={
            (summary?.unverified ?? 0) > 0
              ? `${summary?.unverified} awaiting verification`
              : undefined
          }
        />
      </div>

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Bug className="size-4" aria-hidden />
                Vulnerability register
              </CardTitle>
              <CardDescription>
                Highest severity first. Overdue records are those past their
                remediation target date and still open.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search
                  className="absolute left-2.5 top-2.5 size-4 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  className="w-56 pl-8"
                  placeholder="Search reference, title, asset…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Search vulnerabilities"
                />
              </div>
              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger className="w-36" aria-label="Filter by severity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All severities</SelectItem>
                  {CYBER_SEVERITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {CYBER_SEVERITY_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-48" aria-label="Filter by status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {CYBER_VULNERABILITY_STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {CYBER_VULNERABILITY_STATUS_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={overdueOnly}
                  onChange={(e) => setOverdueOnly(e.target.checked)}
                />
                Overdue only
              </label>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {data === undefined ? (
            <ListSkeleton rows={6} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Bug}
              title="No vulnerabilities match this view"
              description={
                canManage
                  ? "Record a vulnerability to begin tracking remediation and independent verification."
                  : "There are no vulnerability records in this organization yet."
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Vulnerability</TableHead>
                  <TableHead>Asset</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Actions</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row._id}>
                    <TableCell className="font-mono text-xs">
                      {row.reference ?? "—"}
                    </TableCell>
                    <TableCell className="max-w-[230px]">
                      <span className="block truncate font-medium">
                        {row.title}
                      </span>
                      {row.cveId ? (
                        <span className="block font-mono text-[11px] text-muted-foreground">
                          {row.cveId}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-[150px] truncate text-xs">
                      {row.assetName}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <SeverityPill
                          severity={row.severity}
                          label={row.severityLabel}
                        />
                        <span className="text-[11px] text-muted-foreground">
                          {row.cvssScore === null
                            ? "CVSS not recorded"
                            : `CVSS ${row.cvssScore.toFixed(1)}`}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <VulnerabilityStatusPill
                        status={row.status}
                        label={row.statusLabel}
                      />
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.ownerLabel ?? "—"}
                    </TableCell>
                    <TableCell
                      className={
                        row.overdue ? "text-xs text-critical" : "text-xs"
                      }
                    >
                      {formatDate(row.remediationDue)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.actions.outstanding} open
                      {row.actions.completedUnverified > 0 ? (
                        <span className="block text-muted-foreground">
                          {row.actions.completedUnverified} unverified
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage &&
                      row.status !== "remediated" &&
                      row.status !== "verified" &&
                      row.status !== "closed" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(row)}
                        >
                          Edit
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDetailId(row._id)}
                      >
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {creating ? (
        <VulnerabilityFormDialog
          editing={null}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {editing ? (
        <VulnerabilityFormDialog
          editing={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {detailId ? (
        <DetailDialog
          vulnerabilityId={detailId}
          onClose={() => setDetailId(null)}
        />
      ) : null}
    </AppLayout>
  );
}

export default function CyberVulnerabilitiesPage() {
  return (
    <CyberBoundary title="Vulnerabilities">
      <CyberVulnerabilitiesInner />
    </CyberBoundary>
  );
}
