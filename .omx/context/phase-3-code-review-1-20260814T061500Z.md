# Phase 3 Code Review 1: Required Corrections

## Verdict

REQUEST CHANGES from Terra High.

## P1 findings

1. The AIReceptionist feed currently exposes only the Google Calendar `html_link`. OpenWhispr maps it to `hangout_link`, and Home opens it as if it were a direct virtual meeting URL. This can open the calendar event page instead of the telehealth conference. The feed must add a separately allowlisted actual conference URL when available, and the bridge/database/UI must keep the distinction. If no conference URL exists, the action must not claim to join the meeting.

2. Complete-window reconciliation deletes stale `calendar_events` but leaves their local `encounters` rows scheduled. Home then shows a startable ghost whose backing calendar event is gone. The same reconciliation must cancel only unstarted encounters in the stale window, preserving note-linked/in-progress/completed encounters.

## Required correction plan

- Extend the AIReceptionist `calendar-feed` allowlist with a safe `conference_url` extracted from existing Google event conference data/link fields only when it is HTTPS and from approved meeting hosts.
- Map `conference_url` separately through the bridge and local calendar row; retain `html_link` only as an event-page fallback/display link.
- Make Home open the direct conference URL only; otherwise label the fallback as opening the calendar event and still start locally.
- Add a database method for stale encounter reconciliation scoped to provider/calendar/window/fresh IDs, preserving started or note-linked rows and marking unstarted rows cancelled.
- Invoke it alongside stale calendar-event cleanup and add focused tests for direct conference URLs, calendar-page fallback, and stale encounter cancellation.

## Release caveat

SQLite-backed tests remain skipped in this environment because `better-sqlite3` targets a different Node ABI. Re-run them after rebuilding the native module on a stopped dev process.
