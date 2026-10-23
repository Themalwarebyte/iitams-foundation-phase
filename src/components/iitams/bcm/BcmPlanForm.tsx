import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
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
  BCM_BIA_STATUS_LABELS,
  BCM_CRITICALITY_LABELS,
  BCM_MAX_ADDITIONAL_SERVICES,
  BCM_PRIORITIES,
  BCM_PRIORITY_LABELS,
  type BcmBiaStatus,
  type BcmCriticality,
  type BcmPriority,
} from "@/lib/bcm";
import { Field } from "./BcmPrimitives";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

/**
 * Create/edit form for a continuity plan. The server is authoritative for every
 * rule (approved plans are immutable, the BIA must belong to one of the linked
 * services, the preparer cannot approve); this form only collects input and
 * surfaces the refusal verbatim.
 */

export type PlanServiceOption = {
  _id: string;
  reference: string;
  name: string;
  criticality: BcmCriticality;
  hasApprovedBia: boolean;
};

export type PlanBiaOption = {
  _id: string;
  serviceId: string;
  reference: string;
  title: string;
  version: number;
  status: BcmBiaStatus;
  approved: boolean;
};

export type PlanMemberOption = { userId: string; label: string };

export type PlanInitialValues = {
  title: string;
  purpose: string;
  primaryServiceId: string;
  additionalServiceIds: string[];
  ownerUserId: string;
  biaId: string;
  disruptionScenarios: string;
  recoveryPriority: BcmPriority;
  scope: string;
  exclusions: string;
  assumptions: string;
  reviewDueAt: string;
};

const toDateInput = (value: number | null | undefined): string =>
  value ? new Date(value).toISOString().slice(0, 10) : "";

export function emptyPlanValues(
  services: PlanServiceOption[],
  members: PlanMemberOption[],
  currentUserId: string,
): PlanInitialValues {
  return {
    title: "",
    purpose: "",
    primaryServiceId: services[0]?._id ?? "",
    additionalServiceIds: [],
    ownerUserId: members.some((m) => m.userId === currentUserId)
      ? currentUserId
      : (members[0]?.userId ?? ""),
    biaId: "",
    disruptionScenarios: "",
    recoveryPriority: "p2",
    scope: "",
    exclusions: "",
    assumptions: "",
    reviewDueAt: toDateInput(Date.now() + 180 * 24 * 60 * 60 * 1000),
  };
}

export function valuesFromPlan(plan: {
  title: string;
  purpose: string;
  primaryServiceId: string;
  additionalServiceIds?: string[];
  ownerUserId: string;
  baseline: { biaId: string | null };
  disruptionScenarios: string;
  recoveryPriority: BcmPriority;
  scope: string;
  exclusions: string;
  assumptions: string;
  reviewDueAt: number;
}): PlanInitialValues {
  return {
    title: plan.title,
    purpose: plan.purpose,
    primaryServiceId: plan.primaryServiceId,
    additionalServiceIds: plan.additionalServiceIds ?? [],
    ownerUserId: plan.ownerUserId,
    biaId: plan.baseline.biaId ?? "",
    disruptionScenarios: plan.disruptionScenarios,
    recoveryPriority: plan.recoveryPriority,
    scope: plan.scope,
    exclusions: plan.exclusions,
    assumptions: plan.assumptions,
    reviewDueAt: toDateInput(plan.reviewDueAt),
  };
}

