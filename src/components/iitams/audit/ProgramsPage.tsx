import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { FileSearch, Plus, ClipboardList } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ListPageShell, ListSkeleton, EmptyState } from "./ListPageShell";

/**
 * Module 5 — Audit programs & procedures. Each program holds structured
 * procedures with control objective, expected evidence and a recorded
 * Pass / Fail / Exception result. Assignment rule: only engagement team
 * members may act (server-enforced).
 */

interface ProgramRow {
  _id: string;
  code: string;
  title: string;
  objective?: string;
  status: string;
  procedureCount: number;
  completedCount: number;
  passCount: number;
  failCount: number;
  exceptionCount: number;
}

interface ProcedureRow {
  _id: string;
  code: string;
  procedureName: string;
  controlObjective?: string;
  expectedEvidence?: string;
  completionStatus: string;
  result?: string;
  resultNotes?: string;
}

const RESULT_STYLES: Record<string, string> = {
  pass: "bg-success/10 text-success border-success/25",
  fail: "bg-critical/10 text-critical border-critical/25",
  exception: "bg-warning/15 text-foreground/90 border-warning/40",
};

export function ProgramsPage({ path }: { path: string }) {
  const engagements = useQuery(api.auditEngagements.listMine, {});
  const first = engagements?.[0]?.engagement;
  const [engagementId, setEngagementId] = useState<string | null>(null);
  const active = engagementId ?? first?._id ?? null;

  const programs = useQuery(
    api.auditWorkpapers.listPrograms,
    active ? { engagementId: active as never } : "skip",
  );

  return (
    <ListPageShell
      path={path}
      eyebrow="Audit Management"
      title="Audit Programs"
      description="Structured audit procedures per engagement — control objectives, expected evidence and Pass / Fail / Exception results."
    >
      {engagements === undefined ? (
        <ListSkeleton rows={2} />
      ) : engagements.length === 0 ? (
        <EmptyState
          icon={FileSearch}
          title="No engagement assignments"
          description="Audit programs belong to engagements. You see programs for engagements where you are assigned to the audit team."
        />
      ) : (
        <div className="space-y-4">
          <div className="max-w-md">
            <Label>Engagement</Label>
            <Select
              value={active ?? undefined}
              onValueChange={(v) => setEngagementId(v)}
            >
              <SelectTrigger className="mt-1.5 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {engagements.map(({ engagement }) => (
                  <SelectItem key={engagement._id} value={engagement._id}>
                    {engagement.code} — {engagement.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {programs === undefined ? (
            <ListSkeleton />
          ) : programs.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No audit programs yet"
              description="Create a program for this engagement, then add procedures with expected evidence and results."
            />
          ) : (
            <div className="space-y-4">
              {programs.map((p) => (
                <ProgramCard key={p._id} program={p as unknown as ProgramRow} />
              ))}
            </div>
          )}
        </div>
      )}
    </ListPageShell>
  );
}

function ProgramCard({ program }: { program: ProgramRow }) {
  const procedures = useQuery(
    api.auditWorkpapers.getProgram,
    { programId: program._id as never },
  );
  const [addOpen, setAddOpen] = useState(false);

  return (
    <Card className="shadow-none">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="font-mono text-xs text-muted-foreground">
              {program.code}
            </span>
            {program.title}
          </CardTitle>
          {program.objective && (
            <p className="mt-1 text-sm text-muted-foreground">
              {program.objective}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="tabular-nums">
            {program.completedCount}/{program.procedureCount} done
          </Badge>
          {program.failCount > 0 && (
            <Badge
              variant="outline"
              className="bg-critical/10 text-critical border-critical/25"
            >
              {program.failCount} fail
            </Badge>
          )}
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" aria-hidden /> Procedure
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {procedures === undefined || procedures === null ? (
          <ListSkeleton rows={2} />
        ) : procedures.procedures.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No procedures defined yet.
          </p>
        ) : (
          <ul className="divide-y divide-border/40">
            {(procedures.procedures as unknown as ProcedureRow[]).map((proc) => (
              <li
                key={proc._id}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <span className="font-mono text-xs text-muted-foreground">
                      {proc.code}
                    </span>
                    {proc.procedureName}
                    {proc.result && (
                      <Badge
                        variant="outline"
                        className={`uppercase ${RESULT_STYLES[proc.result] ?? ""}`}
                      >
                        {proc.result}
                      </Badge>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {proc.controlObjective ?? "No control objective"}
                    {proc.expectedEvidence
                      ? ` · Evidence: ${proc.expectedEvidence}`
                      : ""}
                  </p>
                </div>
                <ProcedureResultControl
                  procedureId={proc._id}
                  current={proc.completionStatus}
                  result={proc.result}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <AddProcedureDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        programId={program._id}
      />
    </Card>
  );
}

function ProcedureResultControl({
  procedureId,
  current,
  result,
}: {
  procedureId: string;
  current: string;
  result?: string;
}) {
  const record = useMutation(api.auditWorkpapers.recordProcedureResult);
  const [busy, setBusy] = useState(false);

  const set = async (patch: {
    completionStatus?: string;
    result?: string;
  }) => {
    setBusy(true);
    try {
      await record({
        procedureId: procedureId as never,
        completionStatus: (patch.completionStatus ??
          (patch.result ? "completed" : current)) as never,
        result: (patch.result ?? (patch.completionStatus ? undefined : result)) as never,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <StatusChip status={current} />
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        className="h-7 px-2 text-xs text-success"
        onClick={() => set({ result: "pass" })}
      >
        Pass
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        className="h-7 px-2 text-xs text-critical"
        onClick={() => set({ result: "fail" })}
      >
        Fail
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        className="h-7 px-2 text-xs"
        onClick={() => set({ result: "exception" })}
      >
        Exc.
      </Button>
    </div>
  );
}

function AddProcedureDialog({
  open,
  onClose,
  programId,
}: {
  open: boolean;
  onClose: () => void;
  programId: string;
}) {
  const add = useMutation(api.auditWorkpapers.addProcedure);
  const [name, setName] = useState("");
  const [controlObjective, setControlObjective] = useState("");
  const [expectedEvidence, setExpectedEvidence] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add audit procedure</DialogTitle>
          <DialogDescription>
            e.g. Control objective: "Privileged access is properly managed."
            Procedure: "Review privileged user accounts." Expected evidence:
            "IAM user export."
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pr-name">Procedure name *</Label>
            <Input
              id="pr-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pr-co">Control objective</Label>
            <Textarea
              id="pr-co"
              rows={2}
              value={controlObjective}
              onChange={(e) => setControlObjective(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pr-ee">Expected evidence</Label>
            <Input
              id="pr-ee"
              value={expectedEvidence}
              onChange={(e) => setExpectedEvidence(e.target.value)}
              placeholder="e.g. IAM user export"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!name || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await add({
                  auditProgramId: programId as never,
                  procedureName: name,
                  controlObjective: controlObjective || undefined,
                  expectedEvidence: expectedEvidence || undefined,
                });
                toast.success("Procedure added");
                setName("");
                setControlObjective("");
                setExpectedEvidence("");
                onClose();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Add procedure
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
