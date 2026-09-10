import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, X } from "lucide-react";
import { cn } from "../lib/utils";
import type { ActionProcessingState } from "../../hooks/useActionProcessing";
import type { ActionProcessingProgress } from "../../hooks/useActionProcessing";

interface ActionProcessingOverlayProps {
  state: ActionProcessingState;
  actionName: string | null;
  isBuiltInAction?: boolean;
  errorMessage?: string | null;
  progress?: ActionProcessingProgress | null;
  startedAt?: number | null;
  onCancel?: () => void;
}

export default function ActionProcessingOverlay({
  state,
  actionName,
  isBuiltInAction = false,
  errorMessage,
  progress,
  startedAt,
  onCancel,
}: ActionProcessingOverlayProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(state !== "idle");
  const [clock, setClock] = useState(Date.now());

  useEffect(() => {
    if (state !== "idle") {
      setVisible(true);
      return;
    }
    const id = setTimeout(() => setVisible(false), 300);
    return () => clearTimeout(id);
  }, [state]);

  useEffect(() => {
    if ((state !== "processing" && state !== "retrying") || !startedAt) return;
    setClock(Date.now());
    const id = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [startedAt, state]);

  if (!visible) return null;

  const isSuccess = state === "success";
  const isFailed = state === "failed";
  const isFadingOut = state === "idle";
  const elapsedSeconds = startedAt ? Math.max(0, Math.floor((clock - startedAt) / 1_000)) : 0;
  const elapsed = `${elapsedSeconds >= 60 ? `${Math.floor(elapsedSeconds / 60)}m ` : ""}${elapsedSeconds % 60}s`;
  return (
    <div
      className={cn(
        "absolute inset-0 z-[5] flex items-center justify-center",
        isBuiltInAction && "pointer-events-none",
        !isBuiltInAction && "bg-background/60 dark:bg-background/70 backdrop-blur-md",
        isBuiltInAction && "items-end justify-end p-3",
        "transition-opacity duration-300",
        isFadingOut && "opacity-0 pointer-events-none"
      )}
      style={!isFadingOut ? { animation: "float-up 0.25s ease-out" } : undefined}
    >
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.02]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, transparent, transparent 3px, currentColor 3px, currentColor 4px)",
        }}
      />

      <div
        className={cn(
          "absolute left-0 right-0 h-[2px] pointer-events-none scanner-sweep-line",
          isSuccess ? "bg-success/60" : "bg-accent/60"
        )}
        style={{
          animation: isSuccess ? "none" : "scanner-sweep 2.5s ease-in-out infinite",
          boxShadow: isSuccess
            ? "0 0 24px 8px color-mix(in oklch, var(--color-success) 20%, transparent)"
            : "0 0 24px 8px color-mix(in oklch, var(--color-accent) 15%, transparent)",
          ...(isSuccess ? { top: "50%" } : {}),
        }}
      />

      <div
        className={cn(
          "relative flex flex-col items-center gap-2.5",
          isSuccess
            ? "bg-success/6 dark:bg-success/8 border-success/12 dark:border-success/15"
            : isFailed
              ? "bg-destructive/6 dark:bg-destructive/8 border-destructive/12 dark:border-destructive/15"
              : "bg-accent/6 dark:bg-accent/8 border-accent/12 dark:border-accent/15",
          "backdrop-blur-xl border rounded-xl shadow-elevated",
          isBuiltInAction ? "px-4 py-2" : "px-6 py-3",
          "transition-colors duration-300"
        )}
      >
        {isSuccess ? (
          <div className="flex items-center gap-2">
            <Check size={13} className="text-success/70" />
            <span className="text-xs font-medium text-success/70 tracking-tight">
              {t("notes.actions.done")}
            </span>
          </div>
        ) : isFailed ? (
          <span className="text-xs font-medium text-destructive/75 tracking-tight">
            {errorMessage || t("notes.editor.processingStatus.failedClinicalNotes")}
          </span>
        ) : (
          <>
            <span className="text-xs font-medium text-accent/70 tracking-tight">{actionName}</span>
            {progress && (
              <span className="text-[10px] text-foreground/45">
                {progress.stage === "extracting"
                  ? t("notes.editor.processingStatus.processingEvidence")
                  : progress.stage === "synthesizing"
                    ? t("notes.editor.processingStatus.finalizingClinicalNotes")
                    : progress.stage === "retrying"
                      ? t("notes.editor.processingStatus.retryingClinicalNotes")
                      : progress.stage === "applying"
                        ? t("notes.editor.processingStatus.compiling")
                        : progress.stage === "compiling"
                    ? t("notes.editor.processingStatus.compiling")
                    : t("notes.editor.processingStatus.generating")}{" "}
                · {progress.current}/{progress.total}{startedAt ? ` · ${elapsed}` : ""}
              </span>
            )}
            <div className="w-32 h-0.5 bg-accent/10 rounded-full overflow-hidden">
              <div
                className="h-full w-1/3 bg-accent/40 rounded-full"
                style={{ animation: "indeterminate 1.5s ease-in-out infinite" }}
                data-scanner-progress=""
              />
            </div>
            {isBuiltInAction && onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="pointer-events-auto inline-flex items-center gap-1 text-[10px] text-foreground/50 hover:text-foreground/80"
              >
                <X size={10} />
                {t("common.cancel")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
