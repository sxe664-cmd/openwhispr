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
import type { NoteMoveTarget } from "../../hooks/useNoteDragAndDrop";
import {
  normalizeMeetingContext,
  type LocalEncounter,
  type MeetingContext,
  type NoteItem,
} from "../../types/electron";
import {
  useSettingsStore,
  selectIsCloudNoteFormattingMode,
  selectPolicyEffectiveSettings,
  selectResolvedNoteFormatting,
} from "../../stores/settingsStore";
import { cn } from "../lib/utils";
import logger from "../../utils/logger";
import { parseTranscriptSegments } from "../../utils/parseTranscriptSegments";
import { serializeTranscriptSegments } from "../../utils/transcriptSpeakerState";
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
  setTranscriptPersistenceStatus,
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

type PendingSaveReason = "switch" | "overview" | "unmount";

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
  const [draft, setDraftState] = useState<NoteEditorDraft | null>(null);
  const draftRef = useRef<NoteEditorDraft | null>(null);
  const [showActionManager, setShowActionManager] = useState(false);
  const [showAddNotesDialog, setShowAddNotesDialog] = useState(false);
  const [showClinicalExport, setShowClinicalExport] = useState(false);
  const pendingDocumentRef = useRef<PendingDocumentSave | null>(null);
  const pendingEnhancedRef = useRef<PendingEnhancedSave | null>(null);

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
    (writes: PendingNoteWrite[], reason: PendingSaveReason) => {
      for (const write of writes) {
        void window.electronAPI.updateNote(write.noteId, write.updates).catch((err: unknown) => {
          logger.warn(
            `Failed to flush note before ${reason}`,
            { error: (err as Error).message },
            "notes"
          );
        });
      }
    },
    []
  );

  const flushPendingSaves = useCallback(
    (reason: PendingSaveReason) => {
      const pending = takePendingSnapshots();
      persistPendingWrites(collectPendingNoteWrites(pending.document, pending.enhanced), reason);
    },
    [persistPendingWrites, takePendingSnapshots]
  );

  const transitionToNote = useCallback(
    (nextNote: NoteItem | null, reason: Extract<PendingSaveReason, "switch" | "overview">) => {
      const pending = takePendingSnapshots();
      const transition = planNoteTransition(nextNote, pending.document, pending.enhanced);
      persistPendingWrites(transition.writes, reason);
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
  const transcriptStatus = useMeetingRecordingStore((s) => s.transcriptStatus);
  const diarizationSessionId = useMeetingRecordingStore((s) => s.diarizationSessionId);
  const diarizationStatus = useMeetingRecordingStore((s) => s.diarizationStatus);
  const recordingNoteId = useMeetingRecordingStore((s) => s.recordingNoteId);
  const sessionDiarizationEnabled = useMeetingRecordingStore((s) => s.sessionDiarizationEnabled);
  const sessionExpectedCount = useMeetingRecordingStore((s) => s.sessionExpectedCount);
  const userTouchedStepper = useMeetingRecordingStore((s) => s.userTouchedStepper);
  const meetingRecordingAllowed = useTranscriptionContextAllowed("meeting");
  const [meetingContext, setMeetingContext] = useState<MeetingContext>(readLastMeetingContext);
  const [isFinalizingTranscript, setIsFinalizingTranscript] = useState(false);
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

  // Derive folder name and calendar event name for the metadata chips
  const activeFolderName = useMemo(() => {
    if (!activeNote?.folder_id) return null;
    return folders.find((f) => f.id === activeNote.folder_id)?.name ?? null;
  }, [activeNote?.folder_id, folders]);

  // The editor's move-to-folder chip only offers folders in the note's own
  // space; cross-space moves change the audience and need an explicit confirm.
  const editorFolders = useMemo(
    () => (activeNote ? folders.filter((f) => f.space_id === activeNote.space_id) : folders),
    [activeNote, folders]
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
    setIsFinalizingTranscript(true);
    const result = await storeStopRecording();
    if (!result.diarizationSessionId) {
      setIsFinalizingTranscript(false);
    }
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
      timer: setTimeout(async () => {
        if (pendingDocumentRef.current !== pending) return;
        pendingDocumentRef.current = null;
        setIsSaving(true);
        try {
          await window.electronAPI.updateNote(pending.noteId, {
            title: pending.title,
            content: pending.content,
          });
        } catch (err) {
          logger.warn("Failed to save note", { error: (err as Error).message }, "notes");
        } finally {
          setIsSaving(false);
        }
      }, 1000),
    };
    pendingDocumentRef.current = pending;
  }, []);

  const scheduleEnhancedSave = useCallback((snapshot: NoteEditorDraft) => {
    const current = pendingEnhancedRef.current;
    if (current) clearTimeout(current.timer);

    const pending: PendingEnhancedSave = {
      noteId: snapshot.noteId,
      enhancedContent: snapshot.enhancedContent,
      timer: setTimeout(async () => {
        if (pendingEnhancedRef.current !== pending) return;
        pendingEnhancedRef.current = null;
        setIsSaving(true);
        try {
          await window.electronAPI.updateNote(pending.noteId, {
            enhanced_content: pending.enhancedContent,
          });
        } catch (err) {
          logger.warn(
            "Failed to save enhanced note content",
            { error: (err as Error).message },
            "notes"
          );
        } finally {
          setIsSaving(false);
        }
      }, 1000),
    };
    pendingEnhancedRef.current = pending;
  }, []);

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
    return () => flushPendingSaves("unmount");
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
    progress: actionProgress,
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

  const isEnhancementStale = useMemo(() => {
    if (!editorEnhancedContent || !activeNote?.enhanced_at_content_hash) return false;
    const currentHash = makeContentHash(`${editorNote?.content ?? ""}\n${activeNoteRawTranscript}`);
    return currentHash !== activeNote.enhanced_at_content_hash;
  }, [
    activeNote?.enhanced_at_content_hash,
    activeNoteRawTranscript,
    editorEnhancedContent,
    editorNote?.content,
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

  const prevTranscribingRef = useRef(false);
  const pendingTranscriptSaveNoteIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (prevTranscribingRef.current && !isTranscribing) {
      pendingTranscriptSaveNoteIdRef.current = recordingNoteId;
    }
    prevTranscribingRef.current = isTranscribing;

    const currentDiarizationStatus = useMeetingRecordingStore.getState().diarizationStatus;
    const pendingNoteId = pendingTranscriptSaveNoteIdRef.current;
    if (
      pendingNoteId == null ||
      isTranscribing ||
      currentDiarizationStatus === "queued" ||
      currentDiarizationStatus === "processing"
    ) {
      return;
    }

    const {
      transcript: realtimeTranscript,
      segments: realtimeSegments,
      diarizationSessionId: currentDiarizationSessionId,
    } = useMeetingRecordingStore.getState();
    const localTranscript =
      realtimeSegments.length > 0
        ? serializeTranscriptSegments(realtimeSegments)
        : realtimeTranscript;
    pendingTranscriptSaveNoteIdRef.current = null;

    void (async () => {
      try {
        let transcript = localTranscript;
        // Delayed diarization persists the canonical enriched transcript from
        // its module-level listener. Re-read it before publishing the
        // recording-saved event so the local live segments cannot overwrite
        // those speaker labels.
        if (currentDiarizationSessionId && window.electronAPI.getNote) {
          const persisted = await window.electronAPI.getNote(pendingNoteId);
          if (persisted?.transcript) transcript = persisted.transcript;
        }
        if (!transcript) {
          setTranscriptPersistenceStatus("failed");
          return;
        }
        if (window.electronAPI.saveEncounterRecording) {
          const result = await window.electronAPI.saveEncounterRecording(pendingNoteId, transcript);
          if (!result.success) {
            setTranscriptPersistenceStatus("failed");
            logger.warn("Failed to save encounter transcript", { error: result.error }, "meeting");
          } else {
            setTranscriptPersistenceStatus("ready");
          }
        } else {
          await window.electronAPI.updateNote(pendingNoteId, { transcript });
          setTranscriptPersistenceStatus("ready");
        }
      } catch (error) {
        pendingTranscriptSaveNoteIdRef.current = pendingNoteId;
        setTranscriptPersistenceStatus("failed");
        logger.warn(
          "Failed to save encounter transcript",
          { error: (error as Error).message },
          "meeting"
        );
      } finally {
        setIsFinalizingTranscript(false);
      }
    })();
  }, [diarizationStatus, isTranscribing, recordingNoteId]);

  useEffect(() => {
    if (!isFinalizingTranscript || isTranscribing) return;
    if (diarizationStatus !== "queued" && diarizationStatus !== "processing") {
      setIsFinalizingTranscript(false);
    }
  }, [diarizationStatus, isFinalizingTranscript, isTranscribing]);

  useEffect(() => {
    if (!isTranscribing) return;

    const interval = setInterval(() => {
      const { recordingNoteId: currentRecordingNoteId, segments: realtimeSegments } =
        useMeetingRecordingStore.getState();
      if (!currentRecordingNoteId || realtimeSegments.length === 0) return;
      window.electronAPI.updateNote(currentRecordingNoteId, {
        transcript: serializeTranscriptSegments(realtimeSegments),
      });
    }, 30_000);

    return () => clearInterval(interval);
  }, [isTranscribing]);

  const isActiveNoteRecording = isTranscribing && recordingNoteId === activeNote?.id;
  const isActiveTranscriptSession = recordingNoteId === activeNote?.id;
  const activeTranscriptStatus = isActiveTranscriptSession ? transcriptStatus : "idle";
  const activeDiarizationStatus = isActiveTranscriptSession ? diarizationStatus : "idle";
  const isActiveTranscriptProcessing = isActiveTranscriptSession && isFinalizingTranscript;

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
              isSaving={isSaving}
              isRecording={isActiveNoteRecording}
              isProcessing={isActiveTranscriptProcessing}
              transcriptStatus={activeTranscriptStatus}
              isEncounterCompleted={activeEncounter?.lifecycle_state === "completed"}
              recordingAllowed={meetingRecordingAllowed}
              onStartRecording={startRecording}
              onStopRecording={stopRecording}
              onExportNote={handleExportNote}
              onExportTranscript={handleExportTranscript}
              onExportClinicalNote={() => setShowClinicalExport(true)}
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
              folderName={activeFolderName}
              calendarEventName={calendarEventName}
              folders={editorFolders}
              onMoveToFolder={handleMoveToFolder}
              onCreateFolderAndMove={handleCreateFolderAndMove}
              onCancelPendingSaves={cancelPendingSaves}
              actionProcessingState={actionProcessingState}
              actionName={actionName}
              actionProgress={actionProgress}
              actionPicker={
                <ActionPicker
                  onRunAction={(action) => {
                    if (!editorNote) return;
                    const {
                      recordingNoteId: liveNoteId,
                      transcript: liveTranscript,
                      meetingContext: liveMeetingContextForAction,
                    } = useMeetingRecordingStore.getState();
                    const rawTranscript =
                      (liveNoteId === activeNote?.id ? liveTranscript : "") ||
                      activeNoteRawTranscript;
                    const noteContent = editorNote.content;
                    const hasNotes = !!noteContent.trim();
                    if (!hasNotes && !rawTranscript) return;

                    let formattedTranscript = "";
                    let isMeetingNote = false;
                    if (rawTranscript) {
                      const segments = parseTranscriptSegments(rawTranscript);
                      if (segments.length > 0) {
                        isMeetingNote = true;
                        formattedTranscript = segments
                          .map(
                            (s) =>
                              `${
                                s.source === "mic" &&
                                (liveNoteId === activeNote?.id
                                  ? liveMeetingContextForAction
                                  : normalizeMeetingContext(activeNote?.meeting_context)) ===
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

                    const parts = [
                      hasNotes ? noteContent : "",
                      formattedTranscript ? `## Meeting Transcript\n${formattedTranscript}` : "",
                    ]
                      .filter(Boolean)
                      .join("\n\n");
                    runAction(action, parts, makeContentHash(`${noteContent}\n${rawTranscript}`), {
                      isCloudMode,
                      modelId: effectiveModelId,
                      isMeetingNote,
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
                    actionProcessingState === "processing"
                  }
                />
              }
            />
            {editorNote.note_type === "meeting" && editorNote.calendar_event_id && activeEncounter && (
              <EncounterCompletionPrompt
                noteId={editorNote.id}
                isRecording={isActiveNoteRecording}
                isProcessing={isActiveTranscriptProcessing}
                isCompleted={activeEncounter.lifecycle_state === "completed"}
                templateReady={Boolean(
                  editorNote.enhanced_content?.trim() &&
                    editorNote.enhanced_template_revision_id != null
                )}
                onCompleted={(encounter) => setActiveEncounter(encounter)}
              />
            )}
            {activeNote && candidate && activeEncounter?.lifecycle_state !== "completed" && (
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
