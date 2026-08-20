import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { ActionItem } from "../types/electron";
import { updateNoteInStore } from "../stores/noteStore";
import {
  useActionProcessingStore,
  selectNoteActionState,
  selectNoteGenerationCandidate,
  clearNoteGenerationCandidate,
  runBackgroundAction,
  cancelAction as storeCancelAction,
  type ActionProcessingStatus,
  type ActionProcessingProgress,
  type RunActionOptions,
} from "../stores/actionProcessingStore";

export type ActionProcessingState = ActionProcessingStatus;
export type { ActionProcessingProgress };

type CandidateAction = "apply" | "discard";

function candidateActionError(action: CandidateAction, code?: string): string {
  switch (code) {
    case "CANDIDATE_STALE":
      return "This review is stale because the note was edited. Generate a new enhancement before applying it.";
    case "ENHANCED_CONTENT_EXISTS":
      return "This note already has enhanced content, so the review cannot overwrite it.";
    case "CANDIDATE_NOT_FOUND":
    case "CANDIDATE_NOT_PENDING":
      return "This review is no longer available. Generate a new enhancement to review.";
    default:
      return `Unable to ${action} this encounter note. Please try again.`;
  }
}

/** React binding for the global actionProcessingStore, scoped to one note. */
export function useActionProcessing(noteId: number | null) {
  const { t } = useTranslation();

  const { status: state, actionName, progress } = useActionProcessingStore(
    useShallow((s) => selectNoteActionState(s, noteId))
  );
  const candidate = useActionProcessingStore(
    useShallow((s) => selectNoteGenerationCandidate(s, noteId))
  );
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [candidateError, setCandidateError] = useState<string | null>(null);

  useEffect(() => {
    setCandidateError(null);
  }, [noteId, candidate?.candidate_id]);

  const runAction = useCallback(
    (action: ActionItem, noteContent: string, contentHash: string, options: RunActionOptions) => {
      if (noteId == null) return;
      runBackgroundAction(noteId, noteContent, contentHash, action, options, {
        noModel: t("notes.actions.errors.noModel"),
        noEndpoint: t("notes.actions.errors.noEndpoint"),
        actionFailed: t("notes.actions.errors.actionFailed"),
      });
    },
    [noteId, t]
  );

  const cancel = useCallback(() => {
    if (noteId != null) storeCancelAction(noteId);
  }, [noteId]);

  const applyCandidate = useCallback(async (): Promise<boolean> => {
    if (noteId == null || !candidate) return false;
    const apply = window.electronAPI.applyNoteGenerationCandidate;
    if (typeof apply !== "function") {
      setCandidateError(candidateActionError("apply"));
      return false;
    }

    setCandidateBusy(true);
    setCandidateError(null);
    try {
      const result = await apply(candidate.candidate_id, { confirmed: true });
      if (!result.success) {
        setCandidateError(candidateActionError("apply", result.code));
        return false;
      }

      clearNoteGenerationCandidate(noteId);
      try {
        const refreshed = await window.electronAPI.getNote(noteId);
        if (refreshed) updateNoteInStore(refreshed);
      } catch {
        if (result.note) updateNoteInStore(result.note);
      }
      return true;
    } catch {
      setCandidateError(candidateActionError("apply"));
      return false;
    } finally {
      setCandidateBusy(false);
    }
  }, [candidate, noteId]);

  const discardCandidate = useCallback(async (): Promise<boolean> => {
    if (noteId == null || !candidate) return false;
    const discard = window.electronAPI.discardNoteGenerationCandidate;
    if (typeof discard !== "function") {
      setCandidateError(candidateActionError("discard"));
      return false;
    }

    setCandidateBusy(true);
    setCandidateError(null);
    try {
      const result = await discard(candidate.candidate_id);
      if (!result.success) {
        setCandidateError(candidateActionError("discard", result.code));
        return false;
      }
      clearNoteGenerationCandidate(noteId);
      return true;
    } catch {
      setCandidateError(candidateActionError("discard"));
      return false;
    } finally {
      setCandidateBusy(false);
    }
  }, [candidate, noteId]);

  return {
    state,
    actionName,
    progress,
    runAction,
    cancel,
    candidate,
    candidateBusy,
    candidateError,
    applyCandidate,
    discardCandidate,
  };
}
