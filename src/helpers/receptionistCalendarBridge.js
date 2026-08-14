const { broadcastToWindows } = require("./windowBroadcast");
const { PUBLIC_ERROR_MESSAGES, serializedError } = require("./aiReceptionistRuntime");
const {
  MAX_CALENDAR_ROWS,
  canonicalEventFromAppointment,
  canonicalEventFromRow,
  localDayRange,
  normalizeRange,
  redactSecrets,
} = require("./calendarContract");
const { parsePatientMetadata } = require("./patientIdentity");

const DEFAULT_SYNC_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_SYNC_TIMEOUT_MS = 90 * 1000;
const DEFAULT_FEED_LIMIT = 200;
const DEFAULT_SYNC_RANGE_DAYS = 31;
const CONFIG_CACHE_TTL_MS = 30 * 1000;
const PROVIDER = "ai_receptionist";

function publicSidecarError(error, fallbackCode = "AI_RECEPTIONIST_COMMAND_FAILED") {
  const candidate = error?.sidecarError || error?.error || error;
  return serializedError(candidate?.code || fallbackCode);
}

function sidecarFailure(error, fallbackCode) {
  const safe = publicSidecarError(error, fallbackCode);
  const failure = new Error(safe.message);
  failure.sidecarError = safe;
  return failure;
}

function encodePart(value) {
  return encodeURIComponent(String(value || "")).replace(/%/g, "_");
}

function occurrenceId(appointment) {
  return [
    PROVIDER,
    encodePart(appointment.calendar_id || "primary"),
    encodePart(appointment.event_id),
    encodePart(appointment.start_iso),
  ].join(":");
}

function occurrencePrefix(calendarId, eventId) {
  return [PROVIDER, encodePart(calendarId || "primary"), encodePart(eventId), ""].join(":");
}

function normalizeAttendees(appointment) {
  const emails = Array.isArray(appointment.attendee_emails)
    ? appointment.attendee_emails
    : Array.isArray(appointment.attendees)
      ? appointment.attendees
      : [];
  return emails
    .filter((email) => typeof email === "string" && email.trim())
    .map((email) => ({
      email: email.trim(),
      displayName: null,
      responseStatus: null,
      self: false,
    }));
}

function projectAppointment(appointment) {
  if (!appointment || typeof appointment !== "object") return null;
  if (!appointment.event_id || !appointment.start_iso || !appointment.end_iso) return null;

  const attendees = normalizeAttendees(appointment);
  return {
    id: occurrenceId(appointment),
    calendar_id: appointment.calendar_id || "primary",
    provider: PROVIDER,
    summary: appointment.summary || appointment.title || "Appointment",
    start_time: appointment.start_iso,
    end_time: appointment.end_iso,
    is_all_day: appointment.all_day ? 1 : 0,
    status: appointment.status || "confirmed",
    // The sidecar contract distinguishes a direct video conference from the
    // Google Calendar event page. Never promote the latter into a join URL.
    hangout_link: appointment.conference_url || null,
    html_link: appointment.html_link || null,
    conference_data: null,
    organizer_email: null,
    attendees_count: attendees.length,
    attendees: attendees.length > 0 ? JSON.stringify(attendees) : null,
  };
}

function projectCalendarRow(appointment) {
  const row = projectAppointment(appointment);
  if (!row) return null;
  const canonical = canonicalEventFromAppointment(appointment);
  return {
    ...row,
    event_id: canonical.eventId,
    event_uid: canonical.eventUid,
    occurrence_id: canonical.occurrenceId,
    timezone: canonical.timezone,
    recurrence: canonical.recurrence ? JSON.stringify(canonical.recurrence) : null,
    capabilities: JSON.stringify(canonical.capabilities),
  };
}

function normalizeSelfAttendeePresent(value) {
  return typeof value === "boolean" ? value : null;
}

// The bridge is the sole boundary that may read the sidecar's private
// structured-patient fields. Keep them in a separate object from the public
// calendar projection so they cannot be spread into renderer-facing payloads.
function projectCalendarIngress(appointment) {
  if (!appointment || typeof appointment !== "object") return null;
  const {
    patient_metadata: rawPatientMetadata,
    self_attendee_present: rawSelfAttendeePresent,
    ...sidecarPublic
  } = appointment;
  const publicEvent = projectCalendarRow(sidecarPublic);
  if (!publicEvent) return null;
  const { metadata: patientMetadata } = parsePatientMetadata(rawPatientMetadata);
  return {
    publicEvent,
    patientMetadata,
    selfAttendeePresent: normalizeSelfAttendeePresent(rawSelfAttendeePresent),
  };
}

