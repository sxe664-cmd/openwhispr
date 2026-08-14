import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CalendarEvent } from "../types/calendar";
import type { CalendarRangeRequest } from "../types/electron";

export type CalendarView = "day" | "week" | "month";
export type CalendarLoadState =
  | "loading"
  | "ready"
  | "empty"
  | "stale"
  | "setup_required"
  | "authorization_required"
  | "unavailable"
  | "error";

export interface CalendarRange {
  start: Date;
  end: Date;
  request: CalendarRangeRequest;
}

export interface CalendarSnapshot {
  events: CalendarEvent[];
  state: CalendarLoadState;
  errorCode: string | null;
  lastSuccessfulSyncAt: string | null;
  isLoading: boolean;
  range: CalendarRange;
  refresh: () => Promise<void>;
}

function localStart(year: number, month: number, day: number) {
  return new Date(year, month, day);
}

function rangeForDate(date: Date, view: CalendarView): CalendarRange {
  const day = localStart(date.getFullYear(), date.getMonth(), date.getDate());
  let start = day;
  let end = localStart(date.getFullYear(), date.getMonth(), date.getDate() + 1);

  if (view === "week") {
    const mondayOffset = (day.getDay() + 6) % 7;
    start = localStart(date.getFullYear(), date.getMonth(), date.getDate() - mondayOffset);
    end = localStart(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  } else if (view === "month") {
    const monthStart = localStart(date.getFullYear(), date.getMonth(), 1);
    const visibleStart = ((monthStart.getDay() + 6) % 7);
    start = localStart(date.getFullYear(), date.getMonth(), 1 - visibleStart);
    end = localStart(start.getFullYear(), start.getMonth(), start.getDate() + 42);
  }

  return {
    start,
    end,
    request: {
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      limit: view === "month" ? 500 : 200,
    },
  };
}

function normalizeState(value: unknown, hasEvents: boolean): CalendarLoadState {
  if (value === "setup_required" || value === "authorization_required" || value === "unavailable" || value === "error") return value;
  if (value === "syncing" || value === "loading") return "loading";
  if (value === "stale") return hasEvents ? "stale" : "error";
  return hasEvents ? "ready" : "empty";
}

function errorCodeFrom(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const error = value as { code?: unknown };
  return typeof error.code === "string" ? error.code : null;
}

export function useCalendarEvents(selectedDate: Date, view: CalendarView): CalendarSnapshot {
  const range = useMemo(
    () => rangeForDate(selectedDate, view),
    [selectedDate, view]
  );
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [state, setState] = useState<CalendarLoadState>("loading");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [lastSuccessfulSyncAt, setLastSuccessfulSyncAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const eventsRef = useRef<CalendarEvent[]>([]);
  const requestIdRef = useRef(0);

  const load = useCallback(async (forceSync = false) => {
    const api = window.electronAPI;
    if (!api?.gcalListEvents || !api.gcalGetCalendarStatus) {
      setState("unavailable");
      setIsLoading(false);
      return;
    }
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    const statusPromise = api.gcalGetCalendarStatus().catch(() => null);
    void api.gcalGetCalendars?.();
    let keepLoadingForBackgroundRefresh = false;
    try {
      if (forceSync && api.gcalSyncEvents) await api.gcalSyncEvents(range.request);
      const result = await api.gcalListEvents(range.request);
      if (requestId !== requestIdRef.current) return;
      if (!result?.success) {
        setState(eventsRef.current.length > 0 ? "stale" : "error");
        setErrorCode(errorCodeFrom(result?.error) ?? "AI_RECEPTIONIST_COMMAND_FAILED");
        return;
      }
      const nextEvents = Array.isArray(result.events) ? result.events : [];
      eventsRef.current = nextEvents;
      setEvents(nextEvents);
      keepLoadingForBackgroundRefresh = Boolean(result.refreshing && nextEvents.length === 0);
      setState(
        result.refreshing
          ? nextEvents.length > 0
            ? "stale"
            : "loading"
          : normalizeState("ready", nextEvents.length > 0)
      );
      setErrorCode(null);
      setIsLoading(keepLoadingForBackgroundRefresh);

      const status = await statusPromise;
      if (requestId !== requestIdRef.current) return;
      const statusState = status?.state;
      setLastSuccessfulSyncAt(status?.lastSuccessfulSyncAt ?? null);
      setErrorCode(status?.error?.code ?? status?.errorCode ?? null);
      if (nextEvents.length === 0 && (statusState === "setup_required" || statusState === "authorization_required" || statusState === "unavailable")) {
        keepLoadingForBackgroundRefresh = false;
        setIsLoading(false);
        setState(statusState);
      } else if (!result.refreshing && statusState !== "syncing") {
        setState(normalizeState(statusState, nextEvents.length > 0));
      }
    } catch {
      if (requestId !== requestIdRef.current) return;
      setState(eventsRef.current.length > 0 ? "stale" : "error");
      setErrorCode("AI_RECEPTIONIST_COMMAND_FAILED");
    } finally {
      if (requestId === requestIdRef.current && !keepLoadingForBackgroundRefresh) setIsLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onGcalEventsSynced?.(() => {
      void load();
    });
    return unsubscribe;
  }, [load]);

  return { events, state, errorCode, lastSuccessfulSyncAt, isLoading, range, refresh: () => load(true) };
}

export function calendarDateKey(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function shiftCalendarDate(date: Date, view: CalendarView, direction: number) {
  const next = new Date(date);
  if (view === "day") next.setDate(next.getDate() + direction);
  else if (view === "week") next.setDate(next.getDate() + direction * 7);
  else next.setMonth(next.getMonth() + direction);
  return next;
}

export { rangeForDate };
