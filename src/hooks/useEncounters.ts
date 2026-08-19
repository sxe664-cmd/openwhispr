import { useCallback, useEffect, useRef, useState } from "react";
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
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error && typeof error === "object" && "message" in error
          ? String(error.message)
          : "Unable to load encounters";
  return message
    .replace(/[\r\n]+/g, " ")
    .slice(0, 240);
}

export function useEncounters(limit = 100): UseEncountersReturn {
  const [encounters, setEncounters] = useState<LocalEncounter[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [syncState, setSyncState] = useState<EncounterSyncState>("unavailable");
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const encountersRef = useRef<LocalEncounter[]>([]);

  const loadLocal = useCallback(async () => {
    const [encounterAttempt, statusAttempt] = await Promise.allSettled([
      window.electronAPI?.getEncountersForLocalDay?.(new Date().toISOString(), limit),
      window.electronAPI?.gcalGetConnectionStatus?.(),
    ]);

    const encounterResult = encounterAttempt.status === "fulfilled" ? encounterAttempt.value : null;
    const connectionStatus = statusAttempt.status === "fulfilled" ? statusAttempt.value : null;
    const connectionState = normalizeSyncState(connectionStatus?.state);
    const localReadFailed =
      encounterAttempt.status === "rejected"
      || encounterResult?.success !== true
      || !Array.isArray(encounterResult?.encounters);

    if (!localReadFailed) {
      const nextEncounters = encounterResult.encounters;
      encountersRef.current = nextEncounters;
      setEncounters(nextEncounters);
    }

    const localError =
      encounterAttempt.status === "rejected"
        ? encounterAttempt.reason
        : encounterResult?.error;
    const statusError = connectionStatus?.error?.message;
    if (localReadFailed || statusError) {
      setError(safeError(localError || statusError));
    } else {
      setError(null);
    }

    if (localReadFailed) {
      const failureState =
        connectionState === "ready"
          ? encountersRef.current.length > 0
            ? "stale"
            : "error"
          : connectionState;
      setSyncState(failureState);
    } else {
      setSyncState(connectionState);
    }
    setLastSyncedAt(connectionStatus?.lastSuccessfulSyncAt || connectionStatus?.lastSyncAt || null);
    setIsLoading(false);
  }, [limit]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      // A manual refresh also re-runs managed calendar ingestion. This lets a
      // registry edit repair encounters that were projected before the patient
      // record existed, while the sync listener below only reloads local data
      // to avoid a sync/broadcast loop.
      const syncResult = await window.electronAPI?.gcalSyncEvents?.();
      if (syncResult && syncResult.success !== true) {
        setError(safeError(syncResult.error));
        setSyncState((current) => {
          if (current === "ready") return encountersRef.current.length > 0 ? "stale" : "error";
          return current === "unavailable" ? "error" : current;
        });
      }
    } catch (syncError) {
      setError(safeError(syncError));
      setSyncState((current) => {
        if (current === "ready") return encountersRef.current.length > 0 ? "stale" : "error";
        return current === "unavailable" ? "error" : current;
      });
    } finally {
      await loadLocal();
    }
  }, [loadLocal]);

  useEffect(() => {
    void loadLocal();
  }, [loadLocal]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onGcalEventsSynced?.(() => {
      void loadLocal();
    });
    return () => unsubscribe?.();
  }, [loadLocal]);

  return { encounters, isLoading, syncState, lastSyncedAt, error, refresh };
}
