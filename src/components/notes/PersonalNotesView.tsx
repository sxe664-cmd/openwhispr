import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Plus, SquarePen, Search, Sparkles } from "lucide-react";
import { useToast } from "../ui/useToast";
import NoteEditor from "./NoteEditor";
import SpacesTree from "./SpacesTree";
import { ContainerOverview } from "./overview/ContainerOverview";
import ActionPicker from "./ActionPicker";
import ActionManagerDialog from "./ActionManagerDialog";
import AddNotesToFolderDialog from "./AddNotesToFolderDialog";
import ClinicalNoteExportDialog from "./ClinicalNoteExportDialog";
import NoteGenerationCandidateReview from "./NoteGenerationCandidateReview";
import EncounterCompletionPrompt from "./EncounterCompletionPrompt";
import { useActionProcessing } from "../../hooks/useActionProcessing";
import {
  isBuiltInGenerateNotesAction,
  resolveEncounterTemplate,
} from "../../stores/actionProcessingStore";
import type { NoteMoveTarget } from "../../hooks/useNoteDragAndDrop";
import {
  normalizeMeetingContext,
  type LocalEncounter,
  type MeetingContext,
  type NoteItem,
} from "../../types/electron";
import {
  getSettings,
  useSettingsStore,
  selectIsCloudNoteFormattingMode,
  selectPolicyEffectiveSettings,
  selectResolvedNoteFormatting,
} from "../../stores/settingsStore";
import { cn } from "../lib/utils";
import logger from "../../utils/logger";
import { parseTranscriptSegments } from "../../utils/parseTranscriptSegments";
import { isExplicitSpeakerCount, resolveExpectedSpeakerCount } from "../../utils/participants";
import {
  useNotes,
  useSpaces,
  useFolders,
  useActiveNote,
  useActiveNoteId,
  useActiveFolderId,
  useActiveContext,
  initializeNotes,
  initializeNotesTree,
  loadFolders,
  setActiveNoteId,
  setActiveContext,
  revealContainer,
  createFolder,
  getNoteFromStore,
} from "../../stores/noteStore";
import {
  useMeetingRecordingStore,
  useIsMeetingMode,
  useIsNarrowWindow,
  startRecording as storeStartRecording,
  stopRecording as storeStopRecording,
  togglePauseRecording,
  lockSpeaker,
  setSessionDiarizationEnabled,
  setSessionExpectedCount,
} from "../../stores/meetingRecordingStore";
import { useNotesOnboarding } from "../../hooks/useNotesOnboarding";
import { usePolicySnapshot, useTranscriptionContextAllowed } from "../../hooks/usePolicy";
import NotesOnboarding from "./NotesOnboarding";
import { notesEmptyTitleKey } from "./shared";
import { isRegenerableNoteTitle } from "../../helpers/regenerableNoteTitle";
import { handleMeetingRecordingRequest } from "../../helpers/meetingRecordingRequest";
import {
  applyNoteDraftMutation,
  collectPendingNoteWrites,
  planNoteTransition,
  shouldCancelPendingSavesForDelete,
  type NoteEditorDraft,
  type PendingDocumentSnapshot,
  type PendingEnhancedSnapshot,
  type PendingNoteWrite,
} from "../../lib/noteEditorPendingSave";
import { insertEncounterTemplate } from "../../lib/encounterTemplateInsertion";

function makeContentHash(content: string): string {
  return String(content.length) + "-" + content.slice(0, 50);
}

const MEETING_CONTEXT_STORAGE_KEY = "openwhispr.lastMeetingContext";

function readLastMeetingContext(): MeetingContext {
  try {
    return normalizeMeetingContext(window.localStorage.getItem(MEETING_CONTEXT_STORAGE_KEY));
  } catch {
    return "telehealth";
  }
}

function draftFromNote(note: NoteItem): NoteEditorDraft {
  return {
    noteId: note.id,
    title: note.title,
    content: note.content,
    enhancedContent: note.enhanced_content ?? null,
  };
}

