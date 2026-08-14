import { useCallback, useEffect, useState } from "react";
import type { LocalEncounter } from "../../types/electron";

export type ManagedCalendarState = "ready" | "syncing" | "stale" | "unavailable" | "error";

export interface ManagedCalendarSnapshot {
  state: ManagedCalendarState;
  lastSuccessfulSyncAt: string | null;
  errorCode: string | null;
  encounters: LocalEncounter[];
}

const EMPTY_SNAPSHOT: ManagedCalendarSnapshot = {
  state: "unavailable",
  lastSuccessfulSyncAt: null,
  errorCode: null,
  encounters: [],
};

function normalizeState(value: unknown): ManagedCalendarState {
  return value === "ready" || value === "syncing" || value === "stale" || value === "unavailable"
    ? value
    : "error";
}

/** Reads only the sidecar's allowlisted calendar health and local encounter cache. */
export function useManagedCalendar(encounterLimit = 24) {
  const [snapshot, setSnapshot] = useState<ManagedCalendarSnapshot>(EMPTY_SNAPSHOT);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.gcalGetConnectionStatus) {
      setSnapshot(EMPTY_SNAPSHOT);
      setIsLoading(false);
      return;
    }

    try {
      const [status, encounterResult] = await Promise.all([
        api.gcalGetConnectionStatus(),
        api.getEncounters?.(encounterLimit) ?? Promise.resolve({ success: true, encounters: [] }),
      ]);
      setSnapshot({
        state: normalizeState(status?.state),
        lastSuccessfulSyncAt: status?.lastSuccessfulSyncAt ?? null,
        errorCode: status?.error?.code ?? status?.errorCode ?? null,
        encounters: encounterResult.success ? encounterResult.encounters : [],
      });
    } catch {
      setSnapshot((current) => ({
        ...current,
        state: current.encounters.length > 0 ? "stale" : "error",
        errorCode: "AI_RECEPTIONIST_COMMAND_FAILED",
      }));
    } finally {
      setIsLoading(false);
    }
  }, [encounterLimit]);

  const refresh = useCallback(async () => {
    try {
      await window.electronAPI?.gcalSyncEvents?.();
    } finally {
      await load();
    }
  }, [load]);

  useEffect(() => {
    void load();
    const remove = window.electronAPI?.onGcalEventsSynced?.(() => void load());
    return () => remove?.();
  }, [load]);

  return { ...snapshot, isLoading, refresh };
}
