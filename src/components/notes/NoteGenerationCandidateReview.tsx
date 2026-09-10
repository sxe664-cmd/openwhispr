import { useEffect, useState } from "react";
import type { NoteGenerationCandidate } from "../../types/electron";
import { RichTextEditor } from "../ui/RichTextEditor";

interface NoteGenerationCandidateReviewProps {
  candidate: NoteGenerationCandidate;
  busy?: boolean;
  error?: string | null;
  /** Pass true when the active note already has enhanced content. */
  hasExistingEnhancedContent?: boolean;
  onApply: () => void;
  onDiscard: () => void;
}

export default function NoteGenerationCandidateReview({
  candidate,
  busy = false,
  error,
  hasExistingEnhancedContent,
  onApply,
  onDiscard,
}: NoteGenerationCandidateReviewProps) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [applyArmed, setApplyArmed] = useState(false);

  useEffect(() => {
    setApplyArmed(false);
  }, [candidate.candidate_id]);

  // The integration hook currently does not expose enhanced_content presence,
  // so the safe default is a two-step confirmation. Callers that explicitly
  // pass false may use the one-click path for a note with no existing output.
  const requiresConfirmation = hasExistingEnhancedContent !== false;
  const handleApply = () => {
    if (requiresConfirmation && !applyArmed) {
      setApplyArmed(true);
      return;
    }
    setApplyArmed(false);
    onApply();
  };

  return (
    <section className="mx-4 mb-3 rounded-lg border border-accent/20 bg-accent/5 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-foreground/80">
            {candidate.is_stale ? "Earlier-source draft — generate again to use the latest note" : candidate.candidate_kind === "generic" ? "Generated note draft" : "Clinical note ready for review"}
          </div>
          <div className="text-[11px] text-muted-foreground/70">
            {candidate.template_name || "Clinical Encounter template"}
            {candidate.template_revision_version != null
              ? ` · revision ${candidate.template_revision_version}`
              : ""}
            {" · review before applying"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setPreviewOpen((open) => !open)}
            disabled={busy}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-foreground/70 hover:bg-foreground/5 disabled:opacity-40"
          >
            {previewOpen ? "Hide preview" : "Preview"}
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={busy || candidate.is_stale}
            className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-accent-foreground hover:bg-accent/90 disabled:opacity-40"
          >
            {applyArmed ? "Confirm apply" : "Apply"}
          </button>
          <button
            type="button"
            onClick={onDiscard}
            disabled={busy}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-foreground/5 disabled:opacity-40"
          >
            Discard
          </button>
        </div>
      </div>
      {applyArmed && (
        <div
          role="alert"
          className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-950 dark:text-amber-100"
        >
          {hasExistingEnhancedContent
            ? "This note already has enhanced content. Confirm apply to replace it."
            : "Review the preview, then confirm apply to add this enhanced note."}
        </div>
      )}
      {previewOpen && (
        <div className="mt-3 max-h-[28rem] overflow-auto rounded-md border border-border/60 bg-background/70 p-2">
          <RichTextEditor
            value={candidate.generated_content}
            disabled
            className="min-h-0 border-0 bg-transparent text-sm"
          />
        </div>
      )}
      {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
    </section>
  );
}
