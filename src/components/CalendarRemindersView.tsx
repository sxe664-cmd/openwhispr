import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  CalendarRange,
  Check,
  CheckCircle2,
  Clock3,
  Loader2,
  Mail,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
  Users,
} from "lucide-react";
import type { CalendarEvent } from "../types/calendar";
import {
  calendarDateKey,
  shiftCalendarDate,
  useCalendarEvents,
  type CalendarLoadState,
  type CalendarView,
} from "../hooks/useCalendarEvents";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "./lib/utils";

const VIEW_LABELS: Record<CalendarView, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
};

type AppointmentActionState =
  | "idle"
  | "sending_email"
  | "sending_sms"
  | "success"
  | "error";

function formatDate(value: Date) {
  return value.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(value: string, allDay = false) {
  if (allDay) return "All day";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time unavailable"
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatAppointmentTime(event: CalendarEvent) {
  if (event.allDay) return "All day";
  return `${formatTime(event.startTime)} - ${formatTime(event.endTime)}`;
}

function eventKey(event: CalendarEvent) {
  return event.occurrenceId || `${event.calendarId}:${event.eventId}:${event.startTime}`;
}

function actionErrorMessage(result: { error?: { message?: string } } | null | undefined) {
  return result?.error?.message || "The reminder could not be sent. Try again when AIReceptionist is available.";
}

function stateMessage(state: CalendarLoadState) {
  switch (state) {
    case "setup_required":
      return {
        title: "Google Calendar setup required",
        description: "Complete Google Calendar setup in the private AIReceptionist runtime to browse appointments.",
        tone: "amber",
      };
    case "authorization_required":
      return {
        title: "Google Calendar authorization required",
        description: "Reconnect Google Calendar from AI Receptionist settings before sending appointment reminders.",
        tone: "amber",
      };
    case "unavailable":
      return {
        title: "AIReceptionist is unavailable",
        description: "This build does not include the managed calendar runtime. Local encounter functionality remains available on Home.",
        tone: "muted",
      };
    case "error":
      return {
        title: "Calendar could not be loaded",
        description: "The managed calendar returned an error. Try refresh; cached appointments remain visible when available.",
        tone: "red",
      };
    case "stale":
      return {
        title: "Showing cached calendar data",
        description: "The latest refresh failed, but the last successful appointment window is still visible.",
        tone: "amber",
      };
    default:
      return null;
  }
}

interface AppointmentCardProps {
  event: CalendarEvent;
  cached: boolean;
  actionState: AppointmentActionState;
  sentChannels: Set<string>;
  onSend: (event: CalendarEvent, channel: "email" | "sms") => void;
}

/**
 * Appointment card ported from AIReceptionist's appointment list.
 * Calendar & Reminders intentionally owns reminder actions only; encounter
 * lifecycle controls belong on Home.
 */
function AppointmentCard({ event, cached, actionState, sentChannels, onSend }: AppointmentCardProps) {
  const key = eventKey(event);
  const attendeeEmail = event.attendees.find((attendee) => attendee.email)?.email || "";
  const emailReady = Boolean(attendeeEmail) && event.capabilities.canSendEmail;
  const smsReady = event.capabilities.canSendSms;
  const emailUsed = sentChannels.has(`${key}:email`);
  const smsUsed = sentChannels.has(`${key}:sms`);
  const cancelled = event.status === "cancelled";

  return (
    <article
      className={cn("appointment-card", cancelled && "appointment-card--cancelled")}
      data-testid="calendar-event-card"
      data-event-id={event.eventId}
    >
      <div className="appointment-card__copy">
        <div className="flex items-center gap-2">
          <strong className="truncate">{event.summary}</strong>
          {cached && <span className="appointment-card__badge">Cached</span>}
        </div>
        <small className="appointment-card__metadata">
          <span className="appointment-card__time"><Clock3 size={12} />{formatAppointmentTime(event)}</span>
          <span className="appointment-card__metadata-separator" aria-hidden="true">&middot;</span>
          <span className={cn("appointment-card__recipient", !attendeeEmail && "appointment-card__recipient--missing")}>
            {attendeeEmail ? <><Users size={12} />{attendeeEmail}</> : <><Mail size={12} />No email on event</>}
          </span>
        </small>
        {cancelled && <small className="appointment-card__cancelled-label">Cancelled</small>}
      </div>
      <div className="appointment-card__controls">
        <div className="appointment-actions" aria-label="Appointment contact actions">
          <button
            type="button"
            className={cn("appointment-action--sms", smsUsed ? "is-used" : "is-ready", !smsReady && "is-disabled")}
            onClick={() => onSend(event, "sms")}
            disabled={!smsReady || smsUsed || actionState === "sending_sms"}
            aria-label={smsReady ? "Send SMS" : "SMS unavailable"}
            title={smsReady ? "Send SMS" : "SMS unavailable: no eligible opted-in contact"}
          >
            <MessageSquare className="appointment-action__icon" size={17} />
          </button>
          <button
            type="button"
            className={cn("appointment-action--email", emailUsed ? "is-used" : "is-ready", !emailReady && "is-disabled")}
            onClick={() => onSend(event, "email")}
            disabled={!emailReady || emailUsed || actionState === "sending_email"}
            aria-label={emailReady ? "Send email" : "Email unavailable"}
            title={emailReady ? "Send email" : "Email unavailable: no attendee email"}
          >
            <Mail className="appointment-action__icon" size={17} />
          </button>
        </div>
      </div>
      {actionState === "success" && (
        <p className="appointment-card__feedback appointment-card__feedback--success"><Check size={13} />Reminder sent.</p>
      )}
      {actionState === "error" && (
        <p className="appointment-card__feedback appointment-card__feedback--error"><AlertCircle size={13} />Reminder failed; the appointment was kept.</p>
      )}
    </article>
  );
}

export default function CalendarRemindersView({ embedded = false }: { embedded?: boolean }) {
  const [view, setView] = useState<CalendarView>("day");
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [expanded, setExpanded] = useState(false);
  const [actionStates, setActionStates] = useState<Record<string, AppointmentActionState>>({});
  const [sentChannels, setSentChannels] = useState<Set<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const calendar = useCalendarEvents(selectedDate, view);
  const message = stateMessage(calendar.state);
  const cached = calendar.state === "stale";

  useEffect(() => {
    setExpanded(false);
  }, [calendar.range.request.startIso, calendar.range.request.endIso]);

  useEffect(() => {
    let active = true;
    const loadReminderStatuses = async () => {
      const getStatuses = window.electronAPI?.getAppointmentReminderStatuses;
      if (!getStatuses || calendar.events.length === 0) return;
      let result;
      try {
        result = await getStatuses(calendar.events.map((event) => event.occurrenceId));
      } catch {
        return;
      }
      if (!active || !result?.success) return;
      const persisted = new Set<string>();
      const statuses: Record<string, { email: boolean; sms: boolean }> = result.statuses || {};
      Object.entries(statuses).forEach(([key, status]) => {
        if (status.email) persisted.add(`${key}:email`);
        if (status.sms) persisted.add(`${key}:sms`);
      });
      setSentChannels(persisted);
    };
    void loadReminderStatuses();
    return () => {
      active = false;
    };
  }, [calendar.events]);

  const move = useCallback((direction: number) => {
    setSelectedDate((date) => shiftCalendarDate(date, view, direction));
  }, [view]);

  const handleSend = useCallback(async (event: CalendarEvent, channel: "email" | "sms") => {
    const key = `${eventKey(event)}:${channel}`;

    const pending = channel === "email" ? "sending_email" : "sending_sms";
    setActionStates((current) => ({ ...current, [eventKey(event)]: pending }));
    setActionError(null);
    try {
      const result = channel === "email"
        ? await window.electronAPI?.sendAppointmentEmail?.(event.occurrenceId)
        : await window.electronAPI?.sendAppointmentSms?.(event.occurrenceId);
      if (!result?.success) throw new Error(actionErrorMessage(result));
      setSentChannels((current) => new Set(current).add(key));
      setActionStates((current) => ({ ...current, [eventKey(event)]: "success" }));
    } catch (error) {
      setActionStates((current) => ({ ...current, [eventKey(event)]: "error" }));
      setActionError(error instanceof Error ? error.message : "The reminder could not be sent.");
    }
  }, []);

  const visibleEvents = expanded ? calendar.events : calendar.events.slice(0, 5);

  return (
    <section className={cn("space-y-5", embedded ? "" : "mx-auto max-w-6xl px-5 py-6")} aria-labelledby="calendar-reminders-title">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2"><CalendarRange className="h-5 w-5 text-primary" /><h1 id="calendar-reminders-title" className="text-lg font-semibold tracking-tight">Calendar &amp; Reminders</h1></div>
          <p className="mt-1 text-sm text-muted-foreground">Browse appointments and send their calendar reminders.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void calendar.refresh()} disabled={calendar.isLoading || calendar.state === "unavailable"}><RefreshCw size={14} className={cn(calendar.isLoading && "animate-spin")} />Refresh</Button>
      </header>

      {message && <div className={cn("flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs", message.tone === "red" ? "border-destructive/25 bg-destructive/5 text-destructive" : message.tone === "amber" ? "border-amber-500/25 bg-amber-500/5 text-amber-700 dark:text-amber-300" : "border-border/60 bg-muted/30 text-muted-foreground")}><ShieldAlert size={14} className="mt-0.5 shrink-0" /><div><p className="font-medium">{message.title}</p><p className="mt-0.5 opacity-85">{message.description}</p>{calendar.lastSuccessfulSyncAt && <p className="mt-1 opacity-70">Last successful sync: {new Date(calendar.lastSuccessfulSyncAt).toLocaleString()}</p>}</div></div>}
      {actionError && <div className="flex items-center gap-2 rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-xs text-destructive"><AlertCircle size={14} />{actionError}</div>}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/60 p-2" aria-label="Calendar controls">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => move(-1)} aria-label="Previous period"><ArrowLeft size={15} /></Button>
          <Button variant="outline" size="sm" className="h-8" onClick={() => setSelectedDate(new Date())}>Today</Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => move(1)} aria-label="Next period"><ArrowRight size={15} /></Button>
          <Input
            aria-label="Select date"
            type="date"
            className="ml-1 h-8 w-[140px] text-xs"
            value={calendarDateKey(selectedDate)}
            onChange={(event) => {
              const [year, month, day] = event.target.value.split("-").map(Number);
              if (year && month && day) setSelectedDate(new Date(year, month - 1, day));
            }}
          />
        </div>
        <div className="flex rounded-lg bg-muted/60 p-0.5" role="tablist" aria-label="Calendar view">
          {(Object.keys(VIEW_LABELS) as CalendarView[]).map((item) => (
            <button key={item} type="button" role="tab" aria-selected={view === item} className={cn("rounded-md px-3 py-1.5 text-xs font-medium transition-colors", view === item ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")} onClick={() => setView(item)}>
              {VIEW_LABELS[item]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between"><h2 className="text-base font-semibold">{formatDate(selectedDate)}</h2><span className="text-xs text-muted-foreground">{calendar.isLoading ? "Loading..." : `${calendar.events.length} appointment${calendar.events.length === 1 ? "" : "s"}`}</span></div>
      {calendar.isLoading && calendar.events.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-border/60 bg-card/50 py-16 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin text-primary" />Loading calendar appointments...</div>
      ) : calendar.events.length === 0 && calendar.state !== "error" ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-card/30 px-6 py-16 text-center"><CheckCircle2 className="mx-auto h-8 w-8 text-muted-foreground/60" /><h3 className="mt-3 text-sm font-semibold">No appointments in this range</h3><p className="mt-1 text-xs text-muted-foreground">Choose another date or refresh the managed calendar.</p></div>
      ) : calendar.events.length === 0 ? (
        <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-6 py-16 text-center text-sm text-destructive">Calendar appointments could not be loaded. Try refresh again.</div>
      ) : (
        <div className="appointments-list">
          {visibleEvents.map((event) => <AppointmentCard key={eventKey(event)} event={event} cached={cached} actionState={actionStates[eventKey(event)] || "idle"} sentChannels={sentChannels} onSend={handleSend} />)}
          {calendar.events.length > 5 && <button type="button" className="appointments-show-more" onClick={() => setExpanded((current) => !current)}>{expanded ? "Show Less" : "Show More"}</button>}
        </div>
      )}
    </section>
  );
}