interface PendingDocumentSave extends PendingDocumentSnapshot {
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingEnhancedSave extends PendingEnhancedSnapshot {
  readonly timer: ReturnType<typeof setTimeout>;
}

type PendingSaveReason =
  | "switch"
  | "overview"
  | "unmount"
  | "manual"
  | "export"
  | "complete"
  | "autosave";

interface PersonalNotesViewProps {
  onOpenSettings?: (section: string) => void;
  onOpenSearch?: () => void;
  meetingRecordingRequest?: {
    noteId: number;
    folderId: number;
    event: any;
  } | null;
  onMeetingRecordingRequestHandled?: () => void;
}

export default function PersonalNotesView({
  onOpenSettings,
  onOpenSearch,
  meetingRecordingRequest,
  onMeetingRecordingRequestHandled,
}: PersonalNotesViewProps) {
  const isMeetingMode = useIsMeetingMode();
  const isNarrowWindow = useIsNarrowWindow();
  const { t } = useTranslation();
  const notes = useNotes();
  const activeNoteId = useActiveNoteId();
  const isSidePanelLayout = isMeetingMode || (isNarrowWindow && activeNoteId != null);
  const activeFolderId = useActiveFolderId();
  const [isSaving, setIsSaving] = useState(false);
  const [isExplicitSaveInProgress, setIsExplicitSaveInProgress] = useState(false);
  const [isInsertingEncounterTemplate, setIsInsertingEncounterTemplate] = useState(false);
  const [draft, setDraftState] = useState<NoteEditorDraft | null>(null);
  const draftRef = useRef<NoteEditorDraft | null>(null);
  const [showActionManager, setShowActionManager] = useState(false);
  const [showAddNotesDialog, setShowAddNotesDialog] = useState(false);
  const [showClinicalExport, setShowClinicalExport] = useState(false);
  const pendingDocumentRef = useRef<PendingDocumentSave | null>(null);
  const pendingEnhancedRef = useRef<PendingEnhancedSave | null>(null);
  const inFlightSavePromisesRef = useRef<Set<Promise<boolean>>>(new Set());

  const trackSavePromise = useCallback((promise: Promise<boolean>): Promise<boolean> => {
    inFlightSavePromisesRef.current.add(promise);
    setIsSaving(true);
    void promise.then(
      () => {
        inFlightSavePromisesRef.current.delete(promise);
        if (inFlightSavePromisesRef.current.size === 0) setIsSaving(false);
      },
      () => {
        inFlightSavePromisesRef.current.delete(promise);
        if (inFlightSavePromisesRef.current.size === 0) setIsSaving(false);
      }
    );
    return promise;
  }, []);

  const commitDraft = useCallback((next: NoteEditorDraft | null) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);

  // Conflict-banner Refresh applies an external cloud copy: a queued
  // debounced save would clobber it with the pre-refresh buffer, so the
  // editor cancels pending saves for that note before the copy is applied.
  const cancelPendingSaves = useCallback((noteId: number) => {
    const document = pendingDocumentRef.current;
    if (document?.noteId === noteId) {
      clearTimeout(document.timer);
      pendingDocumentRef.current = null;
    }
    const enhanced = pendingEnhancedRef.current;
    if (enhanced?.noteId === noteId) {
      clearTimeout(enhanced.timer);
      pendingEnhancedRef.current = null;
    }
  }, []);

  const takePendingSnapshots = useCallback((): {
    document: PendingDocumentSnapshot | null;
    enhanced: PendingEnhancedSnapshot | null;
  } => {
    const document = pendingDocumentRef.current;
    const enhanced = pendingEnhancedRef.current;

    if (document) clearTimeout(document.timer);
    if (enhanced) clearTimeout(enhanced.timer);
    pendingDocumentRef.current = null;
    pendingEnhancedRef.current = null;

    return { document, enhanced };
  }, []);

  const persistPendingWrites = useCallback(
    async (writes: PendingNoteWrite[], reason: PendingSaveReason): Promise<boolean> => {
      if (writes.length === 0) return true;
      const savePromise = Promise.all(
        writes.map(async (write) => {
          try {
            const result = await window.electronAPI.updateNote(write.noteId, write.updates);
            if (result?.success === false) throw new Error("Note update was rejected");
            return true;
          } catch (err) {
            logger.warn(
              `Failed to flush note before ${reason}`,
              { error: (err as Error).message },
              "notes"
            );
            return false;
          }
        })
      ).then((results) => results.every(Boolean));
      return trackSavePromise(savePromise);
    },
    [trackSavePromise]
  );

  const flushPendingSaves = useCallback(
    async (reason: PendingSaveReason): Promise<boolean> => {
      const pending = takePendingSnapshots();
      const pendingResult = await persistPendingWrites(
        collectPendingNoteWrites(pending.document, pending.enhanced),
        reason
      );
      let inFlightResult = true;
      // A debounce timer can have already handed a write to IPC by the time
      // Save, export, or completion is requested. Wait for that write too so
      // the next action never reads an older database snapshot.
      while (inFlightSavePromisesRef.current.size > 0) {
        const saves = [...inFlightSavePromisesRef.current];
        const results = await Promise.all(saves);
        inFlightResult = results.every(Boolean) && inFlightResult;
      }
      return pendingResult && inFlightResult;
    },
    [persistPendingWrites, takePendingSnapshots]
  );

  const transitionToNote = useCallback(
    (nextNote: NoteItem | null, reason: Extract<PendingSaveReason, "switch" | "overview">) => {
      const pending = takePendingSnapshots();
      const transition = planNoteTransition(nextNote, pending.document, pending.enhanced);
      void persistPendingWrites(transition.writes, reason);
      commitDraft(transition.nextDraft);
    },
    [commitDraft, persistPendingWrites, takePendingSnapshots]
  );
  const { toast } = useToast();
  const policyState = usePolicySnapshot();
  const noteFormatting = useSettingsStore(
    useShallow((settings) => {
      const effectiveSettings = selectPolicyEffectiveSettings(settings, policyState);
      return {
        isCloudMode: selectIsCloudNoteFormattingMode(effectiveSettings),
        modelId: selectResolvedNoteFormatting(effectiveSettings).model,
      };
    })
  );
  const isCloudMode = noteFormatting.isCloudMode;
  const effectiveModelId = noteFormatting.modelId;
  const { isComplete: isOnboardingComplete, complete: completeOnboarding } = useNotesOnboarding();

  const isTranscribing = useMeetingRecordingStore((s) => s.isRecording);
  const isPaused = useMeetingRecordingStore((s) => s.isPaused);
  const transcriptStatus = useMeetingRecordingStore((s) => s.transcriptStatus);
  const diarizationSessionId = useMeetingRecordingStore((s) => s.diarizationSessionId);
  const diarizationStatus = useMeetingRecordingStore((s) => s.diarizationStatus);
  const recordingNoteId = useMeetingRecordingStore((s) => s.recordingNoteId);
  const sessionDiarizationEnabled = useMeetingRecordingStore((s) => s.sessionDiarizationEnabled);
  const sessionExpectedCount = useMeetingRecordingStore((s) => s.sessionExpectedCount);
  const userTouchedStepper = useMeetingRecordingStore((s) => s.userTouchedStepper);
  const meetingRecordingAllowed = useTranscriptionContextAllowed("meeting");
  const [meetingContext, setMeetingContext] = useState<MeetingContext>(readLastMeetingContext);
  const [activeEncounter, setActiveEncounter] = useState<LocalEncounter | null>(null);

  const spaces = useSpaces();
  const folders = useFolders();
  const activeContext = useActiveContext();
  const overviewSpace = useMemo(
    () => (activeContext ? (spaces.find((s) => s.id === activeContext.spaceId) ?? null) : null),
    [activeContext, spaces]
  );
  const overviewFolder = useMemo(
    () =>
      activeContext?.folderId != null
        ? (folders.find((f) => f.id === activeContext.folderId) ?? null)
        : null,
    [activeContext, folders]
  );

  useEffect(() => {
    initializeNotesTree();
  }, []);

  const activeNote = useActiveNote();

  useEffect(() => {
    let cancelled = false;
    setActiveEncounter(null);
    if (!activeNote?.id || !window.electronAPI?.getEncounterByNote) return undefined;
    void window.electronAPI
      .getEncounterByNote(activeNote.id)
      .then((result) => {
        if (!cancelled) setActiveEncounter(result.success ? result.encounter : null);
      })
      .catch(() => {
        if (!cancelled) setActiveEncounter(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeNote?.id]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onEncounterCompleted?.((payload) => {
      if (
        payload?.encounterId != null &&
        activeEncounter?.id === Number(payload.encounterId)
      ) {
        setActiveEncounter((current) =>
          current ? { ...current, lifecycle_state: "completed" } : current
        );
      }
    });
    return () => unsubscribe?.();
  }, [activeEncounter?.id]);

  useEffect(() => {
    const nextContext = activeNote?.meeting_context
      ? normalizeMeetingContext(activeNote.meeting_context)
      : activeNote
        ? "telehealth"
        : readLastMeetingContext();
    setMeetingContext(nextContext);
  }, [activeNote, activeNote?.id, activeNote?.meeting_context]);

  const handleMeetingContextChange = useCallback(
    (nextContext: MeetingContext) => {
      setMeetingContext(nextContext);
      try {
        window.localStorage.setItem(MEETING_CONTEXT_STORAGE_KEY, nextContext);
      } catch {}
      if (activeNote?.id == null) return;
      void window.electronAPI
        .updateNote(activeNote.id, { meeting_context: nextContext })
        .catch((error: unknown) => {
          logger.warn(
            "Failed to persist meeting context",
            { error: (error as Error).message },
            "meeting"
          );
        });
    },
    [activeNote?.id]
  );

  const [calendarEventName, setCalendarEventName] = useState<string | null>(null);
  useEffect(() => {
    if (!activeNote?.calendar_event_id) {
      setCalendarEventName(null);
      return;
    }
    window.electronAPI.gcalGetEvent?.(activeNote.calendar_event_id).then((result) => {
      setCalendarEventName(result?.success && result.event?.summary ? result.event.summary : null);
    });
  }, [activeNote?.calendar_event_id]);

  const startRecording = useCallback(async () => {
    const note = activeNote ?? null;
    const noteId = note?.id ?? null;
    const seedSegments = note?.transcript ? parseTranscriptSegments(note.transcript) : [];
    if (noteId != null) {
      try {
        await window.electronAPI.updateNote(noteId, { meeting_context: meetingContext });
      } catch (error) {
        logger.warn(
          "Failed to persist meeting context before recording",
          { error: (error as Error).message },
          "meeting"
        );
      }
    }
    await storeStartRecording({
      noteId,
      noteTitle: note?.title ?? null,
      folderId: note?.folder_id ?? null,
      seedSegments,
      diarizationEnabled: note?.diarization_enabled == null ? null : note.diarization_enabled === 1,
      expectedCount: resolveExpectedSpeakerCount(note),
      expectedCountIsExplicit: isExplicitSpeakerCount(note?.expected_speaker_count),
      meetingContext,
    });
  }, [activeNote, meetingContext]);

  const stopRecording = useCallback(async () => {
    await storeStopRecording();
  }, []);

  useEffect(() => {
    const currentDraft = draftRef.current;

    if (!activeNote) {
      // Space/folder activation shows its overview by clearing activeNoteId.
      if (currentDraft || pendingDocumentRef.current || pendingEnhancedRef.current) {
        transitionToNote(null, "overview");
      }
      return;
    }

    if (!currentDraft || activeNote.id !== currentDraft.noteId) {
      // Captured writes retain the old owner while the complete next draft is
      // installed atomically.
      transitionToNote(activeNote, "switch");
      return;
    }

    const hasPendingLocalSave =
      pendingDocumentRef.current?.noteId === activeNote.id ||
      pendingEnhancedRef.current?.noteId === activeNote.id;
    if (!hasPendingLocalSave) {
      // External update (e.g. AI chat tool) — replace the complete draft only
      // when it has no local save pending.
      commitDraft(draftFromNote(activeNote));
    }
  }, [activeNote, commitDraft, transitionToNote]);

  const scheduleDocumentSave = useCallback((snapshot: NoteEditorDraft) => {
    const current = pendingDocumentRef.current;
    if (current) clearTimeout(current.timer);

    const pending: PendingDocumentSave = {
      noteId: snapshot.noteId,
      title: snapshot.title,
      content: snapshot.content,
      timer: setTimeout(() => {
        if (pendingDocumentRef.current !== pending) return;
        pendingDocumentRef.current = null;
        void persistPendingWrites(
          [
            {
              noteId: pending.noteId,
              updates: {
                title: pending.title,
                content: pending.content,
              },
            },
          ],
          "autosave"
        );
      }, 1000),
    };
    pendingDocumentRef.current = pending;
  }, [persistPendingWrites]);

  const scheduleEnhancedSave = useCallback((snapshot: NoteEditorDraft) => {
    const current = pendingEnhancedRef.current;
    if (current) clearTimeout(current.timer);

    const pending: PendingEnhancedSave = {
      noteId: snapshot.noteId,
      enhancedContent: snapshot.enhancedContent,
      timer: setTimeout(() => {
        if (pendingEnhancedRef.current !== pending) return;
        pendingEnhancedRef.current = null;
        void persistPendingWrites(
          [
            {
              noteId: pending.noteId,
              updates: { enhanced_content: pending.enhancedContent },
            },
          ],
          "autosave"
        );
      }, 1000),
    };
    pendingEnhancedRef.current = pending;
  }, [persistPendingWrites]);

  const handleTitleChange = useCallback(
    (sourceNoteId: number, title: string) => {
      const next = applyNoteDraftMutation(draftRef.current, {
        sourceNoteId,
        field: "title",
        value: title,
      });
      if (!next) return;
      commitDraft(next);
      scheduleDocumentSave(next);
    },
    [commitDraft, scheduleDocumentSave]
  );

  const handleContentChange = useCallback(
    (sourceNoteId: number, content: string) => {
      const next = applyNoteDraftMutation(draftRef.current, {
        sourceNoteId,
        field: "content",
        value: content,
      });
      if (!next) return;
      commitDraft(next);
      scheduleDocumentSave(next);
    },
    [commitDraft, scheduleDocumentSave]
  );

  const handleInsertEncounterTemplate = useCallback(async () => {
    if (
      !activeNote ||
      activeNote.id !== activeNoteId ||
      activeNote.note_type !== "meeting" ||
      !activeNote.calendar_event_id
    ) {
      return;
    }

    setIsInsertingEncounterTemplate(true);
    try {
      const template = await resolveEncounterTemplate(getSettings());
      const currentDraft = draftRef.current;
      if (!currentDraft || currentDraft.noteId !== activeNote.id) return;

      const nextContent = insertEncounterTemplate(currentDraft.content, template.templateText);
      handleContentChange(activeNote.id, nextContent);
    } catch (error) {
      toast({
        title: t("notes.editor.templateInsert.failed"),
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setIsInsertingEncounterTemplate(false);
    }
  }, [activeNote, activeNoteId, handleContentChange, t, toast]);

  const handleEnhancedContentChange = useCallback(
    (sourceNoteId: number, content: string) => {
      const next = applyNoteDraftMutation(draftRef.current, {
        sourceNoteId,
        field: "enhancedContent",
        value: content,
      });
      if (!next) return;
      commitDraft(next);
      scheduleEnhancedSave(next);
    },
    [commitDraft, scheduleEnhancedSave]
  );

  useEffect(() => {
    return () => {
      void flushPendingSaves("unmount");
    };
  }, [flushPendingSaves]);

  const handleNewNoteIn = useCallback(
    async (spaceId: number, folderId: number | null) => {
      const result = await window.electronAPI.saveNote(
        t("notes.list.untitledNote"),
        "",
        "personal",
        null,
        null,
        folderId,
        spaceId
      );
      if (result.success && result.note) {
        setActiveContext(result.note.space_id, result.note.folder_id);
        revealContainer(result.note.space_id, result.note.folder_id);
        setActiveNoteId(result.note.id);
      }
    },
    [t]
  );

  const privateSpaceId = useMemo(
    () => spaces.find((s) => s.kind === "private")?.id ?? null,
    [spaces]
  );

  const handleNewNoteInPrivate = useCallback(() => {
    if (privateSpaceId == null) return;
    handleNewNoteIn(privateSpaceId, null);
  }, [privateSpaceId, handleNewNoteIn]);

  const handleNewNote = useCallback(() => {
    if (activeContext) handleNewNoteIn(activeContext.spaceId, activeContext.folderId);
    else handleNewNoteInPrivate();
  }, [activeContext, handleNewNoteIn, handleNewNoteInPrivate]);

  const handleNotesAdded = useCallback(async () => {
    if (activeFolderId) {
      await initializeNotes(null, 50, activeFolderId);
    }
    loadFolders();
  }, [activeFolderId]);

  const handleDelete = useCallback(
    async (id: number) => {
      if (shouldCancelPendingSavesForDelete(draftRef.current?.noteId ?? null, id)) {
        cancelPendingSaves(id);
      }
      await window.electronAPI.deleteNote(id);
    },
    [cancelPendingSaves]
  );

  const handleMoveNote = useCallback(
    async (noteId: number, target: NoteMoveTarget) => {
      await window.electronAPI.updateNote(noteId, {
        folder_id: target.folderId,
        space_id: target.spaceId,
      });
      if (noteId === activeNoteId) {
        setActiveContext(target.spaceId, target.folderId);
        revealContainer(target.spaceId, target.folderId);
      }
    },
    [activeNoteId]
  );

  const handleMoveToFolder = useCallback(
    async (noteId: number, folderId: number) => {
      const folder = folders.find((f) => f.id === folderId);
      if (!folder) return;
      await handleMoveNote(noteId, { spaceId: folder.space_id, folderId });
    },
    [folders, handleMoveNote]
  );

  const handleCreateFolderAndMove = useCallback(
    async (noteId: number, folderName: string) => {
      const spaceId = getNoteFromStore(noteId)?.space_id ?? privateSpaceId;
      if (spaceId == null) return;
      const result = await createFolder(folderName, spaceId);
      if (result.success && result.folder) {
        await handleMoveToFolder(noteId, result.folder.id);
      } else if (result.error) {
        toast({
          title: t("notes.folders.couldNotCreate"),
          description: result.error,
          variant: "destructive",
        });
      }
    },
    [privateSpaceId, handleMoveToFolder, toast, t]
  );

  const {
    state: actionProcessingState,
    actionName,
    isBuiltInAction,
    errorMessage: actionErrorMessage,
    progress: actionProgress,
    startedAt: actionStartedAt,
    cancel: cancelAction,
    runAction,
    candidate,
    candidateBusy,
    candidateError,
    applyCandidate,
    discardCandidate,
  } = useActionProcessing(activeNoteId ?? null);

  // Boolean flag so actions enable during recording without re-rendering on every transcript update.
  const hasLiveTranscript = useMeetingRecordingStore(
    (s) => s.recordingNoteId === activeNote?.id && !!s.transcript
  );
  const activeNoteRawTranscript = activeNote?.transcript || "";
  const activeDraft = draft?.noteId === activeNote?.id ? draft : null;
  const editorNote = activeNote
    ? {
        ...activeNote,
        title: activeDraft ? activeDraft.title : activeNote.title,
        content: activeDraft ? activeDraft.content : activeNote.content,
        enhanced_content: activeDraft
          ? activeDraft.enhancedContent
          : (activeNote.enhanced_content ?? null),
      }
    : null;
  const editorEnhancedContent = editorNote?.enhanced_content ?? null;
  const [persistedGenerationSourceHash, setPersistedGenerationSourceHash] = useState<string | null>(null);

  useEffect(() => {
    if (!activeNote?.id || !window.electronAPI.getNoteGenerationSource) {
      setPersistedGenerationSourceHash(null);
      return;
    }
    let active = true;
    void window.electronAPI.getNoteGenerationSource(activeNote.id).then((source) => {
      if (active) setPersistedGenerationSourceHash(source.success ? source.sourceHash ?? null : null);
    }).catch(() => {
      if (active) setPersistedGenerationSourceHash(null);
    });
    return () => {
      active = false;
    };
  }, [
    activeNote?.id,
    activeNote?.generation_source_revision,
    activeNote?.transcript_revision,
    activeNote?.updated_at,
  ]);

  const isEnhancementStale = useMemo(() => {
    if (!editorEnhancedContent || !activeNote?.enhanced_at_content_hash) return false;
    // Custom actions retain their historical weak hash contract. Comparing it
    // to SHA-256 would mark every custom-action result stale immediately.
    if (/^\d+-/.test(activeNote.enhanced_at_content_hash)) {
      return makeContentHash(`${activeNote.content ?? ""}\n${activeNote.transcript ?? ""}`) !==
        activeNote.enhanced_at_content_hash;
    }
    if (!persistedGenerationSourceHash) return false;
    return persistedGenerationSourceHash !== activeNote.enhanced_at_content_hash;
  }, [
    activeNote?.enhanced_at_content_hash,
    activeNote?.content,
    activeNote?.transcript,
    editorEnhancedContent,
    persistedGenerationSourceHash,
  ]);

  const handleExportNote = useCallback(
    async (format: "md" | "txt") => {
      if (!activeNoteId) return;
      await window.electronAPI.exportNote(activeNoteId, format);
    },
    [activeNoteId]
  );

  const handleExportTranscript = useCallback(
    async (format: "txt" | "srt" | "json" | "md") => {
      if (!activeNoteId) return;
      await window.electronAPI.exportTranscript(activeNoteId, format);
    },
    [activeNoteId]
  );

  const flushDraftForAction = useCallback(
    async (reason: Extract<PendingSaveReason, "manual" | "export" | "complete">) => {
      setIsExplicitSaveInProgress(true);
      try {
        return await flushPendingSaves(reason);
      } finally {
        setIsExplicitSaveInProgress(false);
      }
    },
    [flushPendingSaves]
  );

  const handleSave = useCallback(async (): Promise<boolean> => {
    const success = await flushDraftForAction("manual");
    if (!success) {
      toast({
        title: t("common.error"),
        description: t("notes.editor.encounterCompletion.unavailable"),
        variant: "destructive",
      });
    }
    return success;
  }, [flushDraftForAction, t, toast]);

  const handleExportClinicalNote = useCallback(async () => {
    const success = await flushDraftForAction("export");
    if (!success) {
      toast({
        title: t("common.error"),
        description: t("notes.editor.encounterCompletion.unavailable"),
        variant: "destructive",
      });
      return;
    }
    setShowClinicalExport(true);
  }, [flushDraftForAction, t, toast]);

  const handleBeforeEncounterComplete = useCallback(
    () => flushDraftForAction("complete"),
    [flushDraftForAction]
  );

  useEffect(() => {
    if (!meetingRecordingRequest || activeNoteId !== meetingRecordingRequest.noteId) return;
    const note = activeNote?.id === meetingRecordingRequest.noteId ? activeNote : null;
    const seedSegments = note?.transcript ? parseTranscriptSegments(note.transcript) : [];
    const context = normalizeMeetingContext(note?.meeting_context);
    void (async () => {
      if (note?.id != null) {
        try {
          await window.electronAPI.updateNote(note.id, { meeting_context: context });
        } catch (error) {
          logger.warn(
            "Failed to persist automatic meeting context",
            { error: (error as Error).message },
            "meeting"
          );
        }
      }
      await handleMeetingRecordingRequest({
        args: {
          noteId: meetingRecordingRequest.noteId,
          noteTitle: note?.title ?? null,
          folderId: note?.folder_id ?? meetingRecordingRequest.folderId ?? null,
          seedSegments,
          diarizationEnabled:
            note?.diarization_enabled == null ? null : note.diarization_enabled === 1,
          expectedCount: resolveExpectedSpeakerCount(note),
          expectedCountIsExplicit: isExplicitSpeakerCount(note?.expected_speaker_count),
          meetingContext: context,
        },
        startRecording: storeStartRecording,
        restoreFromMeetingMode: async () => {
          await window.electronAPI?.restoreFromMeetingMode?.();
        },
        onHandled: () => onMeetingRecordingRequestHandled?.(),
      });
    })().catch((error) => {
      logger.warn(
        "Failed to handle automatic meeting recording request",
        { error: (error as Error).message },
        "meeting"
      );
    });
  }, [meetingRecordingRequest, activeNoteId, activeNote, onMeetingRecordingRequestHandled]);

  const isActiveNoteRecording = isTranscribing && recordingNoteId === activeNote?.id;
  const isActiveTranscriptSession = recordingNoteId === activeNote?.id;
  const activeTranscriptStatus = isActiveTranscriptSession ? transcriptStatus : "idle";
  const activeDiarizationStatus = isActiveTranscriptSession ? diarizationStatus : "idle";
  const isActiveTranscriptProcessing =
    isActiveTranscriptSession &&
    (transcriptStatus === "finalizing" || transcriptStatus === "saving");

  if (!isOnboardingComplete) {
    return (
      <>
        <NotesOnboarding onComplete={completeOnboarding} />
      </>
    );
  }

  return (
    <div className="flex h-full">
      <div
        className="shrink-0 overflow-hidden transition-[width] duration-300 ease-out"
        style={{ width: isSidePanelLayout ? 0 : "13rem" }}
      >
        <div className="w-52 shrink-0 border-r border-border/15 dark:border-white/4 flex flex-col h-full">
          <div className="px-2 pt-2 pb-1 shrink-0 space-y-0.5">
            <button
              onClick={handleNewNoteInPrivate}
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs",
                "text-muted-foreground/80 hover:text-foreground hover:bg-foreground/5",
                "transition-colors duration-150",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
              )}
            >
              <SquarePen size={14} className="shrink-0" />
              {t("notes.sidebar.newNote")}
            </button>
            {onOpenSearch && (
              <button
                onClick={onOpenSearch}
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs",
                  "text-muted-foreground/80 hover:text-foreground hover:bg-foreground/5",
                  "transition-colors duration-150",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
                )}
              >
                <Search size={14} className="shrink-0" />
                {t("notes.sidebar.searchNotes")}
              </button>
            )}
            <button
              onClick={() => setShowActionManager(true)}
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs",
                "text-muted-foreground/80 hover:text-foreground hover:bg-foreground/5",
                "transition-colors duration-150",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
              )}
            >
              <Sparkles size={14} className="shrink-0" />
              {t("notes.sidebar.actions")}
            </button>
          </div>

