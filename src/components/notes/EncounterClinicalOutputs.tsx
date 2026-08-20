import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  EncounterOutput,
  EncounterOutputStatus,
  MeetingDiarizationStatus,
} from "../../types/electron";
import {
  formatClinicalOutputForDisplay,
  generateClinicalOutputs,
} from "../../helpers/clinicalOutputGeneration";
import {
  runEncounterOutputGeneration,
  type EncounterOutputGenerationBridge,
} from "../../helpers/encounterOutputGeneration";
import { cn } from "../lib/utils";
import { RichTextEditor } from "../ui/RichTextEditor";

export type EncounterClinicalOutputMode = "summary" | "soap";

type EncounterOutputRecord = EncounterOutput;

interface EncounterOutputBridge extends EncounterOutputGenerationBridge {
  getEncounterByNote?: (noteId: number) => Promise<{
    success?: boolean;
    encounter: { id: number } | null;
  }>;
  getEncounterOutput?: (encounterId: number) => Promise<{
    success?: boolean;
    output: EncounterOutputRecord | null;
  }>;
  onEncounterOutputUpdated?: (
    callback: (payload: { encounterId?: number | null; applied?: boolean }) => void
  ) => () => void;
}

interface EncounterClinicalOutputsProps {
  noteId: number;
  mode: EncounterClinicalOutputMode;
  isRecording: boolean;
  isProcessingTranscript?: boolean;
  isEncounterCompleted?: boolean;
  diarizationStatus?: MeetingDiarizationStatus;
  transcript?: string | null;
}

const SAFE_ERROR_COPY = "notes.editor.clinicalOutputs.failedDescription";

function asBridge(): EncounterOutputBridge {
  return (window.electronAPI ?? {}) as unknown as EncounterOutputBridge;
}

function normalizeOutput(
  output: EncounterOutputRecord | null | undefined
): EncounterOutputRecord | null {
  if (!output) return null;
  return output;
}

/**
 * Generate only from the canonical main-process snapshot and publish only
 * through the matching guarded finish. This is exported so the renderer race
 * behavior can be tested without mounting the full note editor.
 */
function statusCopyKey(
  status: EncounterOutputStatus | null,
  options: {
    isRecording: boolean;
    isProcessingTranscript: boolean;
    separating: boolean;
    generating: boolean;
  }
): string {
  if (options.isRecording) return "notes.editor.clinicalOutputs.recording";
  if (options.isProcessingTranscript) return "notes.editor.clinicalOutputs.processingTranscript";
  if (options.separating) return "notes.editor.clinicalOutputs.separatingSpeakers";
  if (options.generating || status === "processing" || status === "pending") {
    return "notes.editor.clinicalOutputs.generatingNotes";
  }
  if (status === "stale") return "notes.editor.clinicalOutputs.stale";
  if (status === "failed") return "notes.editor.clinicalOutputs.failed";
  return "notes.editor.clinicalOutputs.ready";
}

