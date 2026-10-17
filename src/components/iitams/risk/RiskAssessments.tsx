import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
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
import { RiskScoreBadge } from "@/components/iitams/badges";
import { ListSkeleton } from "@/components/iitams/audit/ListPageShell";
import { formatDate } from "@/lib/format";
import {
  RISK_BAND_LABELS,
  RISK_TEXT_MAX,
  riskBand,
  riskScore,
  type RiskBand,
} from "@/lib/risk";
import { CalendarCheck2, ClipboardCheck, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

/**
 * Risk assessments (Phase 3B — Batch 2A): insert-only assessment history for
 * one risk, plus the structured assessment form. Scoring uses the canonical
 * 5×5 model from src/lib/risk.ts; the server is authoritative for both the
 * assessment snapshot and the current register scores.
 */

const FACTORS = [1, 2, 3, 4, 5] as const;
const DAY = 24 * 60 * 60 * 1000;

type Assessment = {
  _id: string;
  assessmentDate: number;
  assessorLabel: string;
  inherentLikelihood: number;
  inherentImpact: number;
  inherentScore: number;
  inherentBand: RiskBand;
  residualLikelihood: number;
  residualImpact: number;
  residualScore: number;
  residualBand: RiskBand;
  previousResidualScore: number;
  previousResidualBand: RiskBand;
  controlsConsidered?: string;
  justification: string;
  observations?: string;
  nextReviewDate: number;
};

type AssessmentHistory = {
  risk: {
    _id: string;
    code: string;
    residualScore: number;
    residualBand: RiskBand;
    reviewDue?: number;
    reviewOverdue: boolean;
  };
  assessments: Assessment[];
  latestResidualScore: number | null;
  previousResidualScore: number | null;
  driftSinceLatestAssessment: number | null;
};

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseDate(value: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(`${value}T12:00:00`).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function bandChangeLabel(previous: RiskBand, next: RiskBand): string {
  if (previous === next) return "Band unchanged";
  const order: RiskBand[] = ["low", "medium", "high", "critical"];
  return order.indexOf(next) > order.indexOf(previous)
    ? `Band raised: ${RISK_BAND_LABELS[previous]} → ${RISK_BAND_LABELS[next]}`
    : `Band reduced: ${RISK_BAND_LABELS[previous]} → ${RISK_BAND_LABELS[next]}`;
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
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger id={id} aria-label={label}>
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

function AssessmentForm({
  riskId,
  onDone,
  onCancel,
}: {
  riskId: Id<"risks">;
  onDone: () => void;
  onCancel: () => void;
}) {
  const createAssessment = useMutation(api.riskAssessments.createAssessment);
  // Initial values are computed once (lazy initialisers), never on re-render.
  const [maxAssessmentDate] = useState(() => isoDate(Date.now()));
  const [assessmentDate, setAssessmentDate] = useState(() => isoDate(Date.now()));
  const [inherentLikelihood, setInherentLikelihood] = useState(3);
  const [inherentImpact, setInherentImpact] = useState(3);
  const [residualLikelihood, setResidualLikelihood] = useState(2);
  const [residualImpact, setResidualImpact] = useState(3);
  const [controlsConsidered, setControlsConsidered] = useState("");
  const [justification, setJustification] = useState("");
  const [observations, setObservations] = useState("");
  const [nextReviewDate, setNextReviewDate] = useState(() =>
    isoDate(Date.now() + 90 * DAY),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inherent = riskScore(inherentLikelihood, inherentImpact);
  const residual = riskScore(residualLikelihood, residualImpact);

  async function submit() {
    setError(null);
    const assessmentMs = parseDate(assessmentDate);
    const reviewMs = parseDate(nextReviewDate);
    if (assessmentMs === undefined || reviewMs === undefined) {
      setError("Enter both the assessment date and the next review date.");
      return;
    }
    if (justification.trim().length < 10) {
      setError("Assessment justification must be at least 10 characters.");
      return;
    }
    setBusy(true);
    try {
      await createAssessment({
        riskId,
        assessmentDate: assessmentMs,
        inherentLikelihood,
        inherentImpact,
        residualLikelihood,
        residualImpact,
        controlsConsidered: controlsConsidered.trim() || undefined,
        justification: justification.trim(),
        observations: observations.trim() || undefined,
        nextReviewDate: reviewMs,
      });
      toast.success("Assessment recorded and register scores updated.");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The assessment could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border bg-muted/30 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="assess-date" className="text-xs">
            Assessment date
          </Label>
          <Input
            id="assess-date"
            type="date"
            value={assessmentDate}
            max={maxAssessmentDate}
            onChange={(e) => setAssessmentDate(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="assess-next-review" className="text-xs">
            Next review date
          </Label>
          <Input
            id="assess-next-review"
            type="date"
            value={nextReviewDate}
            onChange={(e) => setNextReviewDate(e.target.value)}
          />
        </div>
      </div>

      <fieldset className="space-y-2 rounded-md border p-2">
        <legend className="px-1 text-xs font-medium">
          Inherent score {inherent} · {RISK_BAND_LABELS[riskBand(inherent)]}
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <FactorSelect
            id="assess-il"
            label="Inherent likelihood"
            value={inherentLikelihood}
            onChange={setInherentLikelihood}
          />
          <FactorSelect
            id="assess-ii"
            label="Inherent impact"
            value={inherentImpact}
            onChange={setInherentImpact}
          />
        </div>
      </fieldset>

      <fieldset className="space-y-2 rounded-md border p-2">
        <legend className="px-1 text-xs font-medium">
          Residual score {residual} · {RISK_BAND_LABELS[riskBand(residual)]}
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <FactorSelect
            id="assess-rl"
            label="Residual likelihood"
            value={residualLikelihood}
            onChange={setResidualLikelihood}
          />
          <FactorSelect
            id="assess-ri"
            label="Residual impact"
            value={residualImpact}
            onChange={setResidualImpact}
          />
        </div>
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="assess-controls" className="text-xs">
          Controls considered
        </Label>
        <Textarea
          id="assess-controls"
          rows={2}
          maxLength={RISK_TEXT_MAX}
          value={controlsConsidered}
          placeholder="Controls reviewed and whether they operate effectively…"
          onChange={(e) => setControlsConsidered(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="assess-justification" className="text-xs">
          Justification (required)
        </Label>
        <Textarea
          id="assess-justification"
          rows={3}
          maxLength={RISK_TEXT_MAX}
          value={justification}
          placeholder="Why were these likelihood and impact ratings chosen?"
          onChange={(e) => setJustification(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="assess-observations" className="text-xs">
          Observations
        </Label>
        <Textarea
          id="assess-observations"
          rows={2}
          maxLength={RISK_TEXT_MAX}
          value={observations}
          placeholder="Notable findings, evidence references or follow-ups…"
          onChange={(e) => setObservations(e.target.value)}
        />
      </div>

      {error && (
        <p role="alert" className="text-xs font-medium text-critical">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={busy}>
          {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          Save assessment
        </Button>
      </div>
    </div>
  );
}

export function RiskAssessments({
  riskId,
  canManage,
}: {
  riskId: Id<"risks">;
  canManage: boolean;
}) {
  const history = useQuery(api.riskAssessments.listForRisk, { riskId }) as
    | AssessmentHistory
    | null
    | undefined;
  const [formOpen, setFormOpen] = useState(false);

  if (history === undefined) return <ListSkeleton rows={2} />;
  if (history === null) {
    return (
      <p className="text-sm text-muted-foreground">
        Assessment history is not available for this risk.
      </p>
    );
  }

  const latest = history.assessments[0];
  const previous = history.assessments[1];

  return (
    <section className="space-y-3 border-t pt-4" aria-label="Risk assessments">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <ClipboardCheck className="size-4 text-muted-foreground" aria-hidden />
          Risk assessments
          <span className="font-normal text-muted-foreground">
            ({history.assessments.length})
          </span>
        </h3>
        {canManage && !formOpen && (
          <Button size="sm" variant="outline" onClick={() => setFormOpen(true)}>
            <Plus className="size-3.5" aria-hidden />
            Record assessment
          </Button>
        )}
      </div>

      {history.risk.reviewOverdue && (
        <p className="rounded-md bg-critical/10 px-3 py-2 text-xs font-medium">
          <CalendarCheck2 className="mr-1 inline size-3.5" aria-hidden />
          Review overdue — the current next review date is{" "}
          {history.risk.reviewDue ? formatDate(history.risk.reviewDue) : "unset"}.
        </p>
      )}

      {latest ? (
        <div className="rounded-md border p-3 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Latest assessment · {formatDate(latest.assessmentDate)} ·{" "}
            {latest.assessorLabel}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-xs text-muted-foreground">Residual</span>
            <RiskScoreBadge
              likelihood={latest.residualLikelihood}
              impact={latest.residualImpact}
            />
            <span className="text-xs text-muted-foreground">
              was {latest.previousResidualScore} (
              {RISK_BAND_LABELS[latest.previousResidualBand]})
            </span>
            <span className="text-xs font-medium">
              {bandChangeLabel(
                latest.previousResidualBand,
                latest.residualBand,
              )}
            </span>
          </div>
          {history.driftSinceLatestAssessment !== null &&
            history.driftSinceLatestAssessment !== 0 && (
              <p className="mt-2 rounded bg-warning/15 px-2 py-1 text-xs">
                The register was edited after this assessment: residual score{" "}
                {latest.residualScore} → {history.risk.residualScore}. Record a
                new assessment to keep the evidence current.
              </p>
            )}
          <p className="mt-2 whitespace-pre-wrap text-sm">{latest.justification}</p>
          {latest.controlsConsidered && (
            <p className="mt-1 text-xs text-muted-foreground">
              Controls considered: {latest.controlsConsidered}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No assessments recorded yet. The register scores are the current view;
          record an assessment to capture the evidence behind them.
        </p>
      )}

      {formOpen && (
        <AssessmentForm
          riskId={riskId}
          onDone={() => setFormOpen(false)}
          onCancel={() => setFormOpen(false)}
        />
      )}

      {history.assessments.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Assessment history
          </h4>
          <ul className="space-y-2">
            {history.assessments.map((a) => (
              <li key={a._id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{formatDate(a.assessmentDate)}</span>
                  <span className="text-xs text-muted-foreground">
                    {a.assessorLabel} · next review {formatDate(a.nextReviewDate)}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    Inherent
                    <RiskScoreBadge
                      likelihood={a.inherentLikelihood}
                      impact={a.inherentImpact}
                    />
                  </span>
                  <span className="inline-flex items-center gap-1">
                    Residual
                    <RiskScoreBadge
                      likelihood={a.residualLikelihood}
                      impact={a.residualImpact}
                    />
                  </span>
                  <span>was {a.previousResidualScore}</span>
                  {previous && a._id === latest?._id && (
                    <span className="font-medium text-foreground">
                      {bandChangeLabel(previous.residualBand, a.residualBand)}
                    </span>
                  )}
                </div>
                <p className="mt-2 whitespace-pre-wrap">{a.justification}</p>
                {a.observations && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Observations: {a.observations}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