function safeActionResult(result) {
  if (!result || typeof result !== "object") return result;
  const safe = { ...result };
  delete safe.stdout;
  delete safe.stderr;
  delete safe.raw;
  if (safe.error)
    safe.error = safe.error.code ? serializedError(safe.error.code) : serializedError();
  return redactSecrets(safe);
}

function validateConfigPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw Object.assign(new Error("invalid configuration"), {
      code: "AI_RECEPTIONIST_CONFIG_INVALID",
    });
  }
  const serialized = JSON.stringify(payload);
  if (!serialized || serialized.length > 256 * 1024) {
    throw Object.assign(new Error("configuration is too large"), {
      code: "AI_RECEPTIONIST_CONFIG_INVALID",
    });
  }
  return payload;
}

class ReceptionistCalendarBridge {
  constructor({
    runtime,
    databaseManager,
    reminderScheduler,
    syncIntervalMs = DEFAULT_SYNC_INTERVAL_MS,
    feedLimit = DEFAULT_FEED_LIMIT,
    logger = console,
    broadcast = broadcastToWindows,
  }) {
    this.runtime = runtime;
    this.databaseManager = databaseManager;
    this.reminderScheduler = reminderScheduler;
    this.syncIntervalMs = syncIntervalMs;
    this.feedLimit = feedLimit;
    this.logger = logger;
    this.broadcast = broadcast;
    this.timer = null;
    this.syncPromise = null;
    this.reminderPromise = null;
    // Background refreshes are single-flight. Renderer reads never enter this
    // queue: they read the local calendar projection and let this refresh run
    // in the background.
    this.feedQueue = Promise.resolve();
    this.status = {
      source: "ai-receptionist",
      managed: true,
      state: "unavailable",
      lastSyncAt: null,
      lastSuccessfulSyncAt: null,
      lastError: null,
      lastErrorCode: null,
      lastReminderRunAt: null,
      lastReminderError: null,
      lastReminderErrorCode: null,
      eventCount: 0,
    };
    this.configCache = new Map();
    this.configPromises = new Map();
    this.configSnapshot = null;
    this.configSnapshotAt = 0;
    this.configSnapshotPromise = null;
  }

