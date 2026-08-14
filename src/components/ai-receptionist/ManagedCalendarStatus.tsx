import React from "react";
import { AlertCircle, CalendarCheck2, CloudOff, Loader2, RefreshCw } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import type { ManagedCalendarState } from "./useManagedCalendar";

const COPY: Record<ManagedCalendarState, { title: string; description: string; tone: string }> = {
  ready: {
    title: "Calendar ready",
    description: "Google Calendar is managed by AIReceptionist.",
    tone: "text-emerald-600 dark:text-emerald-400",
  },
  syncing: {
    title: "Syncing calendar",
    description: "Your cached encounters remain available while the calendar updates.",
    tone: "text-primary",
  },
  stale: {
    title: "Showing cached calendar data",
    description: "AIReceptionist could not refresh just now. Your saved encounters are still available.",
    tone: "text-amber-600 dark:text-amber-400",
  },
  unavailable: {
    title: "AIReceptionist is unavailable",
    description: "This private build does not currently include its managed calendar runtime.",
    tone: "text-muted-foreground",
  },
  error: {
    title: "Calendar unavailable",
    description: "Calendar status could not be read. Try reopening the app; saved encounters remain local.",
    tone: "text-destructive",
  },
};

function StatusIcon({ state }: { state: ManagedCalendarState }) {
  if (state === "syncing") return <Loader2 className="h-4 w-4 animate-spin" />;
  if (state === "stale" || state === "error") return <AlertCircle className="h-4 w-4" />;
  if (state === "unavailable") return <CloudOff className="h-4 w-4" />;
  return <CalendarCheck2 className="h-4 w-4" />;
}

function formatSyncTime(value: string | null) {
  if (!value) return "Not synced yet";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? "Last sync unavailable"
    : `Last synced ${timestamp.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
}

interface ManagedCalendarStatusProps {
  state: ManagedCalendarState;
  lastSuccessfulSyncAt?: string | null;
  onRefresh?: () => void;
  compact?: boolean;
}

export default function ManagedCalendarStatus({
  state,
  lastSuccessfulSyncAt = null,
  onRefresh,
  compact = false,
}: ManagedCalendarStatusProps) {
  const copy = COPY[state];
  return (
    <div className={cn("ai-receptionist-status-panel rounded-xl border border-border/60 bg-card/50", compact ? "p-3" : "p-4")}>
      <div className="flex gap-3">
        <div className={cn("mt-0.5 shrink-0", copy.tone)}><StatusIcon state={state} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">{copy.title}</p>
            {onRefresh && state !== "syncing" && state !== "unavailable" && (
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={onRefresh}>
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </Button>
            )}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{copy.description}</p>
          <p className="mt-2 text-[11px] text-muted-foreground/80">{formatSyncTime(lastSuccessfulSyncAt)}</p>
        </div>
      </div>
    </div>
  );
}
