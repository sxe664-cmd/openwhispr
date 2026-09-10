import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, FileDown, Loader2, RefreshCw } from "lucide-react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import type { ClinicalNoteExportPreview, ClinicalNoteExportSection } from "../../types/electron";

interface ClinicalNoteExportDialogProps {
  noteId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DEFAULT_SECTIONS: ClinicalNoteExportSection[] = ["summary", "soap", "encounterDetails"];

const LABELS: Record<ClinicalNoteExportSection, { title: string; description: string }> = {
  summary: { title: "Summary", description: "Concise clinical overview" },
  soap: { title: "SOAP note", description: "Subjective, Objective, Assessment, and Plan" },
  notes: { title: "Additional notes", description: "Your notes captured during the encounter" },
  filledTemplate: {
    title: "Filled clinical template",
    description: "Generated Clinical Encounter v2 note with formatted sections",
  },
  encounterDetails: { title: "Encounter details", description: "Date, context, and duration" },
  participants: { title: "Participants", description: "People identified in the encounter" },
  transcript: {
    title: "Full transcript",
    description: "Adds the source transcript as an appendix",
  },
};

function statusLabel(status: string) {
  if (status === "ready") return "Ready";
  if (status === "processing") return "Generating";
  if (status === "stale") return "Needs regeneration";
  if (status === "failed") return "Generation failed";
  return "Waiting to generate";
}

export default function ClinicalNoteExportDialog({
  noteId,
  open,
  onOpenChange,
}: ClinicalNoteExportDialogProps) {
  const [preview, setPreview] = useState<ClinicalNoteExportPreview | null>(null);
  const [sections, setSections] = useState<ClinicalNoteExportSection[]>(DEFAULT_SECTIONS);
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.getClinicalNoteExportPreview?.(noteId);
      if (!result?.success) throw new Error(result?.error || "Unable to prepare clinical export.");
      setPreview(result);
      const available = (section: ClinicalNoteExportSection) =>
        result.sections?.[section]?.available === true;
      setSections([
        ...DEFAULT_SECTIONS.filter((section) => section === "encounterDetails" || available(section)),
        ...(available("notes") ? (["notes"] as const) : []),
        ...(available("filledTemplate") ? (["filledTemplate"] as const) : []),
      ]);
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [noteId]);

  useEffect(() => {
    if (open) {
      setSections(DEFAULT_SECTIONS);
      void loadPreview();
    }
  }, [open, loadPreview]);

  const requiredReady = useMemo(() => {
    const statuses = preview?.sections;
    return Boolean(
      sections.length > 0 &&
      sections.some((section) => statuses?.[section]?.available)
    );
  }, [preview, sections]);

  const toggleSection = (section: ClinicalNoteExportSection) => {
    setSections((current) =>
      current.includes(section)
        ? current.filter((value) => value !== section)
        : [...current, section]
    );
  };

  const retry = async () => {
    if (!preview?.encounterId || !window.electronAPI?.retryEncounterOutput) return;
    setIsRetrying(true);
    setError(null);
    try {
      const result = await window.electronAPI.retryEncounterOutput(preview.encounterId, "all");
      if (!result.success)
        throw new Error(result.error || "Unable to retry clinical note generation.");
      window.setTimeout(() => void loadPreview(), 500);
    } catch (retryError) {
      setError((retryError as Error).message);
    } finally {
      setIsRetrying(false);
    }
  };

  const exportPdf = async () => {
    if (!requiredReady || !window.electronAPI?.exportClinicalNotePdf) return;
    setIsExporting(true);
    setError(null);
    try {
      const result = await window.electronAPI.exportClinicalNotePdf(noteId, { sections });
      if (!result.success) throw new Error(result.error || "Unable to export clinical note PDF.");
      onOpenChange(false);
    } catch (exportError) {
      setError((exportError as Error).message);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileDown size={18} className="text-primary" />
            Export clinical note
          </DialogTitle>
          <DialogDescription>
            Choose the sections to include in a polished PDF. Summary, SOAP, and the filled
            clinical template are selected by default when available.
          </DialogDescription>
        </DialogHeader>

        {preview?.title && (
          <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
            <p className="truncate text-sm font-semibold text-foreground">{preview.title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{preview.date}</p>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 size={15} className="animate-spin" /> Preparing export…
          </div>
        ) : (
          <div className="space-y-2">
            {(Object.keys(LABELS) as ClinicalNoteExportSection[]).map((section) => {
              const state = preview?.sections?.[section];
              const selected = sections.includes(section);
              const available = state?.available ?? false;
              const canToggle = available;
              return (
                <button
                  key={section}
                  type="button"
                  onClick={() => toggleSection(section)}
                  disabled={!canToggle}
                  aria-pressed={selected}
                  className="flex w-full items-center gap-3 rounded-lg border border-border/60 px-3 py-2.5 text-left transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
                  >
                    {selected && <Check size={13} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">
                      {LABELS[section].title}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {LABELS[section].description}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 text-[11px] ${state?.status === "ready" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-300"}`}
                  >
                    {available
                      ? section === "summary" || section === "soap"
                        ? statusLabel(state?.status || "pending")
                        : "Available"
                      : statusLabel(state?.status || "pending")}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {preview &&
          (!preview.sections?.summary?.available || !preview.sections?.soap?.available) && (
            <div className="flex items-start justify-between gap-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <span>Summary or SOAP is not ready. You can still export the available notes, transcript, and encounter details.</span>
              <Button
                variant="outline-flat"
                size="sm"
                onClick={() => void retry()}
                disabled={isRetrying}
              >
                <RefreshCw size={12} className={isRetrying ? "animate-spin" : ""} /> Retry
              </Button>
            </div>
          )}
        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isExporting}>
            Cancel
          </Button>
          <Button
            onClick={() => void exportPdf()}
            disabled={!requiredReady || isExporting || isLoading}
          >
            {isExporting && <Loader2 size={14} className="animate-spin" />}
            {isExporting ? "Exporting…" : "Export PDF"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