  start() {
    this.stop();
    if (!this.runtime?.isAvailable?.()) {
      this.status = { ...this.status, state: "unavailable" };
      return;
    }

    this.status = { ...this.status, state: "syncing", lastError: null, lastErrorCode: null };
    // Paint today's encounters first. A complete reminder window follows in
    // the background so startup never makes the first calendar view wait on
    // months of synchronization work.
    this.sync(this._initialSyncRange()).then((result) => {
      if (result?.success && this.timer) this.sync(this._defaultSyncRange()).catch(() => {});
    }).catch(() => {});
    this.timer = setInterval(() => {
      this.sync().catch(() => {});
    }, this.syncIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus() {
    return { ...this.status };
  }

  async sync(range = null) {
    if (!this.runtime?.isAvailable?.()) {
      this.status = { ...this.status, state: "unavailable" };
      return { success: false, state: "unavailable", events: [] };
    }
    if (this.syncPromise) return this.syncPromise;
    const normalized = range
      ? normalizeRange({ ...range, limit: range.limit || this.feedLimit })
      : this._defaultSyncRange();
    const work = this._enqueueFeed(() => this._sync(normalized));
    this.syncPromise = work.then((result) => {
      this.syncPromise = null;
      this.broadcast("gcal-events-synced", {
        provider: PROVIDER,
        success: result?.success === true,
        eventCount: Array.isArray(result?.events) ? result.events.length : 0,
        errorCode: result?.error?.code || null,
      });
      return result;
    }).catch((error) => {
      this.syncPromise = null;
      const safe = publicSidecarError(error);
      this.broadcast("gcal-events-synced", {
        provider: PROVIDER,
        success: false,
        eventCount: 0,
        errorCode: safe.code,
      });
      throw error;
    });
    return this.syncPromise;
  }

  _enqueueFeed(task) {
    const queued = this.feedQueue.then(task, task);
    this.feedQueue = queued.catch(() => {});
    return queued;
  }

  async syncRange(range) {
    return this.sync(range);
  }

  _defaultSyncRange() {
    const day = localDayRange();
    const end = new Date(Date.parse(day.endIso) + DEFAULT_SYNC_RANGE_DAYS * 24 * 60 * 60 * 1000);
    return normalizeRange({
      startIso: day.startIso,
      endIso: end.toISOString(),
      limit: this.feedLimit,
    });
  }

  _initialSyncRange() {
    const day = localDayRange();
    return normalizeRange({
      startIso: day.startIso,
      endIso: day.endIso,
      limit: this.feedLimit,
    });
  }

  async _sync(range) {
    const now = new Date().toISOString();
    this.status = { ...this.status, state: "syncing", lastSyncAt: now };

    let appointments = [];
    let feedWindow = null;
    try {
      const result = await this._runJsonModule("receptionist.desktop_config", [
        "calendar-events",
        "--limit",
        String(range.limit),
        "--start-iso",
        range.startIso,
        "--end-iso",
        range.endIso,
      ]);
      const feedEvents = Array.isArray(result?.events) ? result.events : [];
      appointments = feedEvents;
      feedWindow = result?.window || null;
      for (const tombstone of result?.tombstones || []) {
        if (!tombstone?.event_id) continue;
        const calendarId = tombstone.calendar_id || "primary";
        const prefix = occurrencePrefix(tombstone.calendar_id, tombstone.event_id);
        // Keep a durable local cancellation record even after the corresponding
        // calendar cache row is pruned. A started encounter must retain its note.
        this.databaseManager.markEncountersCancelledByCalendarEventPrefix?.(
          PROVIDER,
          calendarId,
          prefix
        );
        this.databaseManager.removeCalendarEventsByPrefix?.(PROVIDER, calendarId, prefix);
      }
    } catch (error) {
      const safe = publicSidecarError(error);
      this.status = {
        ...this.status,
        state: "stale",
        lastError: safe.message,
        lastErrorCode: safe.code,
      };
      this.logger.warn?.("AIReceptionist calendar feed unavailable", {
        operation: "calendar-events",
        code: safe.code,
      });
      return { success: false, state: "stale", events: [], error: safe };
    }

    const envelopes = appointments.map(projectCalendarIngress).filter(Boolean);
    const projected = envelopes.map(({ publicEvent }) => publicEvent);
    if (envelopes.length > 0) {
      if (typeof this.databaseManager.upsertCalendarIngress === "function") {
        this.databaseManager.upsertCalendarIngress(envelopes);
      } else {
        // Compatibility for legacy in-memory test doubles: only the safe
        // public projection may reach the former calendar-upsert API.
        this.databaseManager.upsertCalendarEvents?.(projected);
      }
    }
    if (projected.length > 0) this.databaseManager.upsertEncountersFromCalendarEvents?.(projected);
    if (
      feedWindow?.complete === true &&
      feedWindow.start_iso &&
      feedWindow.end_iso &&
      this.databaseManager.reconcileStaleCalendarWindow
    ) {
      const byCalendar = new Map();
      for (const event of projected) {
        const current = byCalendar.get(event.calendar_id) || [];
        current.push(event.id);
        byCalendar.set(event.calendar_id, current);
      }
      const calendarIds =
        Array.isArray(feedWindow.calendar_ids) && feedWindow.calendar_ids.length > 0
          ? feedWindow.calendar_ids
          : [...byCalendar.keys()];
      for (const calendarId of calendarIds) {
        this.databaseManager.reconcileStaleCalendarWindow(
          PROVIDER,
          calendarId,
          byCalendar.get(calendarId) || [],
          feedWindow.start_iso,
          feedWindow.end_iso
        );
      }
    }

    this.reminderScheduler?.scheduleNextMeeting?.();
    this._scheduleReminderRefresh();
    this.status = {
      ...this.status,
      state: "ready",
      lastSuccessfulSyncAt: new Date().toISOString(),
      lastError: null,
      lastErrorCode: null,
      eventCount: projected.length,
    };
    return {
      success: true,
      state: this.status.state,
      events: projected,
    };
  }

  _scheduleReminderRefresh() {
    if (!this.runtime?.isAvailable?.() || this.reminderPromise) return this.reminderPromise;
    this.reminderPromise = (async () => {
      let reminderError = null;
      let reminderErrorCode = null;
      try {
        const syncResult = await this._runJsonModule("receptionist.desktop_config", [
          "reminders-sync",
          "--limit",
          String(this.feedLimit),
        ]);
        if (syncResult?.ok === false) {
          const safe = publicSidecarError(syncResult);
          reminderError = safe.message;
          reminderErrorCode = safe.code;
        }
        if (!reminderError) {
          const reminderResult = await this.runtime.runModule("receptionist.reminders", ["run-due"], {
            timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
          });
          if (!reminderResult?.ok) {
            const safe = publicSidecarError(reminderResult);
            reminderError = safe.message;
            reminderErrorCode = safe.code;
          }
        }
      } catch (error) {
        const safe = publicSidecarError(error);
        reminderError = safe.message;
        reminderErrorCode = safe.code;
      }
      if (reminderError) {
        this.logger.warn?.("AIReceptionist reminder delivery failed", {
          operation: "reminder-delivery",
          code: reminderErrorCode,
        });
      }
      this.status = {
        ...this.status,
        lastReminderRunAt: new Date().toISOString(),
        lastReminderError: reminderError,
        lastReminderErrorCode: reminderErrorCode,
      };
      this.broadcast("gcal-reminders-updated", {
        provider: PROVIDER,
        errorCode: reminderErrorCode,
      });
    })().finally(() => {
      this.reminderPromise = null;
    });
    return this.reminderPromise;
  }

  async waitForBackgroundWork() {
    if (this.reminderPromise) await this.reminderPromise;
  }

  async _runJsonModule(moduleName, args) {
    const result = await this.runtime.runModule(moduleName, args, {
      timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
    });
    if (!result?.ok) {
      throw sidecarFailure(result);
    }
    try {
      return JSON.parse(result.stdout || "{}");
    } catch {
      throw sidecarFailure(null, "AI_RECEPTIONIST_INVALID_RESPONSE");
    }
  }

  async getConnectionStatus() {
    const status = this.getStatus();
    return {
      connected: status.state === "ready" || status.state === "stale" || status.state === "syncing",
      accounts: [],
      email: null,
      source: PROVIDER,
      managed: true,
      state: status.state,
      lastSyncAt: status.lastSyncAt,
      lastSuccessfulSyncAt: status.lastSuccessfulSyncAt,
      error: status.lastErrorCode ? serializedError(status.lastErrorCode) : null,
      errorCode: status.lastErrorCode,
    };
  }

  async getCalendarStatus() {
    if (!this.runtime?.isAvailable?.()) {
      return {
        connected: false,
        state: "unavailable",
        managed: true,
        source: PROVIDER,
        error: serializedError("AI_RECEPTIONIST_UNAVAILABLE"),
      };
    }
    try {
      const result = await this._getConfigSnapshot();
      const calendar = result.calendar || {};
      const state =
        calendar.enabled !== true
          ? "setup_required"
          : calendar.oauth_token_set === true
            ? "ready"
            : "authorization_required";
      return {
        connected: state === "ready",
        managed: true,
        source: PROVIDER,
        state,
        email: null,
        lastSuccessfulSyncAt: this.status.lastSuccessfulSyncAt,
        error: null,
        errorCode: null,
      };
    } catch (error) {
      const safe = publicSidecarError(error, "AI_RECEPTIONIST_AUTH_STATUS_FAILED");
      return {
        connected: false,
        managed: true,
        source: PROVIDER,
        state: "error",
        error: safe,
        errorCode: safe.code,
      };
    }
  }

  getCalendars() {
    return [
      {
        id: "primary",
        summary: "AIReceptionist calendar",
        description: "Managed by the bundled AIReceptionist runtime.",
        background_color: null,
        is_selected: 1,
        is_primary: 1,
        sync_token: null,
        provider: PROVIDER,
      },
    ];
  }

  async connectGoogleCalendar() {
    if (!this.runtime?.isAvailable?.())
      return { success: false, error: serializedError("AI_RECEPTIONIST_UNAVAILABLE") };
    try {
      const result = await this.runtime.runPython(["-m", "receptionist.booking", "setup"], {
        timeoutMs: 10 * 60 * 1000,
      });
      if (!result?.ok) throw sidecarFailure(result, "AI_RECEPTIONIST_AUTH_SETUP_FAILED");
      this._invalidateConfigCache();
      return { success: true, managed: true };
    } catch (error) {
      return {
        success: false,
        error: publicSidecarError(error, "AI_RECEPTIONIST_AUTH_SETUP_FAILED"),
      };
    }
  }

  async startOAuth() {
    return this.connectGoogleCalendar();
  }

  disconnect() {
    return {
      success: false,
      managed: true,
      error: "Google Calendar credentials are managed by the private AIReceptionist build.",
    };
  }

  async setCalendarSelection() {
    return { success: true, managed: true };
  }

  async setPrimaryOnly() {
    return { success: true, managed: true };
  }

  async listCalendarEvents(range) {
    const normalized = normalizeRange({ ...range, limit: range?.limit || this.feedLimit });
    try {
      const rows = this.databaseManager?.getCalendarEventsInRange?.(
        normalized.startIso,
        normalized.endIso,
        normalized.limit,
        PROVIDER
      ) || [];
      const events = rows.map(canonicalEventFromRow).filter(Boolean);
      const lastAttemptAt = this.status.lastSyncAt ? Date.parse(this.status.lastSyncAt) : 0;
      const lastSuccessAt = this.status.lastSuccessfulSyncAt
        ? Date.parse(this.status.lastSuccessfulSyncAt)
        : 0;
      const lastRefreshAt = Math.max(lastAttemptAt || 0, lastSuccessAt || 0);
      const refreshDue = !lastRefreshAt || Date.now() - lastRefreshAt >= this.syncIntervalMs;
      if (refreshDue && !this.syncPromise) this.sync(normalized).catch(() => {});
      return {
        success: true,
        range: normalized,
        events,
        cached: true,
        refreshing: Boolean(this.syncPromise),
        tombstones: [],
        window: null,
      };
    } catch (error) {
      return { success: false, range: normalized, events: [], error: publicSidecarError(error) };
    }
  }

  _resolveEvent(eventId) {
    const row = this.databaseManager?.getCalendarEventById?.(eventId);
    return row ? canonicalEventFromRow(row) : null;
  }

  async getAppointmentActions(eventId) {
    const event = this._resolveEvent(eventId);
    if (!event)
      return { success: false, error: serializedError("AI_RECEPTIONIST_EVENT_NOT_FOUND") };
    return { success: true, eventId, actions: redactSecrets(event.capabilities) };
  }

  async getAppointmentReminderStatuses(eventIds = []) {
    const requestedIds = Array.isArray(eventIds) ? eventIds : [];
    const events = requestedIds
      .map((eventId) => {
        const event = this._resolveEvent(eventId);
        if (!event) return null;
        return {
          key: eventId,
          calendar_id: event.calendarId,
          event_id: event.eventId,
          event_uid: event.eventUid,
          start_iso: event.startTime,
        };
      })
      .filter(Boolean);
    if (events.length === 0) return { success: true, statuses: {} };
    try {
      const result = await this._runJsonModule("receptionist.desktop_config", [
        "reminder-status",
        "--events-json",
        JSON.stringify(events),
      ]);
      return { success: true, ...safeActionResult(result) };
    } catch (error) {
      return {
        success: false,
        error: publicSidecarError(error, "AI_RECEPTIONIST_REMINDER_STATUS_FAILED"),
      };
    }
  }

  async sendAppointmentEmail(eventId) {
    return this._runEventAction("appointment-email", eventId);
  }

  async sendAppointmentSms(eventId) {
    return this._runEventAction("appointment-sms", eventId);
  }

  async _runEventAction(command, eventId) {
    const event = this._resolveEvent(eventId);
    if (!event)
      return { success: false, error: serializedError("AI_RECEPTIONIST_EVENT_NOT_FOUND") };
    try {
      const args = [
        command === "appointment-email" ? "send-email" : "send-sms",
        "--event-id",
        event.eventId,
        "--event-uid",
        event.eventUid,
        "--calendar-id",
        event.calendarId,
      ];
      if (command === "appointment-email") {
        const attendeeEmail = event.attendees.find((attendee) => attendee.email)?.email;
        if (!attendeeEmail)
          return {
            success: false,
            eventId,
            error: serializedError("AI_RECEPTIONIST_EMAIL_NOT_ELIGIBLE"),
          };
        args.push(
          "--summary",
          event.summary,
          "--start-iso",
          event.startTime,
          "--end-iso",
          event.endTime,
          "--timezone",
          event.timezone,
          "--attendee-email",
          attendeeEmail
        );
      }
      const result = await this._runJsonModule("receptionist.desktop_config", args);
      return { success: true, eventId, ...safeActionResult(result) };
    } catch (error) {
      return {
        success: false,
        eventId,
        error: publicSidecarError(
          error,
          command === "appointment-sms"
            ? "AI_RECEPTIONIST_SMS_NOT_ELIGIBLE"
            : "AI_RECEPTIONIST_EMAIL_NOT_ELIGIBLE"
        ),
      };
    }
  }

  async renameAppointment({ calendarId = "primary", eventId, summary }) {
    const event = this._resolveEvent(eventId);
    if (!event)
      return { success: false, error: serializedError("AI_RECEPTIONIST_EVENT_NOT_FOUND") };
    return this._runMutation("appointment-rename", [
      "--calendar-id",
      event.calendarId || calendarId,
      "--event-id",
      event.eventId,
      "--summary",
      summary,
    ]);
  }

  async cancelAppointment({ calendarId = "primary", eventId, confirmed = false }) {
    const event = this._resolveEvent(eventId);
    if (!event)
      return { success: false, error: serializedError("AI_RECEPTIONIST_EVENT_NOT_FOUND") };
    const args = ["--calendar-id", event.calendarId || calendarId, "--event-id", event.eventId];
    if (confirmed) args.push("--confirmed");
    return this._runMutation("appointment-cancel", args);
  }

  async rescheduleAppointment({ eventId, newStartIso, confirmed = false }) {
    const event = this._resolveEvent(eventId);
    if (!event)
      return { success: false, error: serializedError("AI_RECEPTIONIST_EVENT_NOT_FOUND") };
    const start = new Date(newStartIso);
    if (Number.isNaN(start.getTime()))
      return { success: false, error: serializedError("AI_RECEPTIONIST_CONFIG_INVALID") };
    const args = [
      "--calendar-id",
      event.calendarId,
      "--event-id",
      event.eventId,
      "--start-iso",
      start.toISOString(),
    ];
    if (confirmed) args.push("--confirmed");
    return this._runMutation("appointment-reschedule", args);
  }

  async _getConfig(kind) {
    const cached = this.configCache.get(kind);
    if (cached && Date.now() - cached.createdAt < CONFIG_CACHE_TTL_MS) return cached.value;
    const existing = this.configPromises.get(kind);
    if (existing) return existing;

    const promise = this._loadConfig(kind).then((value) => {
      if (value?.success) this.configCache.set(kind, { createdAt: Date.now(), value });
      return value;
    }).finally(() => {
      this.configPromises.delete(kind);
    });
    this.configPromises.set(kind, promise);
    return promise;
  }

  async _getConfigSnapshot() {
    if (this.configSnapshot && Date.now() - this.configSnapshotAt < CONFIG_CACHE_TTL_MS) {
      return this.configSnapshot;
    }
    if (this.configSnapshotPromise) return this.configSnapshotPromise;
    this.configSnapshotPromise = this._runJsonModule("receptionist.desktop_config", ["get"])
      .then((snapshot) => {
        const config = snapshot?.config || snapshot || {};
        this.configSnapshot = config;
        this.configSnapshotAt = Date.now();
        return config;
      })
      .finally(() => {
        this.configSnapshotPromise = null;
      });
    return this.configSnapshotPromise;
  }

  _invalidateConfigCache() {
    this.configCache.clear();
    this.configSnapshot = null;
    this.configSnapshotAt = 0;
  }

  async _loadConfig(kind) {
    try {
      const result =
        kind === "email"
          ? await this._runJsonModule("receptionist.desktop_config", ["email-setup"])
          : { config: await this._getConfigSnapshot() };
      const full = result?.config || result;
      if (kind === "receptionist")
        return {
          success: true,
          config: redactSecrets({
            ...(full.receptionist || {}),
            name: full.business_name || full.name || "",
          }),
        };
      if (kind === "messages")
        return {
          success: true,
          config: redactSecrets({
            templates: full.message_templates || {},
            communications: full.communications || {},
            reminders: full.reminders || {},
          }),
        };
      if (kind === "postAppointment") {
        const workspace = await this._runJsonModule("receptionist.desktop_config", [
          "post-workspace",
        ]);
        return {
          success: true,
          config: redactSecrets({
            ...(full.reminders?.post_appointment || {}),
            templates: full.message_templates?.post_followups || {},
            all_templates: full.message_templates || {},
            communications: full.communications || {},
            workspace,
          }),
        };
      }
      return { success: true, config: redactSecrets(full) };
    } catch (error) {
      return { success: false, config: null, error: publicSidecarError(error) };
    }
  }

  async _saveConfig(kind, payload) {
    try {
      const config = validateConfigPayload(payload);
      const result = await this._runJsonModule(
        "receptionist.desktop_config",
        this._configSaveArgs(kind, config)
      );
      this._invalidateConfigCache();
      const reloaded = await this._getConfig(kind);
      if (!reloaded.success) return reloaded;
      return {
        success: true,
        config: reloaded.config,
        requiresRestart: result?.restart_required === true,
      };
    } catch (error) {
      return {
        success: false,
        config: null,
        error: publicSidecarError(error, error.code || "AI_RECEPTIONIST_CONFIG_SAVE_FAILED"),
      };
    }
  }

  _configSaveArgs(kind, config) {
    if (kind === "receptionist") {
      const parseObject = (value) => {
        if (value && typeof value === "object") return value;
        if (typeof value !== "string") return null;
        try {
          const parsed = JSON.parse(value);
          return parsed && typeof parsed === "object" ? parsed : null;
        } catch {
          return null;
        }
      };
      const parseLines = (value, transform) =>
        (Array.isArray(value) ? value : [])
          .map((item) => {
            if (typeof item !== "string") return item;
            return transform(item);
          })
          .filter(Boolean);
      const allowed = {
        name: config.name,
        greeting: config.greeting,
        after_hours_message: config.after_hours_message,
        description: config.description,
        services: Array.isArray(config.services) ? config.services : undefined,
        hours: parseObject(config.hours),
        faqs: Array.isArray(config.faqs)
          ? parseLines(config.faqs, (item) => parseObject(item) || { question: item, answer: "" })
          : undefined,
        routing: Array.isArray(config.routing)
          ? parseLines(config.routing, (item) => parseObject(item))
          : undefined,
        default_transfer_number: config.default_transfer_number,
        escalation_rules: Array.isArray(config.escalation_rules)
          ? config.escalation_rules
          : undefined,
        prohibited_claims: Array.isArray(config.prohibited_claims)
          ? config.prohibited_claims
          : undefined,
        idle: config.idle_timeout_seconds
          ? {
              ...(config.idle && typeof config.idle === "object" ? config.idle : {}),
              away_seconds: Number(config.idle_timeout_seconds),
            }
          : config.idle && typeof config.idle === "object"
            ? config.idle
            : undefined,
        recording_enabled: config.recording_enabled,
      };
      return [
        "receptionist-update",
        "--payload",
        JSON.stringify(
          Object.fromEntries(Object.entries(allowed).filter(([, value]) => value !== undefined))
        ),
      ];
    }
    if (kind === "email") {
      const args = ["email-update"];
      if (config.from !== undefined) args.push("--from-address", String(config.from || ""));
      if (config.smtp_username !== undefined)
        args.push("--smtp-username", String(config.smtp_username || ""));
      if (config.smtp_password !== undefined)
        args.push("--smtp-password", String(config.smtp_password || ""));
      return args;
    }
    const templates = config.templates || config.message_templates || {};
    const reminders = config.reminders || {};
    const post = config.post_appointment || config;
    const communications = config.communications || {};
    const args = ["update"];
    const add = (flag, value) => {
      if (value !== undefined && value !== null) args.push(flag, String(value));
    };
    add("--default-transfer-number", communications.default_transfer_number);
    add("--email-from", communications.email_from);
    add("--sms-from-number", communications.sms_from_number);
    const fields = [
      ["--confirmation-email-subject", templates.confirmation_email_subject],
      ["--confirmation-email-text", templates.confirmation_email_text],
      ["--confirmation-sms", templates.confirmation_sms],
      ["--reminder-email-subject", templates.reminder_email_subject],
      ["--reminder-email-text", templates.reminder_email_text],
      ["--reminder-sms", templates.reminder_sms],
      ["--post-reminder-email-subject", templates.post_reminder_email_subject],
      ["--post-reminder-email-text", templates.post_reminder_email_text],
      ["--post-reminder-email-html", templates.post_reminder_email_html],
      ["--post-reminder-sms", templates.post_reminder_sms],
      ["--quick-sms", templates.quick_sms],
      ["--quick-email", templates.quick_email],
      ["--quick-call-script", templates.quick_call_script],
      ["--message-email-subject", templates.message_email_subject],
      ["--message-email-text", templates.message_email_text],
      ["--message-email-html", templates.message_email_html],
      ["--call-end-email-subject", templates.call_end_email_subject],
      ["--call-end-email-text", templates.call_end_email_text],
      ["--call-end-email-html", templates.call_end_email_html],
      ["--booking-email-subject", templates.booking_email_subject],
      ["--booking-email-text", templates.booking_email_text],
      ["--booking-email-html", templates.booking_email_html],
    ];
    fields.forEach(([flag, value]) => add(flag, value));
    const postConfig =
      post.enabled !== undefined ||
      post.offset_days_after !== undefined ||
      Array.isArray(post.follow_ups);
    if (postConfig || reminders.post_appointment) {
      add(
        "--post-appointment-enabled",
        (post.enabled ?? reminders.post_appointment?.enabled) === false ? "false" : "true"
      );
      add(
        "--post-appointment-offset-days",
        post.offset_days_after ?? reminders.post_appointment?.offset_days_after
      );
      if (Array.isArray(post.follow_ups))
        add("--post-followups-json", JSON.stringify(post.follow_ups));
    }
    if (reminders.enabled !== undefined)
      add("--reminders-enabled", reminders.enabled ? "true" : "false");
    if (Array.isArray(reminders.offset_days))
      add("--reminder-offset-days-json", JSON.stringify(reminders.offset_days));
    if (Array.isArray(reminders.channels))
      add("--reminder-channels-json", JSON.stringify(reminders.channels));
    if (templates.post_followups && typeof templates.post_followups === "object") {
      add("--post-followup-templates-json", JSON.stringify(templates.post_followups));
    }
    return args;
  }

  getReceptionistConfig() {
    return this._getConfig("receptionist");
  }
  saveReceptionistConfig(payload) {
    return this._saveConfig("receptionist", payload);
  }
  getMessageConfig() {
    return this._getConfig("messages");
  }
  saveMessageConfig(payload) {
    return this._saveConfig("messages", payload);
  }
  getPostAppointmentWorkspace() {
    return this._getConfig("postAppointment");
  }
  savePostAppointmentConfig(payload) {
    return this._saveConfig("postAppointment", payload);
  }
  getEmailSetup() {
    return this._getConfig("email");
  }
  saveEmailSetup(payload) {
    return this._saveConfig("email", payload);
  }

  async _runMutation(command, args) {
    if (!this.runtime?.isAvailable?.()) {
      return { success: false, error: serializedError("AI_RECEPTIONIST_UNAVAILABLE") };
    }
    try {
      const result = await this._runJsonModule("receptionist.desktop_config", [command, ...args]);
      await this.sync();
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: publicSidecarError(error) };
    }
  }
}

module.exports = {
  DEFAULT_SYNC_INTERVAL_MS,
  DEFAULT_SYNC_TIMEOUT_MS,
  PROVIDER,
  DEFAULT_SYNC_RANGE_DAYS,
  ReceptionistCalendarBridge,
  canonicalEventFromAppointment,
  canonicalEventFromRow,
  occurrenceId,
  occurrencePrefix,
  publicSidecarError,
  projectCalendarIngress,
  projectCalendarRow,
  projectAppointment,
};
