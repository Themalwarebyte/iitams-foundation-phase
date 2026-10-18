import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useSearchParams } from "react-router";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AppLayout } from "@/components/iitams/AppLayout";
import { Breadcrumbs, PageHeader } from "@/components/iitams/PageHeader";
import { EmptyState, ListSkeleton } from "@/components/iitams/audit/ListPageShell";
import { RiskScoreBadge, StatusChip } from "@/components/iitams/badges";
import { RiskAssessments } from "./RiskAssessments";
import { RiskTreatmentPlans } from "./RiskTreatmentPlans";
import { KpiCard } from "@/components/iitams/KpiCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  RISK_CATEGORIES,
  RISK_STATUSES,
  RISK_STATUS_LABELS,
  RISK_TEXT_MAX,
  RISK_TITLE_MAX,
  riskBand,
  riskScore,
  type RiskBand,
  type RiskCategory,
  type RiskStatus,
} from "@/lib/risk";
import { formatDate } from "@/lib/format";
import {
  AlertTriangle,
  CalendarClock,
  ClipboardList,
  Loader2,
  Pencil,
  Plus,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

/**
 * /risk/register — Phase 3B Batch 1: ICT Risk Register foundation.
 * ===============================================================
 * Organization-scoped register of ICT risks with the canonical 5×5 inherent /
 * residual scoring model. Reads require `risk.view`, writes `risk.manage`; the
 * server is authoritative for both, for scoring and for tenant isolation. The
 * page reflects permissions for presentation only.
 */

const FACTORS = [1, 2, 3, 4, 5] as const;

type RiskRow = {
  _id: string;
  code: string;
  title: string;
  description?: string;
  category: RiskCategory;
  assetOrService?: string;
  threat?: string;
  vulnerability?: string;
  inherentLikelihood: number;
  inherentImpact: number;
  inherentScore: number;
  inherentBand: RiskBand;
  residualLikelihood: number;
  residualImpact: number;
  residualScore: number;
  residualBand: RiskBand;
  existingControls?: string;
  treatmentRecommendation?: string;
  status: RiskStatus;
  ownerName?: string;
  reviewDue?: number;
  reviewOverdue: boolean;
};

type RiskDetail = RiskRow & {
  history: Array<{
    action: string;
    summary?: string;
    actorLabel?: string;
    createdAt: number;
  }>;
};

interface RiskFormState {
  title: string;
  category: RiskCategory;
  description: string;
  assetOrService: string;
  threat: string;
  vulnerability: string;
  inherentLikelihood: number;
  inherentImpact: number;
  residualLikelihood: number;
  residualImpact: number;
  existingControls: string;
  treatmentRecommendation: string;
  ownerName: string;
  reviewDue: string;
  status?: RiskStatus;
}

function emptyForm(): RiskFormState {
  return {
    title: "",
    category: "Cyber",
    description: "",
    assetOrService: "",
    threat: "",
    vulnerability: "",
    inherentLikelihood: 3,
    inherentImpact: 3,
    residualLikelihood: 2,
    residualImpact: 3,
    existingControls: "",
    treatmentRecommendation: "",
    ownerName: "",
    reviewDue: "",
  };
}

function toForm(risk: RiskDetail): RiskFormState {
  return {
    title: risk.title,
    category: risk.category,
    description: risk.description ?? "",
    assetOrService: risk.assetOrService ?? "",
    threat: risk.threat ?? "",
    vulnerability: risk.vulnerability ?? "",
    inherentLikelihood: risk.inherentLikelihood,
    inherentImpact: risk.inherentImpact,
    residualLikelihood: risk.residualLikelihood,
    residualImpact: risk.residualImpact,
    existingControls: risk.existingControls ?? "",
    treatmentRecommendation: risk.treatmentRecommendation ?? "",
    ownerName: risk.ownerName ?? "",
    reviewDue: risk.reviewDue
      ? new Date(risk.reviewDue).toISOString().slice(0, 10)
      : "",
    status: risk.status,
  };
}

function FactorSelect({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FACTORS.map((f) => (
            <SelectItem key={f} value={String(f)}>
              {f}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function RiskFormDialog({
  open,
  onOpenChange,
  risk,
  canManage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  risk?: RiskDetail;
  canManage: boolean;
}) {
  const createRisk = useMutation(api.risks.createRisk);
  const updateRisk = useMutation(api.risks.updateRisk);
  const [form, setForm] = useState<RiskFormState>(() =>
    risk ? toForm(risk) : emptyForm(),
  );
  const [busy, setBusy] = useState(false);

  const inherent = riskScore(form.inherentLikelihood, form.inherentImpact);
  const residual = riskScore(form.residualLikelihood, form.residualImpact);

  function set<K extends keyof RiskFormState>(key: K, value: RiskFormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    setBusy(true);
    try {
      const reviewDue = form.reviewDue
        ? new Date(`${form.reviewDue}T23:59:00`).getTime()
        : undefined;
      if (risk) {
        await updateRisk({
          riskId: risk._id as Id<"risks">,
          title: form.title,
          category: form.category,
          description: form.description,
          assetOrService: form.assetOrService,
          threat: form.threat,
          vulnerability: form.vulnerability,
          inherentLikelihood: form.inherentLikelihood,
          inherentImpact: form.inherentImpact,
          residualLikelihood: form.residualLikelihood,
          residualImpact: form.residualImpact,
          existingControls: form.existingControls,
          treatmentRecommendation: form.treatmentRecommendation,
          ownerName: form.ownerName,
          status: form.status,
          ...(reviewDue !== undefined ? { reviewDue } : {}),
        });
        toast.success(`${risk.code} updated.`);
      } else {
        const result = await createRisk({
          title: form.title,
          category: form.category,
          description: form.description || undefined,
          assetOrService: form.assetOrService || undefined,
          threat: form.threat || undefined,
          vulnerability: form.vulnerability || undefined,
          inherentLikelihood: form.inherentLikelihood,
          inherentImpact: form.inherentImpact,
          residualLikelihood: form.residualLikelihood,
          residualImpact: form.residualImpact,
          existingControls: form.existingControls || undefined,
          treatmentRecommendation: form.treatmentRecommendation || undefined,
          ownerName: form.ownerName || undefined,
          reviewDue,
        });
        toast.success(`Risk ${result.code} created.`);
      }
      onOpenChange(false);
      if (!risk) setForm(emptyForm());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The risk could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{risk ? `Edit ${risk.code}` : "Create an ICT risk"}</DialogTitle>
          <DialogDescription>
            Scores use the canonical 5×5 model (likelihood × impact). Inherent
            score is the exposure before controls; residual is the exposure with
            the controls that exist today.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="risk-title">Title</Label>
            <Input
              id="risk-title"
              value={form.title}
              maxLength={RISK_TITLE_MAX}
              placeholder="e.g. Ransomware on the citizen services portal"
              onChange={(e) => set("title", e.target.value)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="risk-category">Category</Label>
              <Select
                value={form.category}
                onValueChange={(v) => set("category", v as RiskCategory)}
              >
                <SelectTrigger id="risk-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RISK_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="risk-owner">Risk owner</Label>
              <Input
                id="risk-owner"
                value={form.ownerName}
                placeholder="Accountable owner"
                onChange={(e) => set("ownerName", e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="risk-asset">Related ICT asset, system or service</Label>
            <Input
              id="risk-asset"
              value={form.assetOrService}
              placeholder="e.g. Citizen services portal (prod)"
              onChange={(e) => set("assetOrService", e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="risk-description">Description</Label>
            <Textarea
              id="risk-description"
              rows={3}
              maxLength={RISK_TEXT_MAX}
              value={form.description}
              placeholder="What could happen, and to what?"
              onChange={(e) => set("description", e.target.value)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="risk-threat">Threat</Label>
              <Textarea
                id="risk-threat"
                rows={2}
                maxLength={RISK_TEXT_MAX}
                value={form.threat}
                placeholder="Threat actor or event"
                onChange={(e) => set("threat", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="risk-vulnerability">Vulnerability</Label>
              <Textarea
                id="risk-vulnerability"
                rows={2}
                maxLength={RISK_TEXT_MAX}
                value={form.vulnerability}
                placeholder="Weakness the threat could exploit"
                onChange={(e) => set("vulnerability", e.target.value)}
              />
            </div>
          </div>

          <fieldset className="space-y-3 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">
              Inherent risk — score {inherent} ({riskBand(inherent)})
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <FactorSelect
                id="risk-il"
                label="Likelihood"
                value={form.inherentLikelihood}
                onChange={(v) => set("inherentLikelihood", v)}
              />
              <FactorSelect
                id="risk-ii"
                label="Impact"
                value={form.inherentImpact}
                onChange={(v) => set("inherentImpact", v)}
              />
            </div>
          </fieldset>

          <fieldset className="space-y-3 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">
              Residual risk — score {residual} ({riskBand(residual)})
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <FactorSelect
                id="risk-rl"
                label="Likelihood"
                value={form.residualLikelihood}
                onChange={(v) => set("residualLikelihood", v)}
              />
              <FactorSelect
                id="risk-ri"
                label="Impact"
                value={form.residualImpact}
                onChange={(v) => set("residualImpact", v)}
              />
            </div>
          </fieldset>

          <div className="space-y-2">
            <Label htmlFor="risk-controls">Existing controls</Label>
            <Textarea
              id="risk-controls"
              rows={2}
              maxLength={RISK_TEXT_MAX}
              value={form.existingControls}
              placeholder="Controls operating today…"
              onChange={(e) => set("existingControls", e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="risk-treatment">Treatment recommendation</Label>
            <Textarea
              id="risk-treatment"
              rows={2}
              maxLength={RISK_TEXT_MAX}
              value={form.treatmentRecommendation}
              placeholder="Recommended treatment (recorded, not an approval workflow)…"
              onChange={(e) => set("treatmentRecommendation", e.target.value)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="risk-review">Next review date</Label>
              <Input
                id="risk-review"
                type="date"
                value={form.reviewDue}
                onChange={(e) => set("reviewDue", e.target.value)}
              />
            </div>
            {risk && (
              <div className="space-y-2">
                <Label htmlFor="risk-status">Lifecycle status</Label>
                <Select
                  value={form.status ?? risk.status}
                  onValueChange={(v) => set("status", v as RiskStatus)}
                >
                  <SelectTrigger id="risk-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RISK_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {RISK_STATUS_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy || !canManage || form.title.trim().length < 3}
          >
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {risk ? "Save changes" : "Create risk"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RiskDetailDialog({
  riskId,
  onOpenChange,
  canManage,
}: {
  riskId: Id<"risks"> | null;
  onOpenChange: (open: boolean) => void;
  canManage: boolean;
}) {
  const detail = useQuery(
    api.risks.getRisk,
    riskId ? { riskId } : "skip",
  ) as RiskDetail | null | undefined;
  const [editing, setEditing] = useState(false);

  return (
    <Dialog open={riskId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {detail ? `${detail.code} — ${detail.title}` : "Risk detail"}
          </DialogTitle>
          <DialogDescription>
            {detail
              ? `${detail.category}${detail.assetOrService ? ` · ${detail.assetOrService}` : ""}`
              : "Loading risk…"}
          </DialogDescription>
        </DialogHeader>

        {detail === undefined ? (
          <ListSkeleton rows={4} />
        ) : detail === null ? (
          <p className="text-sm text-muted-foreground">
            This risk is not available in your organization.
          </p>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip status={detail.status} />
              <span className="text-muted-foreground">Owner:</span>
              <span className="font-medium">{detail.ownerName ?? "Unassigned"}</span>
              <span className="text-muted-foreground">Review:</span>
              <span className={detail.reviewOverdue ? "font-medium text-critical" : "font-medium"}>
                {detail.reviewDue ? formatDate(detail.reviewDue) : "Not scheduled"}
                {detail.reviewOverdue ? " (overdue)" : ""}
              </span>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-md border p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Inherent
                </p>
                <div className="mt-1">
                  <RiskScoreBadge
                    likelihood={detail.inherentLikelihood}
                    impact={detail.inherentImpact}
                  />
                </div>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Residual
                </p>
                <div className="mt-1">
                  <RiskScoreBadge
                    likelihood={detail.residualLikelihood}
                    impact={detail.residualImpact}
                  />
                </div>
              </div>
            </div>

            <dl className="space-y-3">
              {[
                ["Description", detail.description],
                ["Threat", detail.threat],
                ["Vulnerability", detail.vulnerability],
                ["Existing controls", detail.existingControls],
                ["Treatment recommendation", detail.treatmentRecommendation],
              ].map(([label, value]) => (
                <div key={label as string}>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    {label}
                  </dt>
                  <dd className="mt-0.5 whitespace-pre-wrap">
                    {(value as string | undefined) || "—"}
                  </dd>
                </div>
              ))}
            </dl>

            <RiskAssessments
              riskId={detail._id as Id<"risks">}
              canManage={canManage}
            />

            <RiskTreatmentPlans
              riskId={detail._id as Id<"risks">}
              canManage={canManage}
            />

            {detail.history.length > 0 && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none">
                  Audit history ({detail.history.length})
                </summary>
                <ul className="mt-2 space-y-1">
                  {detail.history.map((h, i) => (
                    <li key={`${h.createdAt}-${i}`}>
                      {formatDate(h.createdAt)} · {h.actorLabel ?? "System"} ·{" "}
                      {h.summary ?? h.action}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {canManage && (
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" aria-hidden />
                Edit risk
              </Button>
            )}
          </div>
        )}

        {detail && (
          <RiskFormDialog
            open={editing}
            onOpenChange={setEditing}
            risk={detail}
            canManage={canManage}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function RiskRegisterPage() {
  const session = useQuery(api.session.getSession);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [band, setBand] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);
  // Deep link support: /risk/register?risk=<id> opens that record's detail.
  // Monitoring relies on it to navigate to the exact register entry without
  // duplicating an editable register. Malformed ids are ignored, never passed
  // to a validator-backed query.
  const [searchParams, setSearchParams] = useSearchParams();
  const linkedRisk = searchParams.get("risk");
  const linkedRiskId =
    linkedRisk && /^[a-z0-9]{16,64}$/i.test(linkedRisk)
      ? (linkedRisk as Id<"risks">)
      : null;
  // A row the user clicked wins over the link in the URL; closing clears both.
  const [pickedRiskId, setPickedRiskId] = useState<Id<"risks"> | null>(null);
  const selected = pickedRiskId ?? linkedRiskId;

  const canView = session?.permissions?.risk === true;
  const canManage = session?.permissions?.riskManage === true;

  const risks = useQuery(
    api.risks.listRisks,
    canView
      ? {
          search: search.trim() || undefined,
          category: category === "all" ? undefined : (category as RiskCategory),
          status: status === "all" ? undefined : (status as RiskStatus),
          band: band === "all" ? undefined : band,
        }
      : "skip",
  ) as RiskRow[] | undefined;
  const summary = useQuery(
    api.risks.riskSummary,
    canView ? {} : "skip",
  ) as
    | {
        total: number;
        bands: Record<RiskBand, number>;
        overdueReviews: number;
        dueSoon: number;
      }
    | undefined;
  const treatment = useQuery(
    api.riskTreatment.treatmentSummary,
    canView ? {} : "skip",
  ) as
    | {
        risksAssessed: number;
        risksReassessed: number;
        treatmentPlanned: number;
        treatmentInProgress: number;
        actionsCompleted: number;
        actionsOverdue: number;
      }
    | undefined;

  const header = (
    <>
      <Breadcrumbs path="/risk/register" />
      <PageHeader
        eyebrow="ICT Risk"
        title="Risk Register"
        description="Organization-scoped register of ICT risks using the canonical 5×5 inherent and residual scoring model. Every record carries an owner, evidence of existing controls and a review date."
        actions={
          canManage ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden />
              New risk
            </Button>
          ) : undefined
        }
      />
    </>
  );

  if (session === undefined) {
    return (
      <AppLayout>
        {header}
        <ListSkeleton rows={5} />
      </AppLayout>
    );
  }

  if (!canView) {
    return (
      <AppLayout>
        {header}
        <Card className="mx-auto max-w-md border-dashed shadow-none">
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-muted">
              <ShieldAlert className="size-5 text-muted-foreground" aria-hidden />
            </div>
            <CardTitle>Risk register is not available for your role</CardTitle>
            <CardDescription>
              Reading the register requires the <code>risk.view</code>{" "}
              permission. Ask your administrator if you believe this is an error.
            </CardDescription>
          </CardHeader>
        </Card>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      {header}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Risks in register"
          value={summary?.total ?? "…"}
          icon={ClipboardList}
          hint="Scoped to your organization"
        />
        <KpiCard
          label="Critical residual"
          value={summary?.bands.critical ?? "…"}
          icon={ShieldAlert}
          tone="critical"
          hint="Residual score 15–25"
        />
        <KpiCard
          label="Reviews overdue"
          value={summary?.overdueReviews ?? "…"}
          icon={AlertTriangle}
          tone="warning"
          hint="Past their review date"
        />
        <KpiCard
          label="Reviews due soon"
          value={summary?.dueSoon ?? "…"}
          icon={CalendarClock}
          hint="Within the next 30 days"
        />
      </div>

      <div
        aria-label="Treatment progress summary"
        className="mb-6 grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2 lg:grid-cols-5"
      >
        {[
          ["Risks assessed", treatment?.risksAssessed],
          ["Risks reassessed", treatment?.risksReassessed],
          ["Treatment planned", treatment?.treatmentPlanned],
          ["Treatment in progress", treatment?.treatmentInProgress],
          ["Actions completed", treatment?.actionsCompleted],
        ].map(([label, value]) => (
          <div key={label as string}>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {label}
            </p>
            <p className="text-lg font-semibold tabular-nums">
              {value === undefined ? "…" : value}
            </p>
          </div>
        ))}
        {(treatment?.actionsOverdue ?? 0) > 0 && (
          <p className="text-xs font-medium text-critical sm:col-span-2 lg:col-span-5">
            {treatment?.actionsOverdue} treatment action
            {treatment?.actionsOverdue === 1 ? " is" : "s are"} past the due
            date. Completing actions does not change residual scores — record a
            risk assessment to evidence any movement.
          </p>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search code, title, owner or asset…"
          className="w-full sm:max-w-xs"
          aria-label="Search risks"
        />
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-40" aria-label="Filter by category">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {RISK_CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40" aria-label="Filter by status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {RISK_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {RISK_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={band} onValueChange={setBand}>
          <SelectTrigger className="w-36" aria-label="Filter by residual band">
            <SelectValue placeholder="Residual" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All bands</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="low">Low</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {risks === undefined ? (
        <ListSkeleton rows={6} />
      ) : risks.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title={search || category !== "all" || status !== "all" || band !== "all" ? "No risks match those filters" : "No risks recorded yet"}
          description={
            canManage
              ? "Create the first risk record — it will be scoped to your organization, scored on the 5×5 model and written to the audit trail."
              : "Risk records created by authorized users will appear here."
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Risk</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Inherent</TableHead>
                  <TableHead>Residual</TableHead>
                  <TableHead>Review</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {risks.map((r) => (
                  <TableRow key={r._id}>
                    <TableCell>
                      <button
                        type="button"
                        className="text-left"
                        onClick={() => setPickedRiskId(r._id as Id<"risks">)}
                      >
                        <span className="font-mono text-xs text-muted-foreground">
                          {r.code}
                        </span>
                        <span className="block font-medium">{r.title}</span>
                        {r.assetOrService && (
                          <span className="block text-xs text-muted-foreground">
                            {r.assetOrService}
                          </span>
                        )}
                      </button>
                    </TableCell>
                    <TableCell className="text-sm">{r.category}</TableCell>
                    <TableCell className="text-sm">{r.ownerName ?? "—"}</TableCell>
                    <TableCell>
                      <RiskScoreBadge
                        likelihood={r.inherentLikelihood}
                        impact={r.inherentImpact}
                      />
                    </TableCell>
                    <TableCell>
                      <RiskScoreBadge
                        likelihood={r.residualLikelihood}
                        impact={r.residualImpact}
                      />
                    </TableCell>
                    <TableCell className="text-sm">
                      <span className={r.reviewOverdue ? "font-medium text-critical" : ""}>
                        {r.reviewDue ? formatDate(r.reviewDue) : "—"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusChip status={r.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setPickedRiskId(r._id as Id<"risks">)}
                      >
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <RiskFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        canManage={canManage}
      />
      <RiskDetailDialog
        riskId={selected}
        onOpenChange={(open) => {
          if (open) return;
          setPickedRiskId(null);
          if (searchParams.has("risk")) {
            const next = new URLSearchParams(searchParams);
            next.delete("risk");
            setSearchParams(next, { replace: true });
          }
        }}
        canManage={canManage}
      />
    </AppLayout>
  );
}
