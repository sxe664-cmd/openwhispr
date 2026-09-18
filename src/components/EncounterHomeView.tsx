import { useCallback, useMemo, useState, type ReactNode } from "react";
import { AlertCircle, CalendarClock, CheckCircle2, CloudOff, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LocalEncounter } from "../types/electron";
import { useEncounters, type EncounterSyncState } from "../hooks/useEncounters";
import { Button } from "./ui/button";
import { cn } from "./lib/utils";
import EncounterCard from "./EncounterCard";
import UpcomingMeetings from "./UpcomingMeetings";

function syncStateLabel(state: EncounterSyncState, t: (key: string) => string): string {
  return t(`encounters.sync.${state}`);
}

function safeError(error: unknown): string {
  return String(error || "Unable to start encounter").replace(/[\r\n]+/g, " ").slice(0, 240);
}

export default function EncounterHomeView() {
  const { t } = useTranslation();
  const { encounters, isLoading, syncState, lastSyncedAt, error, refresh } = useEncounters();
  const [startingId, setStartingId] = useState<number | null>(null);
  const [completingId, setCompletingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const scheduled = useMemo(() => encounters.filter((encounter) => encounter.lifecycle_state === "scheduled"), [encounters]);
  const inProgress = useMemo(() => encounters.filter((encounter) => encounter.lifecycle_state === "in_progress"), [encounters]);
  const completed = useMemo(() => encounters.filter((encounter) => encounter.lifecycle_state === "completed"), [encounters]);
  const cancelled = useMemo(() => encounters.filter((encounter) => encounter.lifecycle_state === "cancelled"), [encounters]);
  const cached = syncState !== "ready";

  const handleStart = useCallback(async (encounter: LocalEncounter) => {
    if (!encounter.calendar_event_id || !window.electronAPI?.startEncounter) return;
    setStartingId(encounter.id);
    setActionError(null);
    try {
      const result = await window.electronAPI.startEncounter(encounter.calendar_event_id, { meetingContext: "in_person" });
      if (!result?.success) throw new Error(result?.error || t("encounters.startError"));
      await refresh();
    } catch (startError) {
      setActionError(safeError(startError));
    } finally {
      setStartingId(null);
    }
  }, [refresh, t]);

  const handleOpen = useCallback(async (encounter: LocalEncounter) => {
    let noteId = encounter.note_id;
    try {
      const current = await window.electronAPI?.getEncounter?.(encounter.id);
      noteId = current?.success ? current.encounter?.note_id || null : noteId;
    } catch {
      // Keep the cached note link usable if the local refresh races with shutdown.
    }
    if (!noteId) return;
    setActionError(null);
    const result = await window.electronAPI?.agentOpenNote?.(noteId);
    if (!result?.success) setActionError(result?.error || t("encounters.openError"));
  }, [t]);

  const handleComplete = useCallback(async (encounter: LocalEncounter) => {
    if (!window.electronAPI?.markEncounterComplete) return;
    setCompletingId(encounter.id);
    setActionError(null);
    try {
      const result = await window.electronAPI.markEncounterComplete(encounter.id);
      if (!result?.success) {
        throw new Error(result?.error || t("notes.editor.encounterCompletion.unavailable"));
      }
      await refresh();
    } catch (completeError) {
      setActionError(safeError(completeError));
    } finally {
      setCompletingId(null);
    }
  }, [refresh, t]);

  const renderCards = (items: LocalEncounter[], emptyLabel: string) => {
    if (items.length === 0) return <p className="rounded-lg border border-dashed border-border/60 px-4 py-6 text-center text-xs text-muted-foreground">{emptyLabel}</p>;
    return <div className="grid gap-3 md:grid-cols-2">{items.map((encounter) => <EncounterCard key={encounter.id} encounter={encounter} cached={cached} isStarting={startingId === encounter.id} isCompleting={completingId === encounter.id} onStart={handleStart} onOpen={handleOpen} onComplete={handleComplete} />)}</div>;
  };

  return (
    <section className="mb-8 px-6 sm:px-8 lg:px-12" aria-labelledby="encounters-heading">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="encounters-heading" className="text-base font-semibold text-foreground">{t("encounters.title")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t("encounters.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px]", syncState === "ready" ? "border-emerald-500/25 text-emerald-600 dark:text-emerald-400" : "border-amber-500/30 text-amber-700 dark:text-amber-300")}>
            {syncState === "ready" ? <CheckCircle2 size={12} /> : <CloudOff size={12} />}
            {syncStateLabel(syncState, t)}
          </span>
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => void refresh()} disabled={isLoading} title={t("encounters.refresh")}><RefreshCw size={13} className={cn(isLoading && "animate-spin")} /></Button>
        </div>
      </div>

      {actionError && <div className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive"><AlertCircle size={14} className="mt-0.5 shrink-0" /><span>{actionError}</span></div>}
      {syncState !== "ready" && <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{syncState === "syncing" ? <Loader2 size={14} className="mt-0.5 animate-spin" /> : <CloudOff size={14} className="mt-0.5" />}<span>{syncState === "syncing" ? t("encounters.syncingDescription") : t("encounters.cachedDescription")}{lastSyncedAt && <span className="ml-1 opacity-80">{t("encounters.lastSynced", { time: new Date(lastSyncedAt).toLocaleString() })}</span>}</span></div>}
      {error && <div className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert"><AlertCircle size={14} className="mt-0.5 shrink-0" /><span>{error}</span></div>}

      {isLoading && encounters.length === 0 && !error ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-border/60 bg-card/50 py-12 text-sm text-muted-foreground"><Loader2 size={15} className="animate-spin text-primary" />{t("controlPanel.loading")}</div>
      ) : encounters.length === 0 && error ? (
        <div className="rounded-xl border border-destructive/25 bg-destructive/5 px-6 py-12 text-center" role="status"><div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-destructive/10 text-destructive"><AlertCircle size={19} /></div><h3 className="mt-3 text-sm font-semibold text-foreground">{t("encounters.sync.error")}</h3><p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">{error}</p></div>
      ) : encounters.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-card/30 px-6 py-12 text-center"><div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><CalendarClock size={19} /></div><h3 className="mt-3 text-sm font-semibold text-foreground">{t("encounters.emptyTitle")}</h3><p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">{t("encounters.emptyDescription")}</p></div>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="space-y-6">
            {inProgress.length > 0 && <EncounterSection title={t("encounters.inProgress")} count={inProgress.length}>{renderCards(inProgress, t("encounters.noneInProgress"))}</EncounterSection>}
            <div className="xl:hidden"><UpcomingMeetings encounters={scheduled} isLoading={isLoading} cached={cached} startingId={startingId} onStart={handleStart} onOpen={handleOpen} /></div>
            {completed.length > 0 && <EncounterSection title={t("encounters.completed")} count={completed.length}>{renderCards(completed, t("encounters.noneCompleted"))}</EncounterSection>}
            {cancelled.length > 0 && <EncounterSection title={t("encounters.cancelled")} count={cancelled.length}>{renderCards(cancelled, t("encounters.noneCancelled"))}</EncounterSection>}
          </div>
          <div className="hidden xl:block"><UpcomingMeetings encounters={scheduled} isLoading={isLoading} cached={cached} startingId={startingId} onStart={handleStart} onOpen={handleOpen} /></div>
        </div>
      )}
    </section>
  );
}

function EncounterSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return <section><div className="mb-2 flex items-center gap-2"><h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3><span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{count}</span></div>{children}</section>;
}
