import React, { useCallback, useEffect, useState } from "react";
import { Bot, CheckCircle2, CircleOff, Loader2 } from "lucide-react";
import { cn } from "../lib/utils";

interface RuntimeStatus {
  available: boolean;
  mode?: string;
  agent?: { enabled: boolean; running: boolean; state: string; message?: string };
}

export default function AIReceptionistStatus({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus((await window.electronAPI?.aiReceptionistGetStatus?.()) ?? { available: false });
    } catch {
      setStatus({ available: false });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const available = status?.available === true;
  const running = status?.agent?.running === true;
  const label = !status ? "Checking AIReceptionist" : running ? "AI Receptionist is active" : available ? "AIReceptionist is ready" : "AIReceptionist is unavailable";
  const description = !status
    ? "Checking the private local runtime."
    : running
      ? "The local receptionist service is running on this computer."
      : available
        ? "Its private runtime and managed calendar configuration are available."
        : "This build does not currently have an available AIReceptionist runtime.";

  return (
    <div className={cn("ai-receptionist-status-panel rounded-xl border border-border/60 bg-card/50", compact ? "p-3" : "p-4")}>
      <div className="flex gap-3">
        <div className={cn("mt-0.5 shrink-0", available ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
          {!status ? <Loader2 className="h-4 w-4 animate-spin" /> : available ? <CheckCircle2 className="h-4 w-4" /> : <CircleOff className="h-4 w-4" />}
        </div>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium"><Bot className="h-3.5 w-3.5" />{label}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
    </div>
  );
}