export default function EncounterClinicalOutputs({
  noteId,
  mode,
  isRecording,
  isProcessingTranscript = false,
  isEncounterCompleted = false,
  diarizationStatus = "idle",
  transcript = "",
}: EncounterClinicalOutputsProps) {
  const { t } = useTranslation();
  const [encounterId, setEncounterId] = useState<number | null>(null);
  const [output, setOutput] = useState<EncounterOutputRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationFailed, setGenerationFailed] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [outputRefreshKey, setOutputRefreshKey] = useState(0);
  const generationAttemptRef = useRef(false);
  const generationScopeRef = useRef(0);
  const mountedRef = useRef(true);

  const currentTranscript = transcript || "";
  const separating = diarizationStatus === "queued" || diarizationStatus === "processing";
  const settled =
    !isRecording && !isProcessingTranscript && !separating && currentTranscript.trim().length > 0;
  const transcriptReadKey = settled ? currentTranscript : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setEncounterId(null);
    setOutput(null);
    setLoadFailed(false);
    setIsLoading(true);
    generationScopeRef.current += 1;
    generationAttemptRef.current = false;

    const bridge = asBridge();
    if (!noteId || !bridge.getEncounterByNote) {
      setIsLoading(false);
      return;
    }

    void bridge
      .getEncounterByNote(noteId)
      .then((result) => {
        if (cancelled) return;
        const encounter = result.encounter;
        setEncounterId(encounter?.id ?? null);
        if (result.success === false || !encounter) setLoadFailed(true);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [noteId]);

  useEffect(() => {
    if (encounterId == null) return;
    const subscribe = asBridge().onEncounterOutputUpdated;
    if (!subscribe) return;
    return subscribe((payload) => {
      if (Number(payload?.encounterId) === encounterId) {
        setOutputRefreshKey((current) => current + 1);
      }
    });
  }, [encounterId]);

  useEffect(() => {
    if (encounterId == null) return;
    const bridge = asBridge();
    const read = bridge.getEncounterOutput;
    if (!read) {
      setLoadFailed(true);
      return;
    }

    let cancelled = false;
    void read(encounterId)
      .then((result) => {
        if (!cancelled) setOutput(normalizeOutput(result.output));
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [encounterId, transcriptReadKey, outputRefreshKey]);

  const runGeneration = useCallback(
    async (force = false) => {
      if (
        encounterId == null ||
        isGenerating ||
        generationAttemptRef.current ||
        !currentTranscript.trim()
      )
        return;
      const bridge = asBridge();
      if (!bridge.beginEncounterOutputGeneration || !bridge.finishEncounterOutputGeneration) {
        setLoadFailed(true);
        return;
      }

      const scope = generationScopeRef.current;
      generationAttemptRef.current = true;
      setIsGenerating(true);
      setGenerationFailed(false);
      try {
        const result = await runEncounterOutputGeneration(
          bridge,
          encounterId,
          force,
          generateClinicalOutputs,
          (begunOutput) => {
            if (mountedRef.current && generationScopeRef.current === scope) {
              setOutput(normalizeOutput(begunOutput));
            }
          }
        );
        if (!mountedRef.current || generationScopeRef.current !== scope) return;
        setOutput(normalizeOutput(result.output));
        if (result.status === "superseded") {
          // The finish response is the current main-process state. Do not let
          // the generated result appear ready, and let the new revision retry.
          generationAttemptRef.current = false;
          setGenerationFailed(false);
        } else {
          setGenerationFailed(result.status === "failed");
        }
      } catch {
        if (!mountedRef.current || generationScopeRef.current !== scope) return;
        setGenerationFailed(true);
      } finally {
        if (mountedRef.current && generationScopeRef.current === scope) {
          generationAttemptRef.current = false;
          setIsGenerating(false);
        }
      }
    },
    [currentTranscript, encounterId, isGenerating]
  );

  const outputStatus: EncounterOutputStatus | null = output
    ? mode === "summary"
      ? output.summary_status
      : output.soap_status
    : null;
  const effectiveStatus = generationFailed ? "failed" : outputStatus;
  const statusKey = statusCopyKey(effectiveStatus, {
    isRecording,
    isProcessingTranscript,
    separating,
    generating: isGenerating,
  });
  const content = mode === "summary" ? output?.summary : output?.soap;
  const formattedContent = formatClinicalOutputForDisplay(mode, content);
  const showRetry = !isEncounterCompleted && (generationFailed || outputStatus === "failed");
  const showRegenerate = !isEncounterCompleted && outputStatus === "stale" && !isGenerating;

  if (isLoading && !output) {
    return (
      <div className="px-5 py-8 text-xs text-muted-foreground">
        {t("notes.editor.clinicalOutputs.loading")}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-5 py-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {isRecording || isGenerating || separating || isProcessingTranscript ? (
              <Loader2 size={13} className="shrink-0 animate-spin" />
            ) : effectiveStatus === "failed" ? (
              <AlertCircle size={13} className="shrink-0 text-destructive" />
            ) : (
              <CheckCircle2 size={13} className="shrink-0 text-emerald-500" />
            )}
            <span>{t(statusKey)}</span>
          </div>
          {showRetry && (
            <button
              type="button"
              onClick={() => void runGeneration(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/50 px-2.5 py-1.5 text-xs font-medium text-foreground/70 transition-colors hover:bg-foreground/5"
            >
              <RefreshCw size={12} />
              {t("notes.editor.clinicalOutputs.retry")}
            </button>
          )}
          {showRegenerate && (
            <button
              type="button"
              onClick={() => void runGeneration(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/50 px-2.5 py-1.5 text-xs font-medium text-foreground/70 transition-colors hover:bg-foreground/5"
            >
              <RefreshCw size={12} />
              {t("notes.editor.clinicalOutputs.regenerate")}
            </button>
          )}
        </div>

        {effectiveStatus === "failed" && (
          <div className="mb-5 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive/80">
            {t(SAFE_ERROR_COPY)}
          </div>
        )}

        {formattedContent ? (
          <div className={cn("clinical-output-richtext", outputStatus === "stale" && "opacity-70")}>
            <RichTextEditor value={formattedContent} readOnly />
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border/50 px-4 py-10 text-center text-sm text-muted-foreground">
            {t("notes.editor.clinicalOutputs.empty")}
          </div>
        )}

        {loadFailed && !output && (
          <p className="mt-4 text-center text-xs text-muted-foreground">
            {t("notes.editor.clinicalOutputs.unavailable")}
          </p>
        )}
      </div>
    </div>
  );
}
