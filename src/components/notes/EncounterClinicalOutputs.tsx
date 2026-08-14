import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  EncounterOutput,
  EncounterOutputGenerationUpdate,
  EncounterTranscriptToken,
  EncounterOutputStatus,
  EncounterOutputType,
  MeetingDiarizationStatus,
} from "../../types/electron";
import {
  generateClinicalOutputs,
  type ClinicalOutputResult,
  type ClinicalOutputsResult,
} from "../../helpers/clinicalOutputGeneration";
import { cn } from "../lib/utils";

export type EncounterClinicalOutputMode = "summary" | "soap";

type EncounterOutputRecord = EncounterOutput;

interface EncounterOutputBridge {
  getEncounterOutput?: (encounterId: number) => Promise<{
    success?: boolean;
    output: EncounterOutputRecord | null;
  }>;
  beginEncounterOutputGeneration?: (
    encounterId: number,
    outputTypes?: EncounterOutputType | Array<Exclude<EncounterOutputType, "all">>
  ) => Promise<{
    success?: boolean;
    output: EncounterOutputRecord | null;
    transcript: string | null;
    token: EncounterTranscriptToken | null;
  }>;
  finishEncounterOutputGeneration?: (
    encounterId: number,
    token: EncounterTranscriptToken,
    updates: EncounterOutputGenerationUpdate
  ) => Promise<{
    success?: boolean;
    applied: boolean;
    output: EncounterOutputRecord | null;
  }>;
  retryEncounterOutput?: (
    encounterId: number,
    outputType?: EncounterOutputType
  ) => Promise<{
    success?: boolean;
    output: EncounterOutputRecord | null;
  }>;
}

interface EncounterBridge {
  getEncounters?: (limit?: number) => Promise<{
    success?: boolean;
    encounters?: Array<{ id: number; calendar_event_id: string | null }>;
  }>;
}

interface EncounterClinicalOutputsProps {
  calendarEventId: string;
  mode: EncounterClinicalOutputMode;
  isRecording: boolean;
  isProcessingTranscript?: boolean;
  diarizationStatus?: MeetingDiarizationStatus;
  transcript?: string | null;
}

const SAFE_ERROR_COPY = "notes.editor.clinicalOutputs.failedDescription";

function asBridge(): EncounterOutputBridge & EncounterBridge {
  return (window.electronAPI ?? {}) as unknown as EncounterOutputBridge & EncounterBridge;
}

function normalizeOutput(
  output: EncounterOutputRecord | null | undefined
): EncounterOutputRecord | null {
  if (!output) return null;
  return output;
}

function outputUpdates(result: ClinicalOutputsResult): EncounterOutputGenerationUpdate {
  const errorCode = (output: ClinicalOutputResult): string | null =>
    "errorCode" in output ? output.errorCode : null;
  return {
    summary: result.summary.success ? result.summary.content : null,
    summary_status: result.summary.success ? "ready" : "failed",
    summary_provider: result.summary.success ? result.summary.provider : null,
    summary_model: result.summary.success ? result.summary.model : null,
    summary_error_code: errorCode(result.summary),
    soap: result.soap.success ? result.soap.content : null,
    soap_status: result.soap.success ? "ready" : "failed",
    soap_provider: result.soap.success ? result.soap.provider : null,
    soap_model: result.soap.success ? result.soap.model : null,
    soap_error_code: errorCode(result.soap),
    focus: result.focus.success ? result.focus.content : null,
    focus_status: result.focus.success ? "ready" : "failed",
    focus_provider: result.focus.success ? result.focus.provider : null,
    focus_model: result.focus.success ? result.focus.model : null,
    focus_error_code: errorCode(result.focus),
  };
}

function failedOutputUpdates(): EncounterOutputGenerationUpdate {
  return {
    summary: null,
    summary_status: "failed",
    summary_error_code: "GENERATION_FAILED",
    soap: null,
    soap_status: "failed",
    soap_error_code: "GENERATION_FAILED",
    focus: null,
    focus_status: "failed",
    focus_error_code: "GENERATION_FAILED",
  };
}

export type EncounterOutputGenerationOutcome = {
  status: "applied" | "failed" | "superseded";
  output: EncounterOutputRecord | null;
};

/**
 * Generate only from the canonical main-process snapshot and publish only
 * through the matching guarded finish. This is exported so the renderer race
 * behavior can be tested without mounting the full note editor.
 */
// eslint-disable-next-line react-refresh/only-export-components
export async function runEncounterOutputGeneration(
  bridge: EncounterOutputBridge,
  encounterId: number,
  force: boolean,
  generate: (transcript: string) => Promise<ClinicalOutputsResult> = generateClinicalOutputs,
  onBegin?: (output: EncounterOutputRecord) => void
): Promise<EncounterOutputGenerationOutcome> {
  if (!bridge.beginEncounterOutputGeneration || !bridge.finishEncounterOutputGeneration) {
    throw new Error("Encounter output generation unavailable");
  }

  if (force && bridge.retryEncounterOutput) {
    const retried = await bridge.retryEncounterOutput(encounterId, "all");
    if (!retried.success || !retried.output) throw new Error("Encounter retry unavailable");
  }

  const begun = await bridge.beginEncounterOutputGeneration(encounterId, "all");
  if (!begun.success || !begun.output || !begun.token || typeof begun.transcript !== "string") {
    throw new Error("Encounter output unavailable");
  }
  onBegin?.(begun.output);

  let generated: ClinicalOutputsResult;
  try {
    if (!begun.transcript.trim()) throw new Error("Encounter transcript unavailable");
    generated = await generate(begun.transcript);
  } catch (error) {
    const failed = await bridge.finishEncounterOutputGeneration(
      encounterId,
      begun.token,
      failedOutputUpdates()
    );
    if (!failed.success) throw error;
    return {
      status: failed.applied ? "failed" : "superseded",
      output: failed.output,
    };
  }

  const finished = await bridge.finishEncounterOutputGeneration(
    encounterId,
    begun.token,
    outputUpdates(generated)
  );
  if (!finished.success) throw new Error("Encounter output unavailable");
  return {
    status: finished.applied ? "applied" : "superseded",
    output: finished.output,
  };
}

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
  calendarEventId,
  mode,
  isRecording,
  isProcessingTranscript = false,
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
    if (!calendarEventId || !bridge.getEncounters) {
      setIsLoading(false);
      return;
    }

    void bridge
      .getEncounters(200)
      .then((result) => {
        if (cancelled) return;
        const encounter = (result.encounters ?? []).find(
          (candidate) => candidate.calendar_event_id === calendarEventId
        );
        setEncounterId(encounter?.id ?? null);
        if (!encounter) setLoadFailed(true);
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
  }, [calendarEventId]);

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
  }, [encounterId, transcriptReadKey]);

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

  useEffect(() => {
    if (!settled || encounterId == null || isLoading || isGenerating) return;
    const status = output?.status ?? null;
    const shouldGenerate = status == null || status === "pending" || status === "stale";
    if (shouldGenerate) void runGeneration(false);
  }, [encounterId, isGenerating, isLoading, output, runGeneration, settled]);

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
  const showRetry = generationFailed || outputStatus === "failed";
  const showRegenerate = outputStatus === "stale" && !isGenerating;

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

        {content ? (
          <div
            className={cn(
              "whitespace-pre-wrap text-sm leading-7 text-foreground/80",
              outputStatus === "stale" && "opacity-70"
            )}
          >
            {content}
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
