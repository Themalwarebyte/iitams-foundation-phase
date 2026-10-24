import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
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
import {
  BCM_EXERCISE_TYPES,
  BCM_EXERCISE_TYPE_DESCRIPTIONS,
  BCM_EXERCISE_TYPE_LABELS,
  type BcmExerciseType,
} from "@/lib/bcm";
import { Field } from "./BcmPrimitives";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

/**
 * Create/edit form for a recovery exercise. The server is authoritative for
 * every rule (only an approved plan version can be tested, dates must be
 * coherent, participants must be active members); this form collects input and
 * surfaces the refusal verbatim. Editing is only offered before the exercise
 * starts, because reported results are never rewritten.
 */

export type ExercisePlanOption = {
  _id: string;
  reference: string;
  title: string;
  version: number;
  biaReference: string | null;
  biaVersion: number | null;
  biaStatusAtLink: string | null;
};

export type ExerciseMemberOption = { userId: string; label: string };

export type ExerciseParticipantValue = { userId: string; role: string };

export type ExerciseInitialValues = {
  title: string;
  objectives: string;
  planId: string;
  type: BcmExerciseType;
  scope: string;
  exclusions: string;
  scenario: string;
  ownerUserId: string;
  facilitatorUserId: string;
  participants: ExerciseParticipantValue[];
  plannedStartAt: string;
  plannedEndAt: string;
  methodology: string;
  requiredResources: string;
  constraints: string;
  evidenceReferences: string;
};

const toDateInput = (value: number | null | undefined): string =>
  value ? new Date(value).toISOString().slice(0, 10) : "";

export function emptyExerciseValues(
  plans: ExercisePlanOption[],
  members: ExerciseMemberOption[],
  currentUserId: string,
): ExerciseInitialValues {
  const start = Date.now() + 14 * 24 * 60 * 60 * 1000;
  return {
    title: "",
    objectives: "",
    planId: plans[0]?._id ?? "",
    type: "tabletop",
    scope: "",
    exclusions: "",
    scenario: "",
    ownerUserId: members.some((m) => m.userId === currentUserId)
      ? currentUserId
      : (members[0]?.userId ?? ""),
    facilitatorUserId: members.some((m) => m.userId === currentUserId)
      ? currentUserId
      : (members[0]?.userId ?? ""),
    participants: [],
    plannedStartAt: toDateInput(start),
    plannedEndAt: toDateInput(start + 60 * 60 * 1000),
    methodology: "",
    requiredResources: "",
    constraints: "",
    evidenceReferences: "",
  };
}

export function valuesFromExercise(exercise: {
  title: string;
  objectives: string;
  planId: string;
  type: BcmExerciseType;
  scope: string;
  exclusions: string;
  scenario: string;
  ownerUserId: string;
  facilitatorUserId: string;
  participants: ExerciseParticipantValue[];
  plannedStartAt: number;
  plannedEndAt: number;
  methodology: string;
  requiredResources: string;
  constraints: string;
  evidenceReferences: string | null;
}): ExerciseInitialValues {
  return {
    title: exercise.title,
    objectives: exercise.objectives,
    planId: exercise.planId,
    type: exercise.type,
    scope: exercise.scope,
    exclusions: exercise.exclusions,
    scenario: exercise.scenario,
    ownerUserId: exercise.ownerUserId,
    facilitatorUserId: exercise.facilitatorUserId,
    participants: exercise.participants.map((row) => ({
      userId: row.userId,
      role: row.role,
    })),
    plannedStartAt: toDateInput(exercise.plannedStartAt),
    plannedEndAt: toDateInput(exercise.plannedEndAt),
    methodology: exercise.methodology,
    requiredResources: exercise.requiredResources,
    constraints: exercise.constraints,
    evidenceReferences: exercise.evidenceReferences ?? "",
  };
}

