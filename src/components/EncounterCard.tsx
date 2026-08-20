import { useMemo } from "react";
import { CalendarClock, CheckCircle2, CircleAlert, Clock3, Loader2, MapPin, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LocalEncounter } from "../types/electron";
import { Button } from "./ui/button";
import { cn } from "./lib/utils";

export interface EncounterCardProps {
  encounter: LocalEncounter;
  compact?: boolean;
  cached?: boolean;
  isStarting?: boolean;
  onStart: (encounter: LocalEncounter) => void | Promise<void>;
  onOpen: (encounter: LocalEncounter) => void | Promise<void>;
}

function formatEncounterDate(startTime: string | null, language: string): string {
  if (!startTime) return "—";
  const date = new Date(startTime);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(language, { weekday: "short", month: "short", day: "numeric" });
}

function formatEncounterTime(startTime: string | null, endTime: string | null, language: string): string {
  if (!startTime) return "—";
  const start = new Date(startTime);
  if (Number.isNaN(start.getTime())) return "—";
  const format = (date: Date) => date.toLocaleTimeString(language, { hour: "numeric", minute: "2-digit" });
  const end = endTime ? new Date(endTime) : null;
  return end && !Number.isNaN(end.getTime()) ? `${format(start)} – ${format(end)}` : format(start);
}

function statusIcon(state: LocalEncounter["lifecycle_state"]) {
  if (state === "in_progress") return Clock3;
  if (state === "completed") return CheckCircle2;
  if (state === "cancelled") return CircleAlert;
  return CalendarClock;
}

function hasLinkedPatientFolder(encounter: LocalEncounter): boolean {
  return (
    encounter.patient_id !== null &&
    (encounter.patient_resolution === "created" || encounter.patient_resolution === "matched")
  ) || (
    encounter.patient_profile_id !== null &&
    (encounter.patient_resolution === "created" || encounter.patient_resolution === "matched")
  );
}

export default function EncounterCard({
  encounter,
  compact = false,
  cached = false,
  isStarting = false,
  onStart,
  onOpen,
}: EncounterCardProps) {
  const { t, i18n } = useTranslation();
  const Icon = statusIcon(encounter.lifecycle_state);
  const patientReady = hasLinkedPatientFolder(encounter);
  const canStart = Boolean(encounter.calendar_event_id) && patientReady &&
    (encounter.lifecycle_state === "scheduled" || encounter.lifecycle_state === "in_progress");
  const canOpen =
    (encounter.lifecycle_state === "in_progress" || encounter.lifecycle_state === "completed") &&
    encounter.note_id != null;
  const patientState = patientReady ? "linked" : "review";
  const patientStateLabel = patientState === "linked"
    ? t("encounters.patient.linked")
    : t("encounters.patient.detailsRequired");
  const attendeeLabel = useMemo(() => {
    if (encounter.attendees_count <= 0) return null;
    return t("encounters.attendees", { count: encounter.attendees_count });
  }, [encounter.attendees_count, t]);

  return (
    <article
      className={cn(
        "encounter-card mx-auto w-full max-w-6xl rounded-xl border border-transparent bg-transparent p-4 shadow-sm transition-colors",
        encounter.lifecycle_state === "in_progress" && "encounter-card--in-progress",
        encounter.lifecycle_state === "cancelled" && "opacity-70",
        compact && "rounded-lg p-3 shadow-none"
      )}
      data-testid="encounter-card"
      data-state={encounter.lifecycle_state}
    >
      <div className={cn("flex items-start gap-3", compact && "xl:flex-col")}>
        <div className={cn(
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground",
          encounter.lifecycle_state === "in_progress" && "bg-primary/10 text-primary",
          encounter.lifecycle_state === "completed" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
          encounter.lifecycle_state === "cancelled" && "bg-amber-500/10 text-amber-600 dark:text-amber-400"
        )}>
          <Icon size={compact ? 15 : 17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">
              {encounter.title || t("encounters.untitled")}
            </h3>
            {cached && (
              <span className="shrink-0 rounded-full border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">{t("encounters.cached")}</span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{formatEncounterDate(encounter.start_time, i18n.language)}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{formatEncounterTime(encounter.start_time, encounter.end_time, i18n.language)}</span>
            {attendeeLabel && <span className="inline-flex items-center gap-1"><Users size={12} />{attendeeLabel}</span>}
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            {encounter.lifecycle_state === "in_progress" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />}
            <span>{t(`encounters.status.${encounter.lifecycle_state}`)}</span>
            <span className="inline-flex items-center gap-1 text-muted-foreground/80"><MapPin size={11} />{t("encounters.context.inPerson")}</span>
          </div>
          <div
            className="mt-1 text-[11px] text-muted-foreground"
            data-testid="encounter-patient-state"
            data-state={patientState}
          >
            {patientStateLabel}
          </div>
          {!patientReady && encounter.lifecycle_state === "scheduled" && (
            <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
              Use the calendar title for the patient name and add DOB as MM/DD/YYYY in the description. New patients also need Phone and Email before starting.
            </p>
          )}
        </div>
        {canStart && (
          <div className={cn("ml-auto shrink-0 self-center", compact && "xl:ml-0 xl:mt-2 xl:flex xl:w-full xl:justify-end xl:self-auto")}>
          <Button size="sm" className="h-8 px-4 text-xs" onClick={() => onStart(encounter)} disabled={isStarting}>
            {isStarting ? <Loader2 size={13} className="animate-spin" /> : <MapPin size={13} />}
            {isStarting ? t("encounters.starting") : t("encounters.startEncounter")}
          </Button>
          </div>
        )}
      </div>

      {canOpen && <Button size="sm" variant="outline" className="mt-3 h-8 w-full text-xs" onClick={() => onOpen(encounter)}>{t("encounters.openNote")}</Button>}
    </article>
  );
}
