import { useCallback, useEffect, useState } from "react";
import type { LocalEncounter } from "../types/electron";

export type EncounterSyncState = "ready" | "syncing" | "stale" | "unavailable" | "error";

export interface UseEncountersReturn {
  encounters: LocalEncounter[];
  isLoading: boolean;
  syncState: EncounterSyncState;
  lastSyncedAt: string | null;
  error: string | null;
  refresh: () => Promise<void>;
}

function normalizeSyncState(value: unknown): EncounterSyncState {
  if (value === "ready" || value === "syncing" || value === "stale" || value === "error") {
    return value;
  }
  return "unavailable";
}

function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error || "Unable to load encounters")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 240);
}

export function useEncounters(limit = 100): UseEncountersReturn {
  const [encounters, setEncounters] = useState<LocalEncounter[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [syncState, setSyncState] = useState<EncounterSyncState>("unavailable");
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const [encounterResult, connectionStatus] = await Promise.all([
        window.electronAPI?.getEncountersForLocalDay?.(new Date().toISOString(), limit),
        window.electronAPI?.gcalGetConnectionStatus?.(),
      ]);

      if (encounterResult?.success && Array.isArray(encounterResult.encounters)) {
        setEncounters(encounterResult.encounters);
        setError(null);
      } else if (encounterResult?.error) {
        setError(safeError(encounterResult.error));
      }

      setSyncState(normalizeSyncState(connectionStatus?.state));
      setLastSyncedAt(connectionStatus?.lastSuccessfulSyncAt || connectionStatus?.lastSyncAt || null);
    } catch (loadError) {
      setError(safeError(loadError));
      setSyncState((current) => (current === "ready" ? "stale" : current === "unavailable" ? "error" : current));
    } finally {
      setIsLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onGcalEventsSynced?.(() => {
      void refresh();
    });
    return () => unsubscribe?.();
  }, [refresh]);

  return { encounters, isLoading, syncState, lastSyncedAt, error, refresh };
}