export function ExerciseFormDialog({
  open,
  onOpenChange,
  plans,
  members,
  initial,
  exerciseId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plans: ExercisePlanOption[];
  members: ExerciseMemberOption[];
  initial: ExerciseInitialValues;
  /** Present when amending an existing planned/scheduled exercise. */
  exerciseId?: string;
  onSaved?: (result: { exerciseId: string; reference?: string }) => void;
}) {
  const createExercise = useMutation(api.recoveryExercises.createExercise);
  const updateExercise = useMutation(api.recoveryExercises.updateExercise);
  const [form, setForm] = useState<ExerciseInitialValues>(initial);
  const [busy, setBusy] = useState(false);

  function set<K extends keyof ExerciseInitialValues>(
    key: K,
    value: ExerciseInitialValues[K],
  ) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  const selectedPlan = plans.find((plan) => plan._id === form.planId) ?? null;

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      const plannedStartAt = new Date(`${form.plannedStartAt}T09:00:00`).getTime();
      const plannedEndAt = new Date(`${form.plannedEndAt}T17:00:00`).getTime();
      const payload = {
        title: form.title,
        objectives: form.objectives,
        planId: form.planId as never,
        type: form.type,
        scope: form.scope,
        exclusions: form.exclusions,
        scenario: form.scenario,
        ownerUserId: form.ownerUserId as never,
        facilitatorUserId: form.facilitatorUserId as never,
        participants: form.participants
          .filter((row) => row.userId)
          .map((row) => ({ userId: row.userId as never, role: row.role })),
        plannedStartAt,
        plannedEndAt,
        methodology: form.methodology,
        requiredResources: form.requiredResources,
        constraints: form.constraints,
        evidenceReferences: form.evidenceReferences || undefined,
      };
      if (exerciseId) {
        await updateExercise({ exerciseId: exerciseId as never, ...payload });
        toast.success("Exercise planning detail updated");
        onSaved?.({ exerciseId });
      } else {
        const result = (await createExercise(payload)) as {
          exerciseId: string;
          reference: string;
        };
        toast.success(`Exercise ${result.reference} planned`);
        onSaved?.(result);
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "The exercise could not be saved",
      );
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    form.title.trim().length >= 3 &&
    form.planId.length > 0 &&
    form.objectives.trim().length >= 20 &&
    form.scope.trim().length >= 20 &&
    form.exclusions.trim().length >= 20 &&
    form.scenario.trim().length >= 20 &&
    form.methodology.trim().length >= 20 &&
    form.requiredResources.trim().length >= 20 &&
    form.constraints.trim().length >= 20 &&
    form.plannedStartAt.length > 0 &&
    form.plannedEndAt.length > 0 &&
    form.ownerUserId.length > 0 &&
    form.facilitatorUserId.length > 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {exerciseId ? "Amend exercise planning" : "Plan a recovery exercise"}
          </DialogTitle>
          <DialogDescription>
            This records a planned activity against an approved continuity plan.
            It does not execute recovery, fail over systems or restore data.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <Field label="Exercise title" hint="A short, specific description">
            <Input
              value={form.title}
              maxLength={200}
              onChange={(event) => set("title", event.target.value)}
              placeholder="Tabletop: loss of the finance ERP at month end"
              data-testid="bcm-exercise-title"
            />
          </Field>

          <Field
            label="Continuity plan version tested"
            hint={
              selectedPlan
                ? `${selectedPlan.reference} v${selectedPlan.version} — ${
                    selectedPlan.biaReference
                      ? `baseline ${selectedPlan.biaReference} v${selectedPlan.biaVersion} (${selectedPlan.biaStatusAtLink ?? "unknown"})`
                      : "no linked analysis"
                  }`
                : "Only approved plans can be tested"
            }
          >
            <Select
              value={form.planId}
              onValueChange={(value) => set("planId", value)}
            >
              <SelectTrigger data-testid="bcm-exercise-plan">
                <SelectValue placeholder="Select an approved continuity plan" />
              </SelectTrigger>
              <SelectContent>
                {plans.map((plan) => (
                  <SelectItem key={plan._id} value={plan._id}>
                    {plan.reference} v{plan.version} — {plan.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Exercise type" hint={BCM_EXERCISE_TYPE_DESCRIPTIONS[form.type]}>
              <Select
                value={form.type}
                onValueChange={(value) => set("type", value as BcmExerciseType)}
              >
                <SelectTrigger data-testid="bcm-exercise-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BCM_EXERCISE_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {BCM_EXERCISE_TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Planned start">
                <Input
                  type="date"
                  value={form.plannedStartAt}
                  onChange={(event) => set("plannedStartAt", event.target.value)}
                />
              </Field>
              <Field label="Planned end">
                <Input
                  type="date"
                  value={form.plannedEndAt}
                  onChange={(event) => set("plannedEndAt", event.target.value)}
                />
              </Field>
            </div>
          </div>

          <Field label="Objectives" hint="What the exercise must establish (min 20 characters)">
            <Textarea
              rows={3}
              value={form.objectives}
              onChange={(event) => set("objectives", event.target.value)}
              data-testid="bcm-exercise-objectives"
            />
          </Field>

          <Field label="Scope" hint="Services, teams and recovery steps covered">
            <Textarea
              rows={2}
              value={form.scope}
              onChange={(event) => set("scope", event.target.value)}
              data-testid="bcm-exercise-scope"
            />
          </Field>
          <Field label="Exclusions" hint="What this exercise explicitly does not cover">
            <Textarea
              rows={2}
              value={form.exclusions}
              onChange={(event) => set("exclusions", event.target.value)}
              data-testid="bcm-exercise-exclusions"
            />
          </Field>
          <Field label="Scenario" hint="The disruption being rehearsed">
            <Textarea
              rows={2}
              value={form.scenario}
              onChange={(event) => set("scenario", event.target.value)}
              data-testid="bcm-exercise-scenario"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Exercise owner">
              <Select
                value={form.ownerUserId}
                onValueChange={(value) => set("ownerUserId", value)}
              >
                <SelectTrigger data-testid="bcm-exercise-owner">
                  <SelectValue placeholder="Select an owner" />
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
            <Field
              label="Facilitator"
              hint="The reviewer must differ from the owner and facilitator"
            >
              <Select
                value={form.facilitatorUserId}
                onValueChange={(value) => set("facilitatorUserId", value)}
              >
                <SelectTrigger data-testid="bcm-exercise-facilitator">
                  <SelectValue placeholder="Select a facilitator" />
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
          </div>

          <div className="rounded-lg border border-border/70 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">Participants and roles</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  set("participants", [
                    ...form.participants,
                    { userId: members[0]?.userId ?? "", role: "" },
                  ])
                }
              >
                <Plus className="mr-1 size-3.5" aria-hidden />
                Add participant
              </Button>
            </div>
            {form.participants.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No participants recorded. Participants are optional, but every
                name added must be an active member of this organization.
              </p>
            ) : (
              <div className="grid gap-2">
                {form.participants.map((participant, index) => (
                  <div key={index} className="flex items-end gap-2">
                    <div className="flex-1">
                      <Select
                        value={participant.userId}
                        onValueChange={(value) => {
                          const next = [...form.participants];
                          next[index] = { ...participant, userId: value };
                          set("participants", next);
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Member" />
                        </SelectTrigger>
                        <SelectContent>
                          {members.map((member) => (
                            <SelectItem key={member.userId} value={member.userId}>
                              {member.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Input
                      className="flex-1"
                      placeholder="Role in the exercise"
                      value={participant.role}
                      maxLength={80}
                      onChange={(event) => {
                        const next = [...form.participants];
                        next[index] = { ...participant, role: event.target.value };
                        set("participants", next);
                      }}
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label="Remove participant"
                      onClick={() =>
                        set(
                          "participants",
                          form.participants.filter((_, i) => i !== index),
                        )
                      }
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <Field label="Methodology" hint="How the exercise will be run">
            <Textarea
              rows={2}
              value={form.methodology}
              onChange={(event) => set("methodology", event.target.value)}
              data-testid="bcm-exercise-methodology"
            />
          </Field>
          <Field label="Required resources" hint="People, rooms, systems and data needed">
            <Textarea
              rows={2}
              value={form.requiredResources}
              onChange={(event) => set("requiredResources", event.target.value)}
              data-testid="bcm-exercise-resources"
            />
          </Field>
          <Field
            label="Safety and operational constraints"
            hint="What must not be touched, and who authorizes any operational step"
          >
            <Textarea
              rows={2}
              value={form.constraints}
              onChange={(event) => set("constraints", event.target.value)}
              data-testid="bcm-exercise-constraints"
            />
          </Field>
          <Field
            label="Evidence and documentation references"
            hint="Optional: locations of the documents and records this exercise will use"
          >
            <Textarea
              rows={2}
              value={form.evidenceReferences}
              onChange={(event) => set("evidenceReferences", event.target.value)}
              data-testid="bcm-exercise-evidence"
            />
          </Field>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !canSubmit || plans.length === 0}
            data-testid="bcm-exercise-save"
          >
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
            {exerciseId ? "Save planning detail" : "Plan exercise"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
