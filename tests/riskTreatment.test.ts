import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../src/convex/_generated/api";
import {
  canTransitionTreatment,
  treatmentProgress,
} from "../src/lib/risk";

/**
 * Phase 3B — Batch 2B: ICT risk treatment plans and actions.
 * =========================================================
 * Structural guards (permission gating, tenant re-checks, shared state machine,
 * no risk-score writes) plus runtime behaviour against the development backend:
 * plan creation, multiple actions per plan, controlled status updates,
 * completion evidence, overdue detection, progress derivation, audit
 * attribution and — critically — proof that treatment never changes residual
 * risk. Cross-tenant denial and owner validation against a real second
 * organization live in tests/risk.tenant.test.ts.
 */

const CONVEX_URL = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const HARNESS = process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const DAY = 24 * 60 * 60 * 1000;

function testerToken(): string {
  const fromEnv = process.env.IITAMS_TESTER_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    return readFileSync(join(process.cwd(), ".iitams-tester-token"), "utf8").trim();
  } catch {
    return "";
  }
}
const token = testerToken();
const harnessConfigured = Boolean(token);

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CONVEX_URL}/api/query`);
    return res.status < 600;
  } catch {
    return false;
  }
}

async function signInAnonymous(): Promise<ConvexHttpClient> {
  const guest = new ConvexHttpClient(CONVEX_URL);
  const result = (await (guest as unknown as {
    action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
  }).action(api.auth.signIn, { provider: "anonymous", params: {} })) as {
    tokens?: { token?: string; accessToken?: string };
  };
  const jwt = result.tokens?.token ?? result.tokens?.accessToken;
  if (jwt) (guest as unknown as { setAuth: (v: string) => void }).setAuth(jwt);
  return guest;
}

async function adminClient(): Promise<ConvexHttpClient | null> {
  if (!token) return null;
  const admin = await signInAnonymous();
  await admin.mutation(api.session.joinDemoOrganization, {});
  const session = (await admin.query(api.session.getSession, {})) as {
    userId?: string;
  } | null;
  if (!session?.userId) return null;
  const res = await fetch(`${HARNESS}/api/dev-grant-demo-role`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-iitams-tester-token": token,
    },
    body: JSON.stringify({ userId: session.userId, role: "admin", ttlMinutes: 60 }),
  });
  if (!res.ok) return null;
  return admin;
}

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 99999)}`;

type PlanRow = {
  _id: string;
  reference: string;
  strategy: string;
  objective: string;
  ownerName: string;
  status: string;
  targetDate: number;
  completedAt?: number;
  progress: {
    total: number;
    completed: number;
    overdue: number;
    progressPct: number;
  };
  actions: Array<{
    _id: string;
    description: string;
    ownerName: string;
    status: string;
    dueDate: number;
    overdue: boolean;
    completedAt?: number;
    completionNotes?: string;
  }>;
};

type PlanList = {
  risk: {
    code: string;
    status: string;
    residualScore: number;
    residualBand: string;
  };
  plans: PlanRow[];
  summary: {
    total: number;
    open: number;
    inProgress: number;
    completed: number;
    actionsTotal: number;
    actionsCompleted: number;
    actionsOverdue: number;
  };
};

type RiskDetail = {
  code: string;
  status: string;
  residualScore: number;
  history: Array<{ action: string; actorLabel?: string; summary?: string }>;
};

// ============================================================================
// Structural
// ============================================================================

