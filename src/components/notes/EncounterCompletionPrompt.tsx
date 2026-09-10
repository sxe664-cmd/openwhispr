import { useEffect, useState } from "react";
import { CheckCircle2, LockKeyhole, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { EncounterOutput, LocalEncounter } from "../../types/electron";
import { Button } from "../ui/button";

interface EncounterCompletionPromptProps {
  noteId: number;
  isRecording: boolean;
  isProcessing?: boolean;
  isCompleted?: boolean;
  templateReady?: boolean;
  onBeforeComplete?: () => Promise<boolean>;
  onCompleted?: (encounter: LocalEncounter) => void;
}

function outputsAreReady(output: EncounterOutput | null): boolean {
  return Boolean(
    output &&
    output.summary_status === "ready" &&
    output.soap_status === "ready" &&
    output.focus_status === "ready"
  );
}

export default function EncounterCompletionPrompt({
  noteId,
  isRecording,
  isCompleted = false,
  onBeforeComplete,
  onCompleted,
}: EncounterCompletionPromptProps) {
  const { t } = useTranslation();
  const [encounter, setEncounter] = useState<LocalEncounter | null>(null);
  const [output, setOutput] = useState<EncounterOutput | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [confirmArmed, setConfirmArmed] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEncounter(null);
    setOutput(null);
    setConfirmArmed(false);
    setError(null);
    const readEncounter = window.electronAPI?.getEncounterByNote;
    if (!readEncounter) return undefined;

    void readEncounter(noteId)
      .then((result) => {
        if (!cancelled) setEncounter(result.success ? result.encounter : null);
      })
      .catch(() => {
        if (!cancelled) setEncounter(null);
      });

    return () => {
      cancelled = true;
    };
  }, [noteId]);

  useEffect(() => {
    if (!encounter?.id || encounter.lifecycle_state === "completed") return undefined;
    const subscribe = window.electronAPI?.onEncounterOutputUpdated;
    if (!subscribe) return undefined;
    return subscribe((payload) => {
      if (Number(payload?.encounterId) === encounter.id) {
        setRefreshKey((current) => current + 1);
      }
    });
  }, [encounter?.id, encounter?.lifecycle_state]);

  useEffect(() => {
    if (!encounter?.id || encounter.lifecycle_state === "completed") return undefined;
    let cancelled = false;
    const readOutput = window.electronAPI?.getEncounterOutput;
    if (!readOutput) return undefined;
    void readOutput(encounter.id)
      .then((result) => {
        if (!cancelled) setOutput(result.success ? result.output : null);
      })
      .catch(() => {
        if (!cancelled) setOutput(null);
      });
    return () => {
      cancelled = true;
    };
  }, [encounter?.id, encounter?.lifecycle_state, refreshKey]);

  if (
    !encounter ||
    isCompleted ||
    encounter.lifecycle_state !== "in_progress" ||
    isRecording
  ) {
    return null;
  }

  // Applying the enhanced template is a separate editing action. Completion
  // only needs the source transcript saved; clinical outputs may finish later.
  const clinicalInfoReady = outputsAreReady(output);

  const handleComplete = async () => {
    if (!confirmArmed) {
      setConfirmArmed(true);
      return;
    }
    if (!window.electronAPI?.markEncounterComplete) return;
    setIsCompleting(true);
    setError(null);
    try {
      if (onBeforeComplete) {
        const saved = await onBeforeComplete();
        if (!saved) {
          setError(t("notes.editor.encounterCompletion.unavailable"));
          setConfirmArmed(false);
          return;
        }
      }
      const result = await window.electronAPI.markEncounterComplete(encounter.id);
      if (!result.success || !result.encounter) {
        setError(result.error || t("notes.editor.encounterCompletion.unavailable"));
        setConfirmArmed(false);
        return;
      }
      setEncounter(result.encounter);
      onCompleted?.(result.encounter);
    } catch {
      setError(t("notes.editor.encounterCompletion.unavailable"));
      setConfirmArmed(false);
    } finally {
      setIsCompleting(false);
    }
  };

  return (
    <section
      className={
        clinicalInfoReady
          ? "rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3"
          : "rounded-lg border border-amber-500/25 bg-amber-500/5 p-3"
      }
      data-testid="encounter-completion-prompt"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          {clinicalInfoReady ? (
            <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <LockKeyhole size={15} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          )}
          <div className="min-w-0">
            <div className="text-xs font-semibold text-foreground/80">
              {clinicalInfoReady
                ? t("notes.editor.encounterCompletion.title")
                : t("notes.editor.encounterCompletion.markComplete")}
            </div>
            <div className="text-[11px] text-muted-foreground/80">
              {clinicalInfoReady
                ? t("notes.editor.encounterCompletion.description")
                : t("notes.editor.encounterCompletion.backgroundDescription")}
            </div>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => void handleComplete()}
          disabled={isCompleting}
          className="h-8 shrink-0 gap-1.5 px-2.5 text-[11px]"
        >
          {isCompleting ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <LockKeyhole size={12} />
          )}
          {isCompleting
            ? t("notes.editor.encounterCompletion.completing")
            : confirmArmed
              ? t("notes.editor.encounterCompletion.confirm")
              : t("notes.editor.encounterCompletion.markComplete")}
        </Button>
      </div>
      {!clinicalInfoReady && !confirmArmed && (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-950 dark:text-amber-100">
          {t("notes.editor.encounterCompletion.backgroundWarning")}
        </div>
      )}
      {confirmArmed && !isCompleting && (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-950 dark:text-amber-100">
          <div>{t("notes.editor.encounterCompletion.warning")}</div>
          <button
            type="button"
            onClick={() => setConfirmArmed(false)}
            className="mt-1 font-medium underline underline-offset-2"
          >
            {t("common.cancel")}
          </button>
        </div>
      )}
      {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
    </section>
  );
}
