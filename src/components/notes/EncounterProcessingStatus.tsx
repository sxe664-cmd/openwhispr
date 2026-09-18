import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, Circle, CircleDashed, Loader2, Minus, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { EncounterOutput, MeetingDiarizationStatus } from "../../types/electron";
import type { TranscriptPersistenceStatus } from "../../stores/meetingRecordingStore";
import {
  clinicalStatus,
  isTranscriptPersistenceBusy,
  outputStatus,
  transcriptStageStatus,
  type StageStatus,
} from "../../helpers/encounterStatus";
import { cn } from "../lib/utils";

interface EncounterProcessingStatusProps {
  noteId: number;
  hasTranscript: boolean;
  isRecording: boolean;
  isProcessingTranscript: boolean;
  transcriptStatus?: TranscriptPersistenceStatus;
  diarizationStatus?: MeetingDiarizationStatus;
  diarizationEnabled?: boolean;
  hasDiarizedTranscript?: boolean;
}

interface Stage {
  key: "transcript" | "speakers" | "clinical";
  label: string;
  status: StageStatus;
  detail: string;
}

interface ProcessingBridge {
  getEncounterByNote?: (noteId: number) => Promise<{
    success?: boolean;
    encounter: { id: number } | null;
  }>;
  getEncounterOutput?: (encounterId: number) => Promise<{
    success?: boolean;
    output: EncounterOutput | null;
  }>;
  onEncounterOutputUpdated?: (
    callback: (payload: { encounterId?: number | null; applied?: boolean }) => void
  ) => () => void;
}

function bridge(): ProcessingBridge {
  return (window.electronAPI ?? {}) as unknown as ProcessingBridge;
}

function StatusIcon({ status }: { status: StageStatus }) {
  if (status === "active") return <Loader2 size={11} className="animate-spin" />;
  if (status === "retrying") return <Loader2 size={11} className="animate-spin" />;
  if (status === "ready") return <Check size={11} />;
  if (status === "skipped") return <Minus size={11} />;
  if (status === "failed") return <AlertCircle size={11} />;
  if (status === "queued") return <CircleDashed size={11} />;
  if (status === "stale") return <RefreshCw size={11} />;
  return <Circle size={8} />;
}