describe("Risk treatment — structural guards", () => {
  const src = readFileSync("src/convex/riskTreatment.ts", "utf8");
  const schemaSrc = readFileSync("src/convex/schema.ts", "utf8");
  const uiSrc = readFileSync(
    "src/components/iitams/risk/RiskTreatmentPlans.tsx",
    "utf8",
  );
  const pageSrc = readFileSync(
    "src/components/iitams/risk/RiskRegisterPage.tsx",
    "utf8",
  );
  const libSrc = readFileSync("src/lib/risk.ts", "utf8");

  test("reads require risk.view and writes require risk.manage plus active membership", () => {
    expect(src).toContain('requirePermission(ctx, "risk.view")');
    expect(src).toContain('requirePermission(ctx, "risk.manage")');
    expect(src).toContain("access.isProvisioned");
    // Exactly one authorization helper per access level; every query and
    // mutation goes through them.
    expect(src.match(/function requireViewer\(/g)?.length).toBe(1);
    expect(src.match(/function requireManager\(/g)?.length).toBe(1);
    expect(src.match(/await requireViewer\(ctx\)/g)?.length).toBe(5);
    expect(src.match(/await requireManager\(ctx\)/g)?.length).toBe(4);
  });

  test("organization always comes from the access context, never a client arg", () => {
    expect(src).toContain("risk.organizationId !== manager.organizationId");
    expect(src).toContain("plan.organizationId !== manager.organizationId");
    expect(src).toContain("action.organizationId !== manager.organizationId");
    expect(src).not.toContain('organizationId: v.id("organizations")');
    expect(src).toContain("if (!risk || risk.organizationId !== viewer.organizationId) return null;");
  });

  test("treatment never writes risk scores or status", () => {
    // No patch of the risk row exists anywhere in the module: residual risk
    // changes only through riskAssessments.ts.
    expect(src).not.toContain("ctx.db.patch(risk");
    expect(src).not.toContain("ctx.db.patch(args.riskId");
    // No patch payload mentions a score factor, and no delete exists at all.
    const patches = [...src.matchAll(/ctx\.db\.patch\([\s\S]*?\);/g)].map(
      (m) => m[0],
    );
    expect(patches.length).toBeGreaterThan(0);
    for (const patch of patches) {
      expect(patch).not.toContain("residual");
      expect(patch).not.toContain("inherent");
      expect(patch).not.toContain("reviewDue");
    }
    expect(src).not.toContain("ctx.db.delete(");
    expect(src).not.toContain("export const deletePlan");
    expect(src).not.toContain("export const deleteAction");
  });

  test("plans and actions are separate tables with tenant-scoped indexes", () => {
    expect(schemaSrc).toContain("riskTreatmentPlans: defineTable({");
    expect(schemaSrc).toContain("riskTreatmentActions: defineTable({");
    expect(schemaSrc).toContain(
      'index("by_organization_reference", ["organizationId", "reference"])',
    );
    expect(schemaSrc).toContain(
      'index("by_organization_plan", ["organizationId", "planId"])',
    );
    expect(schemaSrc).toContain(
      'index("by_organization_due", ["organizationId", "dueDate"])',
    );
    // Actions are inserted once and only their controlled status is patched.
    const actionPatches = [
      ...src.matchAll(/ctx\.db\.patch\(action\._id,\s*\{([\s\S]*?)\}\)/g),
    ].map((m) => m[1]);
    expect(actionPatches).toHaveLength(1);
    expect(actionPatches[0]).toContain("status:");
  });

  test("state machine and progress come from the shared risk model", () => {
    expect(libSrc).toContain("TREATMENT_TRANSITIONS");
    expect(libSrc).toContain("export function canTransitionTreatment");
    expect(libSrc).toContain("export function treatmentProgress");
    expect(src).toContain("canTransitionTreatment(plan.status, args.status)");
    expect(src).toContain("canTransitionTreatment(action.status, args.status)");
    expect(src).toContain("treatmentProgress(actions, now)");
    // Invalid transitions are refused, not coerced.
    expect(canTransitionTreatment("planned", "completed")).toBe(false);
    expect(canTransitionTreatment("planned", "in_progress")).toBe(true);
    expect(canTransitionTreatment("in_progress", "completed")).toBe(true);
    expect(canTransitionTreatment("completed", "in_progress")).toBe(false);
    expect(canTransitionTreatment("cancelled", "planned")).toBe(false);
    const progress = treatmentProgress(
      [
        { status: "completed", dueDate: 0 },
        { status: "cancelled", dueDate: 0 },
        { status: "planned", dueDate: 0 },
      ],
      DAY,
    );
    expect(progress.total).toBe(3);
    expect(progress.completed).toBe(1);
    expect(progress.cancelled).toBe(1);
    expect(progress.progressPct).toBe(50);
  });

  test("every mutation is audited with actor, organization, risk and timestamp", () => {
    for (const action of [
      "risk.treatment_plan_created",
      "risk.treatment_plan_status_changed",
      "risk.treatment_action_added",
      "risk.treatment_action_status_changed",
    ]) {
      expect(src).toContain(`action: "${action}"`);
    }
    expect(src).toContain("actorId: manager.userId");
    expect(src).toContain("actorLabel: manager.label");
    expect(src.match(/organizationId: manager\.organizationId/g)?.length).toBeGreaterThan(3);
    expect(src).toContain("userId: risk.ownerUserId");
  });

  test("assigned ownership is validated against active same-org membership", () => {
    expect(src).toContain('withIndex("userId"');
    expect(src).toContain("Assigned owner is not a member of your organization");
    expect(src).toContain(
      'effectiveMembershipStatus(profile.membershipStatus) !== "active"',
    );
  });

  test("the register detail mounts treatment without disturbing assessments", () => {
    expect(pageSrc).toContain("RiskTreatmentPlans");
    expect(pageSrc).toContain("RiskAssessments");
    expect(uiSrc).toContain("Treatment plans");
    expect(uiSrc).toContain("New treatment plan");
    expect(uiSrc).toContain("Add action");
    expect(uiSrc).toContain("canManage");
    expect(uiSrc).toContain("residual score is unchanged");
  });
});

// ============================================================================
// Runtime
// ============================================================================

describe("Risk treatment — runtime", () => {
  test(
    "creates a plan with multiple actions, derives progress and leaves residual risk untouched",
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const admin = await adminClient();
      if (!admin) {
        throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
      }

      const suffix = uniq();
      const risk = (await admin.mutation(api.risks.createRisk, {
        title: `Treatment fixture risk ${suffix}`,
        category: "Cyber",
        inherentLikelihood: 5,
        inherentImpact: 4,
        residualLikelihood: 3,
        residualImpact: 3,
        ownerName: "Treatment Risk Owner",
      })) as { riskId: string; code: string };
      const before = (await admin.query(api.risks.getRisk, {
        riskId: risk.riskId as never,
      })) as RiskDetail;
      expect(before.residualScore).toBe(9);
      expect(before.status).toBe("open");

      const plan = (await admin.mutation(api.riskTreatment.createPlan, {
        riskId: risk.riskId as never,
        strategy: "mitigate",
        objective: "Reduce the exposure of the payment gateway to acceptable levels",
        justification: "Compensating controls can be delivered within the quarter",
        ownerName: "Treatment Plan Owner",
        targetDate: Date.now() + 60 * DAY,
        notes: "Reviewed at the risk forum",
      })) as { planId: string; reference: string };
      expect(plan.reference).toMatch(/^TP-\d{3}$/);

      const firstAction = (await admin.mutation(api.riskTreatment.addAction, {
        planId: plan.planId as never,
        description: "Enable multi-factor authentication for administrators",
        ownerName: "Identity Lead",
        dueDate: Date.now() + 20 * DAY,
        reference: "CHG-1042",
      })) as { actionId: string };
      const secondAction = (await admin.mutation(api.riskTreatment.addAction, {
        planId: plan.planId as never,
        description: "Segment the gateway from the corporate network",
        ownerName: "Network Lead",
        dueDate: Date.now() + 40 * DAY,
      })) as { actionId: string };
      expect(firstAction.actionId).not.toBe(secondAction.actionId);

      // An action created with a past due date is reported as overdue.
      await admin.mutation(api.riskTreatment.addAction, {
        planId: plan.planId as never,
        description: "Record the existing monitoring gap as overdue work",
        ownerName: "Network Lead",
        dueDate: Date.now() - 2 * DAY,
      });

      const list = (await admin.query(api.riskTreatment.listForRisk, {
        riskId: risk.riskId as never,
      })) as PlanList;
      expect(list.plans).toHaveLength(1);
      expect(list.plans[0].actions).toHaveLength(3);
      expect(list.plans[0].reference).toBe(plan.reference);
      expect(list.plans[0].progress.total).toBe(3);
      expect(list.plans[0].progress.completed).toBe(0);
      expect(list.plans[0].progress.overdue).toBe(1);
      expect(list.plans[0].ownerName).toBe("Treatment Plan Owner");
      expect(list.summary.actionsOverdue).toBe(1);
      expect(list.summary.open).toBe(1);
      // The register's current residual score is reported, not recalculated
      // from treatment activity.
      expect(list.risk.residualScore).toBe(9);
      expect(list.risk.status).toBe("open");

      const detail = (await admin.query(api.riskTreatment.getPlan, {
        planId: plan.planId as never,
      })) as PlanRow & { risk: { code: string; residualScore: number } };
      expect(detail.risk.code).toBe(risk.code);
      expect(detail.risk.residualScore).toBe(9);
      expect(detail.actions.map((a) => a.description)).toContain(
        "Enable multi-factor authentication for administrators",
      );

      const overdue = (await admin.query(api.riskTreatment.overdueActions, {})) as Array<{
        _id: string;
        planReference: string;
        riskCode: string;
      }>;
      const overdueRow = overdue.find((a) => a.planReference === plan.reference);
      expect(overdueRow).toBeDefined();
      expect(overdueRow?.riskCode).toBe(risk.code);

      const summary = (await admin.query(
        api.riskTreatment.treatmentSummary,
        {},
      )) as {
        treatmentPlanned: number;
        actionsTotal: number;
        actionsOverdue: number;
        risksAssessed: number;
      };
      expect(summary.treatmentPlanned).toBeGreaterThanOrEqual(1);
      expect(summary.actionsOverdue).toBeGreaterThanOrEqual(1);
      expect(summary.risksAssessed).toBeGreaterThanOrEqual(0);

      // Audit attribution: actor, risk code and each mutation's own entry.
      const after = (await admin.query(api.risks.getRisk, {
        riskId: risk.riskId as never,
      })) as RiskDetail;
      for (const action of [
        "risk.treatment_plan_created",
        "risk.treatment_action_added",
      ]) {
        const entry = after.history.find((h) => h.action === action);
        expect(entry).toBeDefined();
        expect((entry?.actorLabel ?? "").length).toBeGreaterThan(0);
        expect(entry?.summary).toContain(risk.code);
      }
      expect(
        after.history.filter((h) => h.action === "risk.treatment_action_added"),
      ).toHaveLength(3);

      // The risk itself is untouched by treatment work.
      expect(after.residualScore).toBe(9);
      expect(after.status).toBe("open");
      expect(after.history.some((h) => h.action === "risk.updated")).toBe(false);
    },
    120000,
  );

  test(
    "enforces controlled transitions, completion evidence and ownership validation",
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const admin = await adminClient();
      if (!admin) {
        throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
      }
      const risk = (await admin.mutation(api.risks.createRisk, {
        title: `Treatment transition risk ${uniq()}`,
        category: "Data",
        inherentLikelihood: 3,
        inherentImpact: 4,
        residualLikelihood: 2,
        residualImpact: 2,
      })) as { riskId: string; code: string };

      const plan = (await admin.mutation(api.riskTreatment.createPlan, {
        riskId: risk.riskId as never,
        strategy: "accept",
        objective: "Document the acceptance proposal for board review",
        justification: "Cost of treatment currently exceeds the exposure",
        ownerName: "Risk Owner",
        targetDate: Date.now() + 45 * DAY,
      })) as { planId: string; reference: string };

      // Acceptance is a proposal only: the risk is not approved or rescored.
      const afterAccept = (await admin.query(api.riskTreatment.listForRisk, {
        riskId: risk.riskId as never,
      })) as PlanList;
      expect(afterAccept.plans[0].strategy).toBe("accept");
      expect(afterAccept.risk.status).toBe("open");
      expect(afterAccept.risk.residualScore).toBe(4);

      // Creating a plan requires a real owner, a future target and an objective.
      await expect(
        admin.mutation(api.riskTreatment.createPlan, {
          riskId: risk.riskId as never,
          strategy: "mitigate",
          objective: "short",
          justification: "Sufficient justification text here",
          ownerName: "Owner",
          targetDate: Date.now() + 10 * DAY,
        }),
      ).rejects.toThrow(/at least 10 characters/i);
      await expect(
        admin.mutation(api.riskTreatment.createPlan, {
          riskId: risk.riskId as never,
          strategy: "mitigate",
          objective: "Deliver compensating controls for the archive platform",
          justification: "Sufficient justification text here",
          targetDate: Date.now() - DAY,
        }),
      ).rejects.toThrow(/future/i);
      await expect(
        admin.mutation(api.riskTreatment.createPlan, {
          riskId: risk.riskId as never,
          strategy: "mitigate",
          objective: "Deliver compensating controls for the archive platform",
          justification: "Sufficient justification text here",
          targetDate: Date.now() + 10 * DAY,
        }),
      ).rejects.toThrow(/owner is required/i);

      // Plan state machine.
      await expect(
        admin.mutation(api.riskTreatment.updatePlanStatus, {
          planId: plan.planId as never,
          status: "completed",
        }),
      ).rejects.toThrow(/invalid status transition/i);
      await admin.mutation(api.riskTreatment.updatePlanStatus, {
        planId: plan.planId as never,
        status: "in_progress",
      });

      const action = (await admin.mutation(api.riskTreatment.addAction, {
        planId: plan.planId as never,
        description: "Produce the documented acceptance proposal",
        ownerName: "Risk Owner",
        dueDate: Date.now() + 5 * DAY,
      })) as { actionId: string };

      // Action state machine: planned → completed is refused.
      await expect(
        admin.mutation(api.riskTreatment.updateActionStatus, {
          actionId: action.actionId as never,
          status: "completed",
          completionNotes: "Attempting to skip the in-progress state",
        }),
      ).rejects.toThrow(/invalid status transition/i);

      await admin.mutation(api.riskTreatment.updateActionStatus, {
        actionId: action.actionId as never,
        status: "in_progress",
      });
      // Completion requires evidence notes.
      await expect(
        admin.mutation(api.riskTreatment.updateActionStatus, {
          actionId: action.actionId as never,
          status: "completed",
        }),
      ).rejects.toThrow(/completion notes/i);
      const completed = (await admin.mutation(
        api.riskTreatment.updateActionStatus,
        {
          actionId: action.actionId as never,
          status: "completed",
          completionNotes: "Proposal pack signed and filed as evidence 2026-04",
        },
      )) as { completedAt: number | null; status: string };
      expect(completed.status).toBe("completed");
      expect(typeof completed.completedAt).toBe("number");

      // Completed is terminal: history is preserved, not reopened.
      await expect(
        admin.mutation(api.riskTreatment.updateActionStatus, {
          actionId: action.actionId as never,
          status: "in_progress",
        }),
      ).rejects.toThrow(/invalid status transition/i);

      await admin.mutation(api.riskTreatment.updatePlanStatus, {
        planId: plan.planId as never,
        status: "completed",
      });
      await expect(
        admin.mutation(api.riskTreatment.addAction, {
          planId: plan.planId as never,
          description: "Late addition to a completed plan",
          ownerName: "Risk Owner",
          dueDate: Date.now() + 5 * DAY,
        }),
      ).rejects.toThrow(/cannot add actions/i);

      const finalList = (await admin.query(api.riskTreatment.listForRisk, {
        riskId: risk.riskId as never,
      })) as PlanList;
      expect(finalList.plans[0].status).toBe("completed");
      expect(finalList.plans[0].progress.completed).toBe(1);
      expect(finalList.plans[0].progress.progressPct).toBe(100);
      expect(finalList.plans[0].actions[0].completionNotes).toContain(
        "Proposal pack signed",
      );
      // Completing the plan and its action did not move the risk at all.
      expect(finalList.risk.residualScore).toBe(4);
      expect(finalList.risk.status).toBe("open");
    },
    120000,
  );

  test(
    "plan completion requires resolved actions, and cancelled plans are read-only",
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const admin = await adminClient();
      if (!admin) {
        throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
      }
      const risk = (await admin.mutation(api.risks.createRisk, {
        title: `Lifecycle integrity risk ${uniq()}`,
        category: "Process",
        inherentLikelihood: 4,
        inherentImpact: 3,
        residualLikelihood: 3,
        residualImpact: 3,
      })) as { riskId: string };

      const plan = (await admin.mutation(api.riskTreatment.createPlan, {
        riskId: risk.riskId as never,
        strategy: "mitigate",
        objective: "Reduce the exposure with a documented control uplift",
        justification: "Residual exposure is above the accepted threshold",
        ownerName: "Lifecycle Owner",
        targetDate: Date.now() + 30 * DAY,
      })) as { planId: string };
      await admin.mutation(api.riskTreatment.updatePlanStatus, {
        planId: plan.planId as never,
        status: "in_progress",
      });
      const action = (await admin.mutation(api.riskTreatment.addAction, {
        planId: plan.planId as never,
        description: "Implement the compensating control",
        ownerName: "Lifecycle Owner",
        dueDate: Date.now() + 10 * DAY,
      })) as { actionId: string };

      // An unresolved action blocks plan completion.
      await expect(
        admin
          .mutation(api.riskTreatment.updatePlanStatus, {
            planId: plan.planId as never,
            status: "completed",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/unresolved action/i);

      await admin.mutation(api.riskTreatment.updateActionStatus, {
        actionId: action.actionId as never,
        status: "in_progress",
      });
      await expect(
        admin
          .mutation(api.riskTreatment.updatePlanStatus, {
            planId: plan.planId as never,
            status: "completed",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/unresolved action/i);

      await admin.mutation(api.riskTreatment.updateActionStatus, {
        actionId: action.actionId as never,
        status: "completed",
        completionNotes: "Control implemented and verified by infrastructure team",
      });
      await admin.mutation(api.riskTreatment.updatePlanStatus, {
        planId: plan.planId as never,
        status: "completed",
      });

      // Zero-action policy: a mitigation plan with no actions has no evidence
      // of work and must be cancelled; an acceptance proposal may close.
      const empty = (await admin.mutation(api.riskTreatment.createPlan, {
        riskId: risk.riskId as never,
        strategy: "mitigate",
        objective: "Empty plan must not be able to claim completion",
        justification: "Zero-action completion policy regression check",
        ownerName: "Lifecycle Owner",
        targetDate: Date.now() + 20 * DAY,
      })) as { planId: string };
      await admin.mutation(api.riskTreatment.updatePlanStatus, {
        planId: empty.planId as never,
        status: "in_progress",
      });
      await expect(
        admin
          .mutation(api.riskTreatment.updatePlanStatus, {
            planId: empty.planId as never,
            status: "completed",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/at least one treatment action/i);

      // Cancellation is terminal: it cannot be reopened or completed.
      await admin.mutation(api.riskTreatment.updatePlanStatus, {
        planId: empty.planId as never,
        status: "cancelled",
      });
      for (const status of ["completed", "in_progress", "planned"] as const) {
        await expect(
          admin
            .mutation(api.riskTreatment.updatePlanStatus, {
              planId: empty.planId as never,
              status,
            })
            .then((r) => JSON.stringify(r)),
        ).rejects.toThrow(/invalid status transition/i);
      }

      const accepted = (await admin.mutation(api.riskTreatment.createPlan, {
        riskId: risk.riskId as never,
        strategy: "accept",
        objective: "Document the risk-acceptance proposal for approval",
        justification: "Acceptance proposal is the deliverable of this plan",
        ownerName: "Lifecycle Owner",
        targetDate: Date.now() + 15 * DAY,
      })) as { planId: string };
      await admin.mutation(api.riskTreatment.updatePlanStatus, {
        planId: accepted.planId as never,
        status: "in_progress",
      });
      await admin.mutation(api.riskTreatment.updatePlanStatus, {
        planId: accepted.planId as never,
        status: "completed",
      });

      // Actions on a cancelled plan cannot be edited back into life.
      const cancelled = (await admin.mutation(api.riskTreatment.createPlan, {
        riskId: risk.riskId as never,
        strategy: "mitigate",
        objective: "Cancelled plan must freeze its action evidence",
        justification: "Cancellation cannot silently revive treatment work",
        ownerName: "Lifecycle Owner",
        targetDate: Date.now() + 25 * DAY,
      })) as { planId: string };
      const openAction = (await admin.mutation(api.riskTreatment.addAction, {
        planId: cancelled.planId as never,
        description: "Action frozen by plan cancellation",
        ownerName: "Lifecycle Owner",
        dueDate: Date.now() + 5 * DAY,
      })) as { actionId: string };
      await admin.mutation(api.riskTreatment.updatePlanStatus, {
        planId: cancelled.planId as never,
        status: "cancelled",
      });
      await expect(
        admin
          .mutation(api.riskTreatment.updateActionStatus, {
            actionId: openAction.actionId as never,
            status: "in_progress",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/cancelled treatment plan/i);

      // Treatment activity still never moved the risk itself.
      const list = (await admin.query(api.riskTreatment.listForRisk, {
        riskId: risk.riskId as never,
      })) as PlanList;
      expect(list.risk.residualScore).toBe(9);
      expect(list.risk.status).toBe("open");
    },
    120000,
  );

  test(
    "concurrent plan creation allocates unique per-organization references",
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const admin = await adminClient();
      if (!admin) {
        throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
      }
      const risk = (await admin.mutation(api.risks.createRisk, {
        title: `Concurrent treatment risk ${uniq()}`,
        category: "Process",
        inherentLikelihood: 2,
        inherentImpact: 3,
        residualLikelihood: 2,
        residualImpact: 2,
      })) as { riskId: string };

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          admin.mutation(api.riskTreatment.createPlan, {
            riskId: risk.riskId as never,
            strategy: "mitigate",
            objective: `Concurrent treatment objective number ${i}`,
            justification: "Concurrent reference allocation must stay unique",
            ownerName: "Concurrency Owner",
            targetDate: Date.now() + 30 * DAY,
          }),
        ),
      );
      const references = (results as Array<{ reference: string }>).map(
        (r) => r.reference,
      );
      expect(new Set(references).size).toBe(references.length);
      for (const reference of references) {
        expect(reference).toMatch(/^TP-\d{3}$/);
      }
      const list = (await admin.query(api.riskTreatment.listForRisk, {
        riskId: risk.riskId as never,
      })) as PlanList;
      expect(list.plans).toHaveLength(5);
    },
    120000,
  );

  test(
    "read-only roles can read treatment but cannot mutate it",
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const admin = await adminClient();
      if (!admin) {
        throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
      }
      const risk = (await admin.mutation(api.risks.createRisk, {
        title: `Read-only treatment risk ${uniq()}`,
        category: "Third-party",
        inherentLikelihood: 3,
        inherentImpact: 3,
        residualLikelihood: 2,
        residualImpact: 2,
      })) as { riskId: string };
      const plan = (await admin.mutation(api.riskTreatment.createPlan, {
        riskId: risk.riskId as never,
        strategy: "transfer",
        objective: "Transfer the residual exposure through contract terms",
        justification: "Supplier contract renewal is the appropriate vehicle",
        ownerName: "Supplier Manager",
        targetDate: Date.now() + 30 * DAY,
      })) as { planId: string };
      const action = (await admin.mutation(api.riskTreatment.addAction, {
        planId: plan.planId as never,
        description: "Negotiate the security schedule with the supplier",
        ownerName: "Supplier Manager",
        dueDate: Date.now() + 10 * DAY,
      })) as { actionId: string };

      const member = await signInAnonymous();
      await member.mutation(api.session.joinDemoOrganization, {});
      const list = (await member.query(api.riskTreatment.listForRisk, {
        riskId: risk.riskId as never,
      })) as PlanList;
      expect(list.plans).toHaveLength(1);
      expect(Array.isArray((await member.query(api.riskTreatment.listAssignableOwners, {})))).toBe(true);

      const createArgs = {
        riskId: risk.riskId as never,
        strategy: "mitigate" as const,
        objective: "A member must not be able to create this plan",
        justification: "Authorization is enforced on the server, not the UI",
        ownerName: "Unauthorized",
        targetDate: Date.now() + 30 * DAY,
      };
      await expect(member.mutation(api.riskTreatment.createPlan, createArgs)).rejects.toThrow(
        /Permission denied/i,
      );
      await expect(
        member.mutation(api.riskTreatment.addAction, {
          planId: plan.planId as never,
          description: "Unauthorized action attempt",
          ownerName: "Unauthorized",
          dueDate: Date.now() + 10 * DAY,
        }),
      ).rejects.toThrow(/Permission denied/i);
      await expect(
        member.mutation(api.riskTreatment.updatePlanStatus, {
          planId: plan.planId as never,
          status: "in_progress",
        }),
      ).rejects.toThrow(/Permission denied/i);
      await expect(
        member.mutation(api.riskTreatment.updateActionStatus, {
          actionId: action.actionId as never,
          status: "in_progress",
        }),
      ).rejects.toThrow(/Permission denied/i);
    },
    120000,
  );
});