export function PlanFormDialog({
  open,
  onOpenChange,
  services,
  bias,
  members,
  planId,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  services: PlanServiceOption[];
  bias: PlanBiaOption[];
  members: PlanMemberOption[];
  /** Present when editing an existing draft. */
  planId?: Id<"continuityPlans">;
  initial: PlanInitialValues;
  onSaved?: (planId: Id<"continuityPlans">) => void;
}) {
  const createPlan = useMutation(api.continuityPlans.createPlan);
  const updatePlan = useMutation(api.continuityPlans.updatePlan);
  const [form, setForm] = useState<PlanInitialValues>(initial);
  const [busy, setBusy] = useState(false);

  function set<K extends keyof PlanInitialValues>(
    key: K,
    value: PlanInitialValues[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const linkedServiceIds = [
    form.primaryServiceId,
    ...form.additionalServiceIds,
  ].filter(Boolean);
  const biaOptions = bias.filter((row) =>
    linkedServiceIds.includes(String(row.serviceId)),
  );

  function toggleAdditional(serviceId: string) {
    setForm((prev) => {
      const active = prev.additionalServiceIds.includes(serviceId);
      const next = active
        ? prev.additionalServiceIds.filter((id) => id !== serviceId)
        : [...prev.additionalServiceIds, serviceId].slice(
            0,
            BCM_MAX_ADDITIONAL_SERVICES,
          );
      // A BIA linked to a service that is no longer part of the plan must be
      // cleared; the server would refuse it anyway.
      const stillValid = !prev.biaId
        ? true
        : bias.some(
            (row) =>
              String(row._id) === prev.biaId &&
              [prev.primaryServiceId, ...next].includes(String(row.serviceId)),
          );
      return {
        ...prev,
        additionalServiceIds: next,
        biaId: stillValid ? prev.biaId : "",
      };
    });
  }

  async function submit() {
    setBusy(true);
    try {
      const reviewDueAt = new Date(`${form.reviewDueAt}T23:59:00`).getTime();
      if (!form.primaryServiceId) throw new Error("Choose a primary business service");
      if (!form.ownerUserId) throw new Error("Choose a plan owner");
      const payload = {
        title: form.title,
        purpose: form.purpose,
        primaryServiceId: form.primaryServiceId as Id<"businessServices">,
        additionalServiceIds: form.additionalServiceIds as Id<"businessServices">[],
        ownerUserId: form.ownerUserId as Id<"users">,
        ...(form.biaId
          ? { biaId: form.biaId as Id<"businessImpactAnalyses"> }
          : {}),
        disruptionScenarios: form.disruptionScenarios,
        recoveryPriority: form.recoveryPriority,
        scope: form.scope,
        exclusions: form.exclusions,
        assumptions: form.assumptions,
        reviewDueAt,
      };
      if (planId) {
        await updatePlan({ planId, ...payload });
        toast.success("Continuity plan updated.");
        onSaved?.(planId);
      } else {
        const result = await createPlan(payload);
        toast.success(`Continuity plan ${result.reference} created as a draft.`);
        onSaved?.(result.planId);
      }
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The plan could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const selectedServiceName =
    services.find((s) => s._id === form.primaryServiceId)?.name ?? "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {planId ? "Edit continuity plan" : "Create a continuity plan"}
          </DialogTitle>
          <DialogDescription>
            A plan documents how services would be recovered and which impact
            analysis it relies on. It stays a draft until submitted, and only an
            independent reviewer can approve it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Plan title" htmlFor="plan-title">
            <Input
              id="plan-title"
              value={form.title}
              maxLength={200}
              placeholder="e.g. Revenue collection continuity plan"
              onChange={(e) => set("title", e.target.value)}
            />
          </Field>

          <Field
            label="Purpose"
            htmlFor="plan-purpose"
            hint="What this plan exists to protect, and for whom."
          >
            <Textarea
              id="plan-purpose"
              rows={2}
              value={form.purpose}
              onChange={(e) => set("purpose", e.target.value)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Primary business service" htmlFor="plan-primary-service">
              <Select
                value={form.primaryServiceId}
                onValueChange={(value) => {
                  setForm((prev) => ({
                    ...prev,
                    primaryServiceId: value,
                    additionalServiceIds: prev.additionalServiceIds.filter(
                      (id) => id !== value,
                    ),
                    biaId: "",
                  }));
                }}
              >
                <SelectTrigger id="plan-primary-service">
                  <SelectValue placeholder="Choose a service" />
                </SelectTrigger>
                <SelectContent>
                  {services.map((service) => (
                    <SelectItem key={service._id} value={service._id}>
                      {service.reference} — {service.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Plan owner" htmlFor="plan-owner">
              <Select
                value={form.ownerUserId}
                onValueChange={(value) => set("ownerUserId", value)}
              >
                <SelectTrigger id="plan-owner">
                  <SelectValue placeholder="Choose an owner" />
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

          <fieldset className="rounded-lg border border-border/70 p-3">
            <legend className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Additional services covered ({form.additionalServiceIds.length}/
              {BCM_MAX_ADDITIONAL_SERVICES})
            </legend>
            <p className="mb-2 text-xs text-muted-foreground">
              Optional. A service can appear in several plans, but only once in
              this one.
            </p>
            <div className="grid max-h-40 gap-1 overflow-y-auto sm:grid-cols-2">
              {services
                .filter((service) => service._id !== form.primaryServiceId)
                .map((service) => (
                  <label
                    key={service._id}
                    className="flex items-center gap-2 rounded px-1 py-0.5 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={form.additionalServiceIds.includes(service._id)}
                      onChange={() => toggleAdditional(service._id)}
                    />
                    <span className="truncate">
                      {service.reference} — {service.name}
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({BCM_CRITICALITY_LABELS[service.criticality]})
                      </span>
                    </span>
                  </label>
                ))}
            </div>
          </fieldset>

          <Field
            label="Recovery baseline (business impact analysis)"
            htmlFor="plan-bia"
            hint={
              biaOptions.some((row) => row.approved)
                ? "Prefer the approved version: an approved plan is reviewed against the baseline recorded here."
                : "No approved analysis exists for the selected service. A draft baseline is recorded but flagged as unapproved."
            }
          >
            <Select
              value={form.biaId || "none"}
              onValueChange={(value) => set("biaId", value === "none" ? "" : value)}
            >
              <SelectTrigger id="plan-bia">
                <SelectValue placeholder="No linked analysis" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No linked analysis</SelectItem>
                {biaOptions.map((row) => (
                  <SelectItem key={row._id} value={row._id}>
                    {row.reference} v{row.version} —{" "}
                    {BCM_BIA_STATUS_LABELS[row.status]}
                    {row.approved ? " (approved)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field
            label="Disruption scenarios addressed"
            htmlFor="plan-scenarios"
            hint="The events this plan is written for. Be specific about scope and duration."
          >
            <Textarea
              id="plan-scenarios"
              rows={3}
              value={form.disruptionScenarios}
              onChange={(e) => set("disruptionScenarios", e.target.value)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Recovery priority" htmlFor="plan-priority">
              <Select
                value={form.recoveryPriority}
                onValueChange={(value) => set("recoveryPriority", value as BcmPriority)}
              >
                <SelectTrigger id="plan-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BCM_PRIORITIES.map((priority) => (
                    <SelectItem key={priority} value={priority}>
                      {BCM_PRIORITY_LABELS[priority]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              label="Next review date"
              htmlFor="plan-review"
              hint="Within three years of today."
            >
              <Input
                id="plan-review"
                type="date"
                value={form.reviewDueAt}
                onChange={(e) => set("reviewDueAt", e.target.value)}
              />
            </Field>
          </div>

          <Field label="Scope" htmlFor="plan-scope">
            <Textarea
              id="plan-scope"
              rows={2}
              value={form.scope}
              onChange={(e) => set("scope", e.target.value)}
            />
          </Field>
          <Field label="Exclusions" htmlFor="plan-exclusions">
            <Textarea
              id="plan-exclusions"
              rows={2}
              value={form.exclusions}
              onChange={(e) => set("exclusions", e.target.value)}
            />
          </Field>
          <Field
            label="Assumptions"
            htmlFor="plan-assumptions"
            hint="What must be true for this plan to be usable."
          >
            <Textarea
              id="plan-assumptions"
              rows={2}
              value={form.assumptions}
              onChange={(e) => set("assumptions", e.target.value)}
            />
          </Field>

          {selectedServiceName ? (
            <p className="text-xs text-muted-foreground">
              Primary service: {selectedServiceName}. Recovery objectives are
              owned by the business impact analysis, not by this plan.
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy} data-testid="bcm-plan-save">
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
            {planId ? "Save changes" : "Create draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