export default function EncounterProcessingStatus({
  noteId,
  hasTranscript,
  isRecording,
  isProcessingTranscript,
  transcriptStatus = "idle",
  diarizationStatus = "idle",
  diarizationEnabled = true,
  hasDiarizedTranscript = false,
}: EncounterProcessingStatusProps) {
  const { t } = useTranslation();
  const [clinicalOutput, setClinicalOutput] = useState<EncounterOutput | null>(null);
  const [encounterId, setEncounterId] = useState<number | null>(null);

  const readClinicalOutput = useCallback(async (id: number) => {
    const result = await bridge().getEncounterOutput?.(id);
    return result?.success !== false ? (result?.output ?? null) : null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setEncounterId(null);
    setClinicalOutput(null);
    const readEncounter = bridge().getEncounterByNote;
    if (!readEncounter) return undefined;
    void readEncounter(noteId)
      .then(async (result) => {
        if (cancelled || !result.encounter) return;
        setEncounterId(result.encounter.id);
        const output = await readClinicalOutput(result.encounter.id);
        if (!cancelled) setClinicalOutput(output);
      })
      .catch(() => {
        if (!cancelled) setEncounterId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [noteId, readClinicalOutput]);

  useEffect(() => {
    if (encounterId == null) return undefined;
    const unsubscribe = bridge().onEncounterOutputUpdated?.((payload) => {
      if (payload.encounterId == null || Number(payload.encounterId) !== encounterId) return;
      void readClinicalOutput(encounterId).then((output) => setClinicalOutput(output));
    });
    return () => unsubscribe?.();
  }, [encounterId, readClinicalOutput]);

  const stages = useMemo<Stage[]>(() => {
    const transcriptStage = transcriptStageStatus({
      hasTranscript,
      isRecording,
      isProcessingTranscript,
      transcriptStatus,
    });
    const speakersStage: StageStatus =
      !diarizationEnabled || diarizationStatus === "skipped"
        ? "skipped"
        : diarizationStatus === "queued" || diarizationStatus === "processing"
          ? "active"
          : diarizationStatus === "failed"
            ? "failed"
            : diarizationStatus === "completed" ||
                (diarizationStatus === "idle" && hasDiarizedTranscript)
              ? "ready"
              : "idle";
    const transcriptBusy =
      isRecording || isTranscriptPersistenceBusy(transcriptStatus, isProcessingTranscript);
    const diarizationBusy = diarizationStatus === "queued" || diarizationStatus === "processing";
    const clinicalStage = clinicalStatus(clinicalOutput, {
      hasTranscript,
      transcriptBusy,
      diarizationBusy,
    });

    return [
      {
        key: "transcript",
        label: t("notes.editor.transcript"),
        status: transcriptStage,
        detail:
          transcriptStage === "active"
            ? isRecording
              ? t("notes.editor.clinicalOutputs.recording")
              : transcriptStatus === "finalizing"
                ? t("notes.editor.processingStatus.finalizingTranscript")
                : transcriptStatus === "saving"
                  ? t("notes.editor.processingStatus.savingTranscript")
                  : t("notes.editor.clinicalOutputs.processingTranscript")
            : transcriptStage === "failed"
              ? t("notes.editor.clinicalOutputs.failed")
              : transcriptStage === "ready"
                ? t("notes.editor.clinicalOutputs.ready")
                : t("notes.editor.processingStatus.waitingForTranscript"),
      },
      {
        key: "speakers",
        label: t("notes.editor.processingStatus.speakers"),
        status: speakersStage,
        detail:
          diarizationStatus === "queued"
            ? t("notes.editor.processingStatus.queued")
            : speakersStage === "active"
              ? t("notes.editor.clinicalOutputs.separatingSpeakers")
              : speakersStage === "failed"
                ? t("notes.editor.clinicalOutputs.failed")
                : speakersStage === "skipped"
                  ? t("notes.editor.processingStatus.skipped")
                  : speakersStage === "ready"
                    ? t("notes.editor.clinicalOutputs.ready")
                    : t("notes.editor.processingStatus.waitingForTranscript"),
      },
      {
        key: "clinical",
        label: t("notes.editor.processingStatus.clinicalNotes"),
        status: clinicalStage,
        detail:
          clinicalStage === "active"
            ? clinicalOutput?.generation_phase === "mapping"
              ? t("notes.editor.processingStatus.generatingProgress", {
                  current: clinicalOutput.generation_progress_current,
                  total: clinicalOutput.generation_progress_total,
                })
              : clinicalOutput?.generation_phase === "synthesizing"
                ? t("notes.editor.processingStatus.finalizingClinicalNotes")
                : t("notes.editor.clinicalOutputs.generatingNotes")
            : clinicalStage === "queued"
              ? t("notes.editor.processingStatus.queuedBackground")
              : clinicalStage === "retrying"
                ? t("notes.editor.processingStatus.retryingClinicalNotes")
                : clinicalStage === "failed"
                  ? t("notes.editor.processingStatus.failedClinicalNotes")
                  : clinicalStage === "stale"
                    ? t("notes.editor.processingStatus.needsRegeneration")
                    : clinicalStage === "ready"
                      ? t("notes.editor.processingStatus.readyClinicalNotes")
                      : t("notes.editor.processingStatus.waitingForTranscript"),
      },
    ];
  }, [
    clinicalOutput,
    diarizationEnabled,
    diarizationStatus,
    hasDiarizedTranscript,
    hasTranscript,
    isProcessingTranscript,
    isRecording,
    t,
    transcriptStatus,
  ]);

  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border/15 pt-2"
      aria-live="polite"
      aria-label={t("notes.editor.processingStatus.label")}
    >
      {stages.map((stage, index) => (
        <div key={stage.key} className="flex items-center gap-1.5">
          <div
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] transition-colors",
              stage.status === "active" && "border-primary/25 bg-primary/5 text-primary",
              stage.status === "retrying" && "border-primary/25 bg-primary/5 text-primary",
              stage.status === "ready" &&
                "border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300",
              stage.status === "failed" &&
                "border-destructive/25 bg-destructive/5 text-destructive",
              stage.status === "queued" &&
                "border-amber-500/20 bg-amber-500/5 text-amber-700 dark:text-amber-300",
              stage.status === "stale" &&
                "border-amber-500/25 bg-amber-500/5 text-amber-700 dark:text-amber-300",
              stage.status === "skipped" &&
                "border-border/30 bg-foreground/[0.02] text-muted-foreground/70",
              stage.status === "idle" && "border-border/25 text-muted-foreground/70"
            )}
            title={stage.detail}
          >
            <StatusIcon status={stage.status} />
            <span className="font-medium">{stage.label}</span>
            <span className="text-[9px] opacity-75">{stage.detail}</span>
          </div>
          {index < stages.length - 1 && (
            <span className="text-[10px] text-muted-foreground/30">→</span>
          )}
        </div>
      ))}
    </div>
  );
}