          <SpacesTree
            onDeleteNote={handleDelete}
            onMoveNote={handleMoveNote}
            onCreateFolderAndMove={handleCreateFolderAndMove}
            onNewNote={handleNewNoteIn}
          />
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {editorNote ? (
          <>
            <NoteEditor
              key={editorNote.id}
              note={editorNote}
              onTitleChange={handleTitleChange}
              onContentChange={handleContentChange}
              isSaving={isSaving || isExplicitSaveInProgress}
              isRecording={isActiveNoteRecording}
              isPaused={isPaused && isActiveNoteRecording}
              isProcessing={isActiveTranscriptProcessing}
              transcriptStatus={activeTranscriptStatus}
              isEncounterCompleted={activeEncounter?.lifecycle_state === "completed"}
              recordingAllowed={meetingRecordingAllowed}
              onStartRecording={startRecording}
              onStopRecording={stopRecording}
              onTogglePauseRecording={togglePauseRecording}
              onExportNote={handleExportNote}
              onExportTranscript={handleExportTranscript}
              onSave={handleSave}
              onInsertEncounterTemplate={handleInsertEncounterTemplate}
              isInsertingEncounterTemplate={isInsertingEncounterTemplate}
              onExportClinicalNote={handleExportClinicalNote}
              encounterCompletion={
                editorNote.note_type === "meeting" && editorNote.calendar_event_id && activeEncounter ? (
                  <EncounterCompletionPrompt
                    noteId={editorNote.id}
                    isRecording={isActiveNoteRecording}
                    isProcessing={isActiveTranscriptProcessing}
                    isCompleted={activeEncounter.lifecycle_state === "completed"}
                    templateReady={Boolean(
                      editorNote.enhanced_content?.trim() &&
                        editorNote.enhanced_template_revision_id != null
                    )}
                    onBeforeComplete={handleBeforeEncounterComplete}
                    onCompleted={(encounter) => setActiveEncounter(encounter)}
                  />
                ) : null
              }
              enhancement={
                editorEnhancedContent
                  ? {
                      content: editorEnhancedContent,
                      isStale: isEnhancementStale,
                      onChange: handleEnhancedContentChange,
                    }
                  : undefined
              }
              diarizationSessionId={diarizationSessionId}
              diarizationStatus={activeDiarizationStatus}
              meetingContext={meetingContext}
              onMeetingContextChange={handleMeetingContextChange}
              onLiveSpeakerLock={lockSpeaker}
              sessionDiarizationEnabled={sessionDiarizationEnabled}
              sessionExpectedCount={sessionExpectedCount}
              userTouchedStepper={userTouchedStepper}
              onSetSessionDiarizationEnabled={setSessionDiarizationEnabled}
              onSetSessionExpectedCount={setSessionExpectedCount}
              onCancelPendingSaves={cancelPendingSaves}
              actionProcessingState={actionProcessingState}
              actionName={actionName}
              actionIsBuiltIn={isBuiltInAction}
              actionErrorMessage={actionErrorMessage}
              actionProgress={actionProgress}
              actionStartedAt={actionStartedAt}
              onCancelAction={cancelAction}
              actionPicker={
                <ActionPicker
                  onRunAction={async (action) => {
                    if (!editorNote) return;
                    const builtInGenerateNotes = isBuiltInGenerateNotesAction(action);
                    let sourceHash = makeContentHash(`${editorNote.content}\n${activeNoteRawTranscript}`);
                    let sourceRevision = activeNote?.transcript_revision;
                    let persistedMeetingContext = activeNote?.meeting_context;
                    let rawTranscript = activeNoteRawTranscript;
                    let noteContent = editorNote.content;
                    let canonicalBuiltInSource: string | null = null;

                    if (builtInGenerateNotes) {
                      const noteId = editorNote.id;
                      const flushed = await flushDraftForAction("manual");
                      if (!flushed) {
                        toast({
                          title: t("common.error"),
                          description: t("notes.editor.encounterCompletion.unavailable"),
                          variant: "destructive",
                        });
                        return;
                      }
                      const sourceApi = window.electronAPI.getNoteGenerationSource;
                      if (typeof sourceApi !== "function") {
                        toast({
                          title: t("common.error"),
                          description: "The saved note could not be read. Try again.",
                          variant: "destructive",
                        });
                        return;
                      }
                      let source: Awaited<ReturnType<typeof sourceApi>>;
                      try {
                        source = await sourceApi(noteId);
                      } catch {
                        toast({
                          title: t("common.error"),
                          description: "The saved note could not be read. Try again.",
                          variant: "destructive",
                        });
                        return;
                      }
                      if (
                        !source?.success ||
                        !source.sourceHash
                      ) {
                        toast({
                          title: t("common.error"),
                          description: "The saved note could not be read. Try again.",
                          variant: "destructive",
                        });
                        return;
                      }
                      sourceHash = source.sourceHash;
                      sourceRevision = source.sourceRevision;
                      noteContent = source.content ?? "";
                      rawTranscript = source.transcript ?? "";
                      canonicalBuiltInSource = source.sourceText?.trim() || null;
                      persistedMeetingContext = source.meetingContext ?? persistedMeetingContext;
                    } else {
                      const {
                        recordingNoteId: liveNoteId,
                        transcript: liveTranscript,
                        meetingContext: liveMeetingContextForAction,
                      } = useMeetingRecordingStore.getState();
                      rawTranscript =
                        (liveNoteId === activeNote?.id ? liveTranscript : "") ||
                        activeNoteRawTranscript;
                      persistedMeetingContext =
                        liveNoteId === activeNote?.id
                          ? liveMeetingContextForAction
                          : activeNote?.meeting_context;
                    }
                    const hasNotes = !!noteContent.trim();
                    if (!hasNotes && !rawTranscript) return;

                    let formattedTranscript = "";
                    let isMeetingNote = editorNote.note_type === "meeting";
                    if (rawTranscript && !canonicalBuiltInSource) {
                      const segments = parseTranscriptSegments(rawTranscript);
                      if (segments.length > 0) {
                        isMeetingNote = true;
                        formattedTranscript = segments
                          .map(
                            (s) =>
                              `${
                                s.source === "mic" &&
                                normalizeMeetingContext(persistedMeetingContext) ===
                                  "telehealth"
                                  ? t("notes.speaker.you")
                                  : s.source === "system"
                                    ? t("notes.speaker.them")
                                    : t("notes.speaker.unassigned")
                              }: ${s.text}`
                          )
                          .join("\n");
                      }
                      if (!formattedTranscript) {
                        formattedTranscript = rawTranscript;
                      }
                    }

                    const parts = canonicalBuiltInSource
                      ? canonicalBuiltInSource
                      : [
                          hasNotes ? noteContent : "",
                          formattedTranscript ? `## Meeting Transcript\n${formattedTranscript}` : "",
                        ]
                          .filter(Boolean)
                          .join("\n\n");
                    runAction(action, parts, sourceHash, {
                      isCloudMode,
                      modelId: effectiveModelId,
                      isMeetingNote,
                      sourceRevision,
                      noteType: editorNote.note_type,
                      calendarEventId: editorNote.calendar_event_id,
                      allowTitleGeneration: isRegenerableNoteTitle(
                        editorNote.title,
                        [
                          t("notes.list.untitledNote"),
                          t("notes.list.newNote"),
                          t("notes.sidebar.newNote"),
                        ],
                        calendarEventName
                      ),
                    });
                  }}
                  onManageActions={() => setShowActionManager(true)}
                  disabled={
                    (!editorNote?.content?.trim() &&
                      !hasLiveTranscript &&
                      !activeNoteRawTranscript) ||
                    actionProcessingState === "processing" ||
                    actionProcessingState === "retrying"
                  }
                />
              }
            />
            {activeNote && candidate && (
              <NoteGenerationCandidateReview
                candidate={candidate}
                busy={candidateBusy}
                error={candidateError}
                hasExistingEnhancedContent={Boolean(activeNote.enhanced_content?.trim())}
                onApply={applyCandidate}
                onDiscard={discardCandidate}
              />
            )}
            {activeNoteId &&
              activeNote?.note_type === "meeting" &&
              activeNote?.calendar_event_id && (
                <ClinicalNoteExportDialog
                  noteId={activeNoteId}
                  open={showClinicalExport}
                  onOpenChange={setShowClinicalExport}
                />
              )}
            <ActionManagerDialog open={showActionManager} onOpenChange={setShowActionManager} />
          </>
        ) : activeContext && overviewSpace ? (
          <ContainerOverview
            key={
              activeContext.folderId != null
                ? `f:${activeContext.folderId}`
                : `s:${activeContext.spaceId}`
            }
            space={overviewSpace}
            folder={overviewFolder}
            onOpenNote={setActiveNoteId}
            onNewNote={handleNewNote}
            onAddExisting={activeFolderId != null ? () => setShowAddNotesDialog(true) : undefined}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center -mt-6">
            <svg
              className="text-foreground dark:text-white mb-5"
              width="72"
              height="64"
              viewBox="0 0 72 64"
              fill="none"
            >
              <rect
                x="22"
                y="2"
                width="32"
                height="42"
                rx="3"
                transform="rotate(6 38 23)"
                fill="currentColor"
                fillOpacity={0.025}
                stroke="currentColor"
                strokeOpacity={0.06}
              />
              <rect
                x="18"
                y="5"
                width="32"
                height="42"
                rx="3"
                transform="rotate(3 34 26)"
                fill="currentColor"
                fillOpacity={0.04}
                stroke="currentColor"
                strokeOpacity={0.08}
              />
              <rect
                x="14"
                y="8"
                width="32"
                height="42"
                rx="3"
                fill="currentColor"
                fillOpacity={0.05}
                stroke="currentColor"
                strokeOpacity={0.1}
              />
              <rect
                x="20"
                y="16"
                width="16"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.08}
              />
              <rect
                x="20"
                y="21"
                width="20"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.06}
              />
              <rect
                x="20"
                y="26"
                width="12"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.05}
              />
              <rect
                x="20"
                y="31"
                width="18"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.04}
              />
              <circle
                cx="54"
                cy="50"
                r="5"
                fill="currentColor"
                fillOpacity={0.03}
                stroke="currentColor"
                strokeOpacity={0.06}
              />
              <path
                d="M51.5 50L53 51.5L56.5 48"
                stroke="currentColor"
                strokeOpacity={0.12}
                strokeWidth={1.2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {notes.length === 0 ? (
              <>
                <h3 className="text-xs font-semibold text-foreground/60 mb-1">
                  {t(notesEmptyTitleKey(activeFolderId != null))}
                </h3>
                <p className="text-xs text-foreground/50 dark:text-foreground/25 text-center max-w-55 mb-4">
                  {t("notes.empty.description")}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleNewNote}
                    className="flex items-center gap-1.5 px-4 h-7 rounded-md bg-primary/8 dark:bg-primary/10 border border-primary/12 dark:border-primary/15 text-xs font-medium text-primary/70 hover:bg-primary/12 hover:text-primary hover:border-primary/20 transition-colors"
                  >
                    <Plus size={11} />
                    {t("notes.empty.createNote")}
                  </button>
                  {/* AddNotesToFolderDialog only mounts for folder contexts —
                      space-root empty states offer just "Create note". */}
                  {activeFolderId != null && (
                    <button
                      onClick={() => setShowAddNotesDialog(true)}
                      className="flex items-center gap-1.5 px-4 h-7 rounded-md border border-foreground/8 dark:border-white/8 text-xs text-foreground/40 hover:text-foreground/60 hover:border-foreground/15 hover:bg-foreground/3 dark:hover:bg-white/3 transition-colors"
                    >
                      {t("notes.addToFolder.addExisting")}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <h3 className="text-xs font-semibold text-foreground/60 mb-1">
                  {t("notes.empty.selectTitle")}
                </h3>
                <p className="text-xs text-foreground/50 dark:text-foreground/25 text-center max-w-50">
                  {t("notes.empty.selectDescription")}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {activeFolderId && (
        <AddNotesToFolderDialog
          open={showAddNotesDialog}
          onOpenChange={setShowAddNotesDialog}
          targetFolderId={activeFolderId}
          onNotesAdded={handleNotesAdded}
        />
      )}
    </div>
  );
}
