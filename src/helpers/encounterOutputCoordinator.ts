import type { EncounterOutput, LocalEncounter, NoteItem } from "../types/electron";
import { generateClinicalOutputs, type ClinicalOutputsResult } from "./clinicalOutputGeneration";
import {
  runEncounterOutputGeneration,
  type EncounterOutputGenerationBridge,
} from "./encounterOutputGeneration";

interface CoordinatorBridge extends EncounterOutputGenerationBridge {
  getEncounterOutput?: (encounterId: number) => Promise<{
    success?: boolean;
    output: EncounterOutput | null;
  }>;
  getEncounters?: (limit?: number) => Promise<{
    success?: boolean;
    encounters?: LocalEncounter[];
  }>;
  onEncounterRecordingCompleted?: (
    callback: (payload: {
      encounterId?: number | null;
      noteId?: number | null;
      transcriptRevision?: number;
    }) => void
  ) => () => void;
  onNoteUpdated?: (callback: (note: NoteItem) => void) => () => void;
  onEncounterOutputRetryRequested?: (
    callback: (payload: { encounterId?: number | null }) => void
  ) => () => void;
}

export interface EncounterOutputCoordinatorOptions {
  bridge: CoordinatorBridge;
  generate?: (transcript: string) => Promise<ClinicalOutputsResult>;
  debounceMs?: number;
}

function needsGeneration(output: EncounterOutput | null): boolean {
  if (!output) return true;
  return [output.summary_status, output.soap_status, output.focus_status].some(
    (status) => status === "pending" || status === "stale"
  );
}

export function createEncounterOutputCoordinator({
  bridge,
  generate = generateClinicalOutputs,
  debounceMs = 250,
}: EncounterOutputCoordinatorOptions) {
  const queued = new Set<number>();
  const inFlight = new Set<number>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const queue: number[] = [];
  let disposed = false;
  let draining = false;
  const cleanups: Array<() => void> = [];

  const clearTimer = (encounterId: number) => {
    const timer = timers.get(encounterId);
    if (timer) clearTimeout(timer);
    timers.delete(encounterId);
  };

  const drain = async () => {
    if (draining || disposed) return;
    draining = true;
    try {
      while (!disposed && queue.length > 0) {
        const encounterId = queue.shift();
        if (encounterId == null) continue;
        queued.delete(encounterId);
        if (inFlight.has(encounterId)) continue;
        inFlight.add(encounterId);
        try {
          const current = await bridge.getEncounterOutput?.(encounterId);
          if (current?.success !== false && needsGeneration(current?.output ?? null)) {
            const result = await runEncounterOutputGeneration(bridge, encounterId, false, generate);
            if (result.status === "superseded" && needsGeneration(result.output)) {
              enqueue(encounterId);
            }
          }
        } catch {
          // Failed output is persisted by the guarded runner when possible and
          // remains available for an explicit user retry.
        } finally {
          inFlight.delete(encounterId);
        }
      }
    } finally {
      draining = false;
    }
  };

  function enqueue(encounterId: number | null | undefined, delayed = false) {
    if (disposed || !Number.isInteger(encounterId) || encounterId <= 0) return;
    clearTimer(encounterId);
    if (delayed) {
      const timer = setTimeout(() => enqueue(encounterId), debounceMs);
      timers.set(encounterId, timer);
      return;
    }
    if (queued.has(encounterId) || inFlight.has(encounterId)) return;
    queued.add(encounterId);
    queue.push(encounterId);
    void drain();
  }

  async function resolveEncounterForNote(noteId: number) {
    const result = await bridge.getEncounters?.(200);
    const encounter = (result?.encounters ?? []).find((candidate) => candidate.note_id === noteId);
    if (encounter?.lifecycle_state === "completed") enqueue(encounter.id, true);
  }

  async function reconcile() {
    const result = await bridge.getEncounters?.(200);
    for (const encounter of result?.encounters ?? []) {
      if (encounter.lifecycle_state !== "completed" || !encounter.note_id) continue;
      const output = await bridge.getEncounterOutput?.(encounter.id);
      if (output?.success !== false && needsGeneration(output?.output ?? null)) {
        enqueue(encounter.id);
      }
    }
  }

  function start() {
    if (bridge.onEncounterRecordingCompleted) {
      cleanups.push(
        bridge.onEncounterRecordingCompleted((payload) => enqueue(payload.encounterId, true))
      );
    }
    if (bridge.onNoteUpdated) {
      cleanups.push(
        bridge.onNoteUpdated((note) => {
          if (note?.note_type === "meeting" && note.id) void resolveEncounterForNote(note.id);
        })
      );
    }
    if (bridge.onEncounterOutputRetryRequested) {
      cleanups.push(
        bridge.onEncounterOutputRetryRequested((payload) => enqueue(payload.encounterId))
      );
    }
    void reconcile();
    return stop;
  }

  function stop() {
    disposed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const cleanup of cleanups.splice(0)) cleanup();
    queue.length = 0;
    queued.clear();
  }

  return { start, stop, enqueue };
}
