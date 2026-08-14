import { Calendar, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LocalEncounter } from "../types/electron";
import EncounterCard from "./EncounterCard";

interface UpcomingMeetingsProps {
  encounters: LocalEncounter[];
  isLoading: boolean;
  cached?: boolean;
  startingId?: number | null;
  onStart: (encounter: LocalEncounter) => void | Promise<void>;
  onOpen: (encounter: LocalEncounter) => void | Promise<void>;
}
export default function UpcomingMeetings({ encounters, isLoading, cached = false, startingId = null, onStart, onOpen }: UpcomingMeetingsProps) {
  const { t } = useTranslation();
  return (
    <aside className="w-full">
      <div className="mb-3 flex items-center gap-1.5"><Calendar size={13} className="text-muted-foreground" /><span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("encounters.upcoming")}</span></div>
      {isLoading && encounters.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-border/50 py-8 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin text-primary" />{t("controlPanel.loading")}</div>
      ) : encounters.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 px-3 py-7 text-center text-xs text-muted-foreground">{t("encounters.noUpcoming")}</div>
      ) : (
        <div className="space-y-2">{encounters.map((encounter) => <EncounterCard key={encounter.id} encounter={encounter} compact cached={cached} isStarting={startingId === encounter.id} onStart={onStart} onOpen={onOpen} />)}</div>
      )}
    </aside>
  );
}
