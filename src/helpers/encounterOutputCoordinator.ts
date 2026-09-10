import type {
  EncounterOutput,
  LocalEncounter,
  NoteItem,
} from "../types/electron";
import {
  generateClinicalOutputs,
  type ClinicalGenerationProgress,
  type ClinicalOutputsResult,
} from "./clinicalOutputGeneration";
import {
  runEncounterOutputGeneration,
  type EncounterOutputGenerationBridge,
} from "./encounterOutputGeneration";
import logger from "../utils/logger";

interface CoordinatorBridge extends EncounterOutputGenerationBridge {
  getEncounterByNote?: (noteId: number) => Promise<{
    success?: boolean;
    encounter: LocalEncounter | null;
  }>;
  getEncounterOutput?: (encounterId: number) => Promise<{
    success?: boolean;
    output: EncounterOutput | null;
  }>;
  getEncountersNeedingOutputGeneration?: (limit?: number) => Promise<{
    success?: boolean;
    encounters?: LocalEncounter[];
  }>;
  onEncounterRecordingSaved?: (
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
  generate?: (
    transcript: string,
    options?: {
      onProgress?: (progress: ClinicalGenerationProgress) => void;
      queuePriority?: number;
    }
  ) => Promise<ClinicalOutputsResult>;
  debounceMs?: number;
}

function needsGeneration(output: EncounterOutput | null): boolean {
  if (!output) return true;
  if (output.generation_phase === "retrying") return true;
  return [output.summary_status, output.soap_status, output.focus_status].some(
    (status) => status === "pending" || status === "stale"
  );
}

type QueueEntry = { encounterId: number; priority: number; sequence: number; queuedAt: number };

const RECONCILE_INTERVAL_MS = 30_000;

export function createEncounterOutputCoordinator({
  bridge,
  generate = generateClinicalOutputs,
  debounceMs = 250,
}: EncounterOutputCoordinatorOptions) {
  const queued = new Set<number>();
  const inFlight = new Map<number, { priority: number }>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const queue: QueueEntry[] = [];
  let disposed = false;
  let draining = false;
  let reconciling = false;
  let sequence = 0;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  const cleanups: Array<() => void> = [];

  const clearTimer = (encounterId: number) => {
    const timer = timers.get(encounterId);
    if (timer) clearTimeout(timer);
    timers.delete(encounterId);
  };

  const runEntry = async (entry: QueueEntry) => {
    const encounterId = entry.encounterId;
    void logger.logReasoning("CLINICAL_OUTPUT_QUEUE_START", {
      encounterId,
      queueWaitMs: Math.max(0, Date.now() - entry.queuedAt),
    });
    inFlight.set(encounterId, { priority: entry.priority });
    try {
      const current = await bridge.getEncounterOutput?.(encounterId);
      if (current?.success !== false && needsGeneration(current?.output ?? null)) {
        const result = await runEncounterOutputGeneration(
          bridge,
          encounterId,
          false,
          generate,
          undefined,
          undefined,
          -20 + Math.max(0, entry.priority) * 5
        );
        if (result.status === "superseded" && needsGeneration(result.output)) {
          enqueue(encounterId, { priority: 2 });
        } else if (result.retryAt) {
          const delay = Math.max(0, Date.parse(result.retryAt) - Date.now());
          const attempt = Number(result.output?.generation_attempt) || 0;
          void logger.logReasoning("CLINICAL_OUTPUT_RETRY_SCHEDULED", {
            encounterId,
            attempt,
            retryCount: Math.max(0, attempt - 1),
            delayMs: delay,
            safeErrorCode: result.output?.generation_last_error_code ?? null,
          });
          enqueue(encounterId, { priority: 2, delayMs: delay });
        }
        void logger.logReasoning("CLINICAL_OUTPUT_ATTEMPT", {
          encounterId,
          attempt: Number(result.output?.generation_attempt) || 0,
          status: result.status,
          retryable: Boolean(result.retryable),
          safeErrorCode: result.output?.generation_last_error_code ?? null,
        });
      }
    } catch {
      // Failed output is persisted by the guarded runner when possible and
      // remains available for an explicit user retry.
    } finally {
      inFlight.delete(encounterId);
      void drain();
    }
  };

  const drain = async () => {
    if (draining || disposed) return;
    draining = true;
    try {
      while (!disposed && queue.length > 0) {
        queue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
        const next = queue[0];
        const activePriorities = [...inFlight.values()].map((job) => job.priority);
        const highestActive = activePriorities.length ? Math.max(...activePriorities) : -Infinity;
        // Keep one ordinary orchestration active. A newly finished/current
        // encounter may cooperatively preempt it between local model requests,
        // but never fan out an entire historical backlog.
        if (inFlight.size > 0 && (inFlight.size >= 2 || next.priority <= highestActive)) break;
        const entry = queue.shift()!;
        queued.delete(entry.encounterId);
        if (inFlight.has(entry.encounterId)) continue;
        void runEntry(entry);
      }
    } finally {
      draining = false;
    }
  };

  function enqueue(
    encounterId: number | null | undefined,
    options: { priority?: number; delayMs?: number } = {}
  ) {
    if (disposed || !Number.isInteger(encounterId) || encounterId <= 0) return;
    clearTimer(encounterId);
    const priority = Number.isFinite(options.priority) ? Number(options.priority) : 0;
    const delayMs = options.delayMs == null ? debounceMs : Math.max(0, options.delayMs);
    if (delayMs > 0) {
      const timer = setTimeout(() => enqueue(encounterId, { priority }), delayMs);
      timers.set(encounterId, timer);
      return;
    }
    if (queued.has(encounterId) || inFlight.has(encounterId)) return;
    queued.add(encounterId);
    queue.push({ encounterId, priority, sequence: sequence++, queuedAt: Date.now() });
    void drain();
  }

  async function resolveEncounterForNote(noteId: number) {
    const result = await bridge.getEncounterByNote?.(noteId);
    const encounter = result?.encounter ?? null;
    if (encounter?.lifecycle_state === "completed") enqueue(encounter.id, { priority: 2 });
  }

  async function reconcile() {
    // This endpoint is already filtered to active/completed encounters with
    // missing or stale outputs. Do not apply the appointment-list window here:
    // a large scheduled backlog must not hide older clinical work.
    if (reconciling) return;
    reconciling = true;
    try {
      const result = await bridge.getEncountersNeedingOutputGeneration?.();
      for (const encounter of result?.encounters ?? []) {
        if (
          (encounter.lifecycle_state === "in_progress" || encounter.lifecycle_state === "completed") &&
          encounter.note_id
        ) {
          enqueue(encounter.id, { priority: 0 });
        }
      }
    } catch {
      void logger.logReasoning("CLINICAL_OUTPUT_RECONCILE_FAILED", {
        safeErrorCode: "ENCOUNTER_OUTPUT_UNAVAILABLE",
      });
    } finally {
      reconciling = false;
    }
  }

  function start() {
    if (bridge.onEncounterRecordingSaved) {
      cleanups.push(
        bridge.onEncounterRecordingSaved((payload) => enqueue(payload.encounterId, { priority: 2 }))
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
        bridge.onEncounterOutputRetryRequested((payload) => enqueue(payload.encounterId, { priority: 2 }))
      );
    }
    void reconcile();
    reconcileTimer = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
    return stop;
  }

  function stop() {
    disposed = true;
    if (reconcileTimer) clearInterval(reconcileTimer);
    reconcileTimer = null;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const cleanup of cleanups.splice(0)) cleanup();
    queue.length = 0;
    queued.clear();
  }

  return { start, stop, enqueue };
}
