import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { FileText, Plus, Send, Check, Undo2, ThumbsUp } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
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
import {
  WORKING_PAPER_LABELS,
  WORKING_PAPER_TRANSITIONS,
  workingPaperTransitionAllowed,
  type WorkingPaperStatus,
  type AuditTeamRole,
} from "@/lib/auditWorkflow";
import { ListPageShell, ListSkeleton, EmptyState } from "./ListPageShell";

/**
 * Module 6 — Working papers: Draft → Submitted → Reviewed/Returned →
 * Approved with auditor notes, reviewer comments and approval history.
 * Transitions are mirrored from the server state machine and role matrix;
 * only engagement-assigned users see their engagements' papers.
 */

interface WpRow {
  _id: string;
  code: string;
  title: string;
  description?: string;
  status: string;
  authorName: string;
  reviewerName?: string | null;
  submittedAt?: number | null;
  approvedAt?: number | null;
}

export function WorkpapersPage({ path }: { path: string }) {
  const engagements = useQuery(api.auditEngagements.listMine, {});
  const [engagementId, setEngagementId] = useState<string | null>(null);
  const active = engagementId ?? engagements?.[0]?.engagement?._id ?? null;
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const papers = useQuery(
    api.auditWorkpapers.listWorkingPapers,
    active ? { engagementId: active as never } : "skip",
  );

  return (
    <ListPageShell
      path={path}
      eyebrow="Audit Management"
      title="Working Papers"
      description="Preparer–reviewer workflow for audit documentation: notes, test results, reviewer comments and approval history."
      actions={
        active && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden /> New working paper
          </Button>
        )
      }
    >
      {engagements === undefined ? (
        <ListSkeleton rows={2} />
      ) : engagements.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No engagement assignments"
          description="Working papers belong to engagements. You can access papers for engagements where you are on the audit team."
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

          {papers === undefined ? (
            <ListSkeleton />
          ) : papers.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No working papers"
              description="Create working papers to document procedures performed, evidence obtained and conclusions reached."
              action={
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className="size-4" aria-hidden /> New working paper
                </Button>
              }
            />
          ) : (
            <ul className="space-y-2">
              {papers.map((wp) => (
                <li key={wp._id}>
                  <Card
                    role="button"
                    tabIndex={0}
                    onClick={() => setOpenId(wp._id)}
                    onKeyDown={(e) => e.key === "Enter" && setOpenId(wp._id)}
                    className="cursor-pointer shadow-none transition-colors hover:border-border"
                  >
                    <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm font-medium">
                          <span className="font-mono text-xs text-muted-foreground">
                            {wp.code}
                          </span>
                          {wp.title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          By {wp.authorName} · updated{" "}
                          {formatRelative(wp.updatedAt)}
                        </p>
                      </div>
                      <StatusChip status={wp.status} />
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {active && (
        <CreateWpDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          engagementId={active}
        />
      )}
      <WpDetailDialog id={openId} onClose={() => setOpenId(null)} />
    </ListPageShell>
  );
}

// ---------------------------------------------------------------------------
// Detail dialog with workflow controls + comments
// ---------------------------------------------------------------------------

function WpDetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const data = useQuery(
    api.auditWorkpapers.getWorkingPaper,
    id ? { id: id as never } : "skip",
  );
  const transition = useMutation(api.auditWorkpapers.transitionWorkingPaper);
  const addComment = useMutation(api.auditWorkpapers.addWorkingPaperComment);
  const updateWp = useMutation(api.auditWorkpapers.updateWorkingPaper);
  const [comment, setComment] = useState("");
  const [content, setContent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!id) return null;
  if (data === undefined) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-2xl">
          <ListSkeleton rows={3} />
        </DialogContent>
      </Dialog>
    );
  }
  if (data === null) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-2xl">
          <p className="text-sm text-muted-foreground">Working paper not found.</p>
        </DialogContent>
      </Dialog>
    );
  }

  const wp = data.workingPaper as unknown as WpRow & { content?: string };
  const viewerTeamRole = (data.viewer?.teamRole ?? undefined) as
    | AuditTeamRole
    | undefined;
  const isManagerLike = data.viewer?.isManagerLike === true;

  const legalTargets = (WORKING_PAPER_TRANSITIONS[wp.status as WorkingPaperStatus] ?? []).filter(
    (to) => workingPaperTransitionAllowed(wp.status as WorkingPaperStatus, to, viewerTeamRole),
  );

  const act = async (to: WorkingPaperStatus) => {
    setBusy(true);
    try {
      await transition({ id: wp._id as never, to });
      toast.success(`Working paper → ${WORKING_PAPER_LABELS[to]}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="font-mono text-sm text-muted-foreground">{wp.code}</span>
            {wp.title}
          </DialogTitle>
          <DialogDescription>
            {wp.description ?? "No description recorded."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={wp.status} />
            <span className="text-xs text-muted-foreground">
              Prepared by {wp.authorName ?? "—"}
              {wp.reviewerName ? ` · Reviewer: ${wp.reviewerName}` : ""}
            </span>
          </div>

          {/* Preparer content (editable in draft/returned) */}
          {isManagerLike === false &&
            (wp.status === "draft" || wp.status === "returned") && (
              <div className="space-y-1.5">
                <Label htmlFor="wp-content">Auditor notes / test results</Label>
                <Textarea
                  id="wp-content"
                  rows={6}
                  value={content ?? wp.content ?? ""}
                  onChange={(e) => setContent(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await updateWp({
                        id: wp._id as never,
                        content: content ?? wp.content,
                      });
                      toast.success("Working paper saved");
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : "Failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                  disabled={busy}
                >
                  Save notes
                </Button>
              </div>
            )}
          {(wp.status === "submitted" || wp.status === "reviewed" || wp.status === "approved") && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Auditor notes / test results
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm">
                {wp.content || <span className="text-muted-foreground">Not recorded</span>}
              </p>
            </div>
          )}

          {/* Workflow controls */}
          {legalTargets.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {legalTargets.map((to) => (
                <Button
                  key={to}
                  size="sm"
                  variant={to === "returned" ? "destructive" : "outline"}
                  disabled={busy}
                  onClick={() => act(to)}
                >
                  {to === "submitted" && (
                    <Send className="size-4" aria-hidden />
                  )}
                  {to === "returned" && (
                    <Undo2 className="size-4" aria-hidden />
                  )}
                  {to === "approved" && (
                    <ThumbsUp className="size-4" aria-hidden />
                  )}
                  {to === "reviewed" && <Check className="size-4" aria-hidden />}
                  {WORKING_PAPER_LABELS[to]}
                </Button>
              ))}
            </div>
          )}

          {/* Comments / approval history */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Review comments & history
            </p>
            <ol className="space-y-2.5">
              {data.comments.length === 0 && (
                <li className="text-sm text-muted-foreground">
                  No comments yet.
                </li>
              )}
              {data.comments.map((c) => (
                <li key={c._id} className="rounded-lg border border-border/60 px-3 py-2 text-sm">
                  <p className="font-medium">{c.authorName ?? "User"}</p>
                  <p className="whitespace-pre-wrap">{c.body}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatRelative(c.createdAt)}
                  </p>
                </li>
              ))}
            </ol>
            <div className="mt-3 flex gap-2">
              <Input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Add a comment…"
              />
              <Button
                size="sm"
                disabled={!comment || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await addComment({
                      workingPaperId: wp._id as never,
                      body: comment,
                    });
                    setComment("");
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Failed");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Comment
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

function CreateWpDialog({
  open,
  onClose,
  engagementId,
}: {
  open: boolean;
  onClose: () => void;
  engagementId: string;
}) {
  const create = useMutation(api.auditWorkpapers.createWorkingPaper);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New working paper</DialogTitle>
          <DialogDescription>
            Created as Draft. Submit it for review when the documentation is
            complete.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="wp-title">Title *</Label>
            <Input
              id="wp-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wp-desc">Description</Label>
            <Textarea
              id="wp-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wp-notes">Auditor notes / test results</Label>
            <Textarea
              id="wp-notes"
              rows={5}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!title || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await create({
                  engagementId: engagementId as never,
                  title,
                  description: description || undefined,
                  content: content || undefined,
                });
                toast.success("Working paper created");
                setTitle("");
                setDescription("");
                setContent("");
                onClose();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
