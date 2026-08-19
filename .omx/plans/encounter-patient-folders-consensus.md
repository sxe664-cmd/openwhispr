# Encounter Patient Folders — Course-Correction Consensus

## Status and scope

**Ralplan revision 12 is the authoritative execution contract.** It supersedes every earlier package order, ownership table, sequencing statement, and final-review gate in this memo where it conflicts. Revision 12 changes only the reproducible Windows validation command for the already-frozen R9 cache-replay correction; it does not reopen R9 scope or architecture.

**Ralplan revision 11 is historical/non-authoritative.** Its narrow cache-replay package, exclusive ownership, acceptance rules, and final Terra High review requirements are carried forward unchanged by Revision 12. Its vendor command is superseded because this PowerShell host supports `New-Item -Path`, not the documented `New-Item -LiteralPath` form.

**Ralplan revision 10 is historical/non-authoritative.** Its narrow cache-replay package, exclusive ownership, acceptance rules, and final Terra High review requirements are carried forward unchanged by Revision 12. Its vendor command is superseded because it depended on the caller's current working directory and did not explicitly propagate the final `git diff --check` result.

**Ralplan revision 9 is historical/non-authoritative.** Its narrow cache-replay package, exclusive ownership, acceptance rules, and final Terra High review requirements are carried forward unchanged by Revision 12. Its vendor command is superseded because it did not account for the protected system-temp behavior observed on Windows.

**Ralplan revision 8 is historical/non-authoritative.** Its implementation and evidence remain valid audit context, but its final approval is superseded by the R9 corrective package and final Terra High review below. Revisions 1-7 remain below solely as historical/non-authoritative audit context.

**Ralplan revision 7 is historical/non-authoritative.** Revision 8 separates the shared desktop feed projection into an explicit safe default and a calendar-events-only private bridge projection, and adds the missing contact-key and bridge-normalization tests.

**Ralplan revision 6 is historical/non-authoritative.** Revision 7 replaces its incorrect implication that ReminderStore cache replay reaches the live receptionist bridge, and freezes the attendee-validation rules and test routes below.

**Ralplan revision 5 — historical/non-authoritative execution contract.** Revision 7 above supersedes it. The repository is intentionally dirty; this plan changes only the patient-folder feature and its tests.

The delivery remains deliberately narrow:

- Exact normalized email is the sole automatic identity key. A name is only a mutable folder label.
- Parse only the exact `[OpenWhispr Patient]` block in the AIReceptionist sidecar. No raw calendar description may cross into Electron or renderer state.
- Create/reuse folders only for a confidently resolved one-person encounter, in the private space.
- Preserve notes and transcripts as user-owned. Focus is derived output; it may replace only an untouched automatic title.
- Do not automatically assign historical encounters, notes, folders, or profiles. A future backfill is preview-and-confirm only.

The partial implementation has a privacy defect: it writes `patient_metadata` to `calendar_events`, while generic calendar queries and `gcal-*` IPC can return `SELECT *` rows. The chosen architecture is therefore **a resolver-only metadata table plus explicit public event projections**. Do not retain the metadata-on-`calendar_events` design with redaction patches alone.

## Revision 8 corrective architecture: self-attendee provenance (historical/non-authoritative)

### Decision

Preserve a **private, non-PHI tri-state self-attendee provenance** from Google parsing through cache replay and patient resolution:

```ts
type SelfAttendeePresence = true | false | null;

type SidecarBridgeEvent = SidecarPublicEvent & {
  patient_metadata?: SanitizedPatientMetadata;
  // Internal bridge-input field only; never renderer/public-calendar state.
  self_attendee_present?: boolean | null;
};

type CalendarIngressEnvelope = {
  publicEvent: PublicCalendarEvent;
  patientMetadata: SanitizedPatientMetadata | null;
  selfAttendeePresent: SelfAttendeePresence;
};
```

`true` means Google supplied a valid attendee list containing at least one attendee record whose `self` value was the exact boolean `true`; `false` means Google supplied a valid attendee list and none of its records had that exact boolean value. `null` means provenance is unavailable: Google omitted `attendees`, supplied a non-list attendee collection, supplied any non-object list item, supplied a record with a present-but-non-boolean `self` value, a cached row predates this migration, or the sidecar input is malformed. **Absent or malformed Google attendee data is never `false`.** The value is an ownership/provenance flag only: it contains no email, display name, description, note, or diagnostic data.

The sidecar continues to emit only external attendee emails. `calendar_google.py` must freeze parsing as follows before filtering: (1) missing `attendees` or a non-list value produces `null`; (2) `attendees=[]` produces `false`; (3) every list item must be an object; any non-object produces `null`; (4) an omitted `self` key is valid and means not-self, a present `self` key must be an exact boolean, exact `true` marks self, exact `false` is valid not-self, and every other present value produces `null`. Only after that validation may it apply the established external-email filter: exclude records only where `self is True`, and otherwise retain the current object-email normalization/contact-match behavior. Thus a malformed `self` makes provenance unknown but does not silently redesign the existing external-email filter. `AppointmentEvent` carries `has_self_attendee: bool | None`; the reminder-store `events` table persists it as nullable `self_attendee_present`, with no invented backfill for existing rows. New provider batches write `true` or `false` only for a valid attendee list; absent/malformed source data and pre-upgrade cache rows remain `NULL` and become `null` when reconstructed.

### Actual execution routes and ownership

There are three separate paths and they must not be conflated in tests or implementation:

1. **Fresh provider batch to patient resolution:** the sidecar `calendar-events` command fetches a fresh Google provider batch, passes each `AppointmentEvent` through `_calendar_feed_event(..., include_private_provenance=True)`, and returns the internal sidecar bridge-input event. `ReceptionistCalendarBridge` consumes that event, builds `CalendarIngressEnvelope`, calls `upsertCalendarIngress()`, and `startEncounterForCalendarEvent()` performs the private resolver lookup. This is the only route covered by the Electron bridge-to-ingress-to-resolver integration test.
2. **Local ReminderStore replay:** the sidecar `reminders-sync` command reads `ReminderStore.list_events()`, reconstructs an `AppointmentEvent` with `_stored_appointment_event()`, and sends it to reminder scheduling. It does **not** call `_calendar_feed_event()`, does not invoke `calendar-events`, and never reaches `ReceptionistCalendarBridge`, Electron ingress, or patient resolution. Vendor tests alone own this cache round-trip and its tri-state persistence assertions.
3. **Hira safe feed:** `calendar_feed` fetches a fresh provider batch but calls `_calendar_feed_event()` with its default `include_private_provenance=False`. It is a safe Hira-facing feed and must contain neither `patient_metadata` nor `self_attendee_present`; it does not supply `ReceptionistCalendarBridge` or patient resolution.

The tri-state remains private in both paths. The reminder cache is not a patient-folder backfill channel.

`desktop_config._calendar_feed_event()` must have the explicit keyword-only contract `include_private_provenance: bool = False`. Its default safe projection, used by `calendar_feed`, must never include `patient_metadata` or `self_attendee_present`. Only the `calendar-events` call site may pass `include_private_provenance=True`; that internal sidecar-to-bridge projection may carry both optional sanitized `patient_metadata` and the tri-state signal. Neither field may appear in the desktop appointment projection, Hira feed, renderer output, calendar broadcast, or any public calendar event shape. `ReceptionistCalendarBridge` must destructure and normalize the value separately, pass it only as `CalendarIngressEnvelope.selfAttendeePresent`, and keep it out of `publicEvent`, sync results, broadcasts, reconciliation inputs, and canonical/public calendar projections.

The resolver-only `calendar_patient_metadata` table gains a nullable `self_attendee_present` column. `upsertCalendarIngress()` stores the value only with a valid private metadata row; a later metadata-less ingress still deletes the whole private row. The only private resolver query reads this column together with `metadata_json`; no public query, IPC handler, or `calendar_events` row receives it. Existing metadata rows upgrade with `NULL`, not `false`; this is a no-backfill migration.

`resolvePatientIdentity()` accepts `selfAttendeePresent`. With exactly one external attendee, the established attendee and metadata-conflict rules are unchanged, regardless of the flag. With no external attendee, structured metadata may resolve an identity **only when `selfAttendeePresent === false`**. `true` (self-only) and `null` (unknown legacy/malformed provenance) fail closed as `unassigned_missing_email` for otherwise valid structured metadata; invalid structured metadata retains `unassigned_invalid_metadata`. This prevents clinician/self addresses from creating or selecting a patient folder while preserving real self-plus-one-external encounters and authoritative new no-self metadata-only encounters.

This is intentionally narrower than treating every metadata-only event as unsafe: a newly parsed Google event with no self attendee retains the prior structured-metadata path; only self-present and provenance-unknown no-external cases are suppressed. It preserves exact normalized-email identity, external-attendee behavior, private metadata storage, retry idempotency, and the no-historical-backfill rule.

### Revision 8 serial work packages and exclusive ownership

Run each package only after its listed dependency is accepted. A worker may make only the edits in its exclusive file list. If the frozen contract proves insufficient, stop and return the issue to Terra High planning; do not make an architectural substitution.

| Sequence | Package / model and reasoning | Dependencies | Exclusive files | Acceptance criteria |
| --- | --- | --- | --- | --- |
| R8-1 | Source, cache, and split sidecar projections / **Terra High** | Revision 5 accepted | `vendor/ai-receptionist/receptionist/reminders/models.py`, `vendor/ai-receptionist/receptionist/reminders/calendar_google.py`, `vendor/ai-receptionist/receptionist/reminders/store.py`, `vendor/ai-receptionist/receptionist/desktop_config.py`, `vendor/ai-receptionist/tests/test_patient_metadata.py` | Add nullable `AppointmentEvent.has_self_attendee` and the frozen parser rules above. Add the nullable store column through fresh-schema and upgrade paths without backfill; `upsert_event()`, `list_events()`, and `_stored_appointment_event()` must round-trip it. Implement the explicit `_calendar_feed_event(..., include_private_provenance=False)` default and use `True` only at the `calendar-events` call site. In `test_patient_metadata.py`, add source tests for: absent/non-list attendees=`null`; empty list=`false`; any non-object item=`null`; present non-boolean `self`=`null`; self-only=`true`; self+external=`true`; valid no-self=`false`. In each of self-only, self+external, and malformed-self cases, assert `attendee_emails` remains external-only and `contact_match_keys` retains the established exact filtered/normalized values. Add a `calendar_feed` safe-projection assertion that both `patient_metadata` and `self_attendee_present` are absent, plus a `calendar-events` private-projection assertion that only `include_private_provenance=True` emits validated values. Add ReminderStore-only round-trip tests in this same file for stored `true`, `false`, `null`, and legacy/missing-column `NULL` reconstruction. These tests must call no bridge/Electron APIs. No raw notes or attendee-self email may reach either feed. |
| R8-2 | Private ingress and deterministic resolver / **Terra High** | R8-1 frozen contract | `src/helpers/patientIdentity.js`, `src/helpers/database.js`, `test/helpers/patientIdentity.test.js`, `test/helpers/calendarDatabase.test.js` | Extend the private ingress/resolver contract with strict `true`/`false`/`null` provenance. Add only private schema migration/storage/query support, leaving `calendar_events` and all public getters unchanged. Metadata-only resolution is allowed only for explicit `false`; `true` and `null` return `unassigned_missing_email` with no profile/folder; invalid metadata remains invalid. Exactly one external attendee still resolves it even when signal is `true` or `null`. Fresh and upgrade DB assertions prove `NULL` no-backfill, metadata deletion, no public-signal leak, no profile/folder for self-only or unknown, and idempotency. All Electron DB tests run with `REQUIRE_DB_TESTS=1`. |
| R8-3 | Bridge private-envelope integration / **Terra Medium** | R8-2 accepted | `src/helpers/receptionistCalendarBridge.js`, `test/helpers/receptionistCalendarBridge.test.js` | Parse `self_attendee_present` strictly: only primitive boolean `true` and `false` survive; an absent field, string, number, object, array, or any other value becomes private `null`. Pass the result only in `CalendarIngressEnvelope.selfAttendeePresent`; never add it to the public event. Existing already-filtered external attendee normalization stays `self:false`. Fake-DB tests must exercise absent, string, numeric, and object values and prove the received envelope has `null` for each, while sync returns, broadcasts, reconciliation, and public projections contain neither the raw field nor a normalized signal, metadata, or raw-description sentinels. |
| R8-4 | Fresh-provider bridge-to-resolver regression / **Luna High** | R8-1, R8-2, R8-3 accepted | `test/helpers/receptionistCalendarPatientResolution.integration.test.js` | Add this exact Electron integration test. Mock only the sidecar `calendar-events` fresh-provider response with private-projection sidecar-shaped events; do not invoke `calendar_feed`, `reminders-sync`, or ReminderStore. Drive self-only valid structured clinician metadata, absent attendees, non-list attendees, a non-object attendee item, and a present non-boolean `self` through `ReceptionistCalendarBridge` sync, `upsertCalendarIngress`, and `startEncounterForCalendarEvent`. Each unknown/self case must be `unassigned_missing_email`, create no patient profile/folder, and leak neither metadata nor signal in public reads. In the same test prove a self+one-external event resolves only the normalized external email and a valid no-self metadata-only event retains structured resolution. This package adds tests only and must not change production contracts. |
| R8-5 | Integrated validation / **Terra High** | R8-1 through R8-4 | No independent product files; validation artifacts only when required | Review exact changed paths, migration safety, cache compatibility, separate safe/private projections, public/private boundaries, actual route separation, and all evidence. Any contract failure returns to a new Terra High planning cycle before a correction is assigned. |

R8-1 is high-risk because it changes a persisted third-party cache plus the shared safe/private sidecar projection boundary. R8-2 is high-risk because it changes the private database boundary and resolution state. Once those contracts are frozen, R8-3 is a bounded bridge adaptation requiring engineering judgment, and R8-4 is a tightly scoped, objectively verifiable fresh-provider integration package. No package may alter UI, IPC, focus generation, user notes, historical data, or unrelated reminder behavior.

### Revision 8 mandatory verification

- R8-1 vendor source, safe/private projection, and ReminderStore cache suite: `$env:PYTHONPATH='vendor/ai-receptionist'; python -m pytest -q vendor/ai-receptionist/tests/test_patient_metadata.py`.
- R8-4 fresh-provider bridge-to-resolver integration: `$env:ELECTRON_RUN_AS_NODE='1'; $env:REQUIRE_DB_TESTS='1'; .\node_modules\.bin\electron.cmd --test test/helpers/receptionistCalendarPatientResolution.integration.test.js`. This test must not exercise `calendar_feed`, `reminders-sync`, or claim to validate cache replay.
- Full Electron database gate: `$env:ELECTRON_RUN_AS_NODE='1'; $env:REQUIRE_DB_TESTS='1'; .\node_modules\.bin\electron.cmd --test test/helpers/calendarDatabase.test.js`; skipped database tests cannot approve the feature.
- Preserve Revision 5 gates: `npm run typecheck`, `npm run build:renderer`, `npm run i18n:check`, scoped ESLint over touched files (no errors; existing unrelated warnings documented), and `git diff --check`.
- Final review must separately inspect the three actual routes: (a) fresh `calendar-events` private projections through bridge/ingress/resolution for self-only, self-plus-external, valid no-self metadata-only, absent/non-list/non-object/non-boolean-self unknown cases; (b) Hira `calendar_feed` safe projections, which must contain neither `patient_metadata` nor `self_attendee_present`; and (c) ReminderStore-only `upsert_event`/`list_events`/`_stored_appointment_event` round trips for `true`, `false`, `null`, and legacy `NULL`. It must verify the R8-1 contact-match-key assertions, R8-3 raw-value-to-`null` normalization, unknown/self patient-resolution fail-closed behavior, and that public DB/IPC/bridge outputs contain only external attendee emails and never `patient_metadata`, `metadata_json`, `self_attendee_present`, notes, raw descriptions, or the new signal.

## Revision 9 corrective architecture: ReminderStore contact-key cache replay (historical/non-authoritative; scope carried forward by Revision 12)

### Final-review finding and frozen decision

R8 final code review found that `ReminderStore.list_events()` omits the already-persisted `contact_match_keys` column from its selected row and returned record. Consequently, `desktop_config._stored_appointment_event()` cannot restore the field when `reminders-sync` rebuilds an `AppointmentEvent`; the existing scheduler's `_contact_match_keys()` then loses valid non-attendee identifiers and can produce `missing_recipient` for a cache-replayed event.

R9 repairs only this read/reconstruction handoff. It does **not** change provider parsing, cache write/upsert behavior, schema/migrations, recipient matching policy, the scheduler, attendee filtering, patient metadata, self-attendee provenance, or public/private calendar projections.

The cache contract after R9 is:

1. `ReminderStore.list_events()` selects `contact_match_keys` and returns it as the established normalized tuple, using the same stored-value splitting and contact-key normalization used by existing read/write paths. It must preserve an empty value as `()` and must not expose the raw comma-delimited storage representation.
2. `_stored_appointment_event()` restores that normalized tuple to `AppointmentEvent.contact_match_keys`; it must retain the existing normalized `attendee_emails` and nullable `has_self_attendee` behavior exactly.
3. A cache-replayed event with no attendee emails but a valid normalized contact-match key remains matchable by the scheduler's existing `_contact_match_keys()` collector. This is a regression proof of current behavior, not a scheduler redesign: R9 must not modify `scheduler.py` or recipient-selection logic.

This correction remains wholly within the ReminderStore replay route. It does not traverse `calendar-events`, `calendar_feed`, `ReceptionistCalendarBridge`, Electron ingress, patient resolution, IPC, or renderer state. R9 must not claim bridge or Electron coverage for its vendor cache correction.

### Revision 9 serial work packages and exclusive ownership

Run R9-1 first. R9-2 may begin only after its focused vendor evidence is accepted. No package may expand scope or alter an architectural contract; return any unexpected dependency to Terra High planning.

| Sequence | Package / model and reasoning | Dependencies | Exclusive files | Acceptance criteria |
| --- | --- | --- | --- | --- |
| R9-1 | Cache replay contact-key restoration / **Luna High** | R8-5 final-review finding | `vendor/ai-receptionist/receptionist/reminders/store.py`, `vendor/ai-receptionist/receptionist/desktop_config.py`, `vendor/ai-receptionist/tests/test_patient_metadata.py` | Make `list_events()` select `contact_match_keys` and expose the established normalized tuple in every returned record. Make `_stored_appointment_event()` restore the tuple with the established normalization. Add one direct cache round-trip regression that persists a deliberately non-attendee normalized contact key, verifies `list_events()` exposes exactly that tuple, and verifies `_stored_appointment_event()` restores it with `attendee_emails == ()`; import and call the existing pure `scheduler._contact_match_keys()` helper in that test to prove the restored non-attendee key reaches the scheduler's matching-key input. Add/retain explicit assertions that cached `attendee_emails`, `contact_match_keys`, and `has_self_attendee` (`true`, `false`, `null`) all survive reconstruction. Do not edit `scheduler.py`, models, Google parser, migrations, bridge, Electron/database code, or public feed projections. |
| R9-2 | Corrective final validation / **Terra High** | R9-1 accepted | No independent product files; validation artifacts only when required | Review the exact R9-1 diff and focused evidence. Confirm the fix covers both the SQL projection and returned-record/reconstruction boundary; contact keys are normalized rather than raw storage text; non-attendee matching keys reach the existing scheduler collector; attendee emails and tri-state provenance are unchanged; and no forbidden file or public/private boundary changed. Then re-run and assess every R8 mandatory gate as still required evidence. A final code and architecture review is required after these commands pass; any finding returns to Terra High planning rather than ad hoc modification. |

R9-1 is deliberately Luna High: it is a bounded, objectively verifiable correction across a single cache read/reconstruction contract with an established normalization and test location. Terra High remains responsible for the post-correction evidence review and final architectural/code validation.

### Revision 9 mandatory verification and approval gate (historical command superseded by Revision 12)

The historical R9 command below was the intended vendor-only cache-replay proof before R9-2 review. It does not provide bridge or Electron coverage and is superseded by the R12 command:

```powershell
$env:PYTHONPATH = 'vendor/ai-receptionist'
python -m pytest -q vendor/ai-receptionist/tests/test_patient_metadata.py
Remove-Item Env:PYTHONPATH
```

The focused test must prove all of the following with concrete values:

- `list_events()` exposes the normalized `contact_match_keys` tuple for a stored record, including a key that is not present in `attendee_emails`.
- `_stored_appointment_event()` restores that exact tuple, retains `attendee_emails == ()`, and preserves `has_self_attendee` for `true`, `false`, and `null` cache rows.
- The existing scheduler `_contact_match_keys()` input includes the restored non-attendee key, demonstrating that cache replay no longer loses the identifier required for contact matching.

All Revision 8 mandatory gates remain mandatory and must be re-run for final approval: the vendor source/safe-private/cache suite, the fresh-provider bridge-to-resolver Electron integration, the full Electron database suite with `REQUIRE_DB_TESTS=1`, `npm run typecheck`, `npm run build:renderer`, `npm run i18n:check`, scoped ESLint over every R8/R9-touched file (no errors; unrelated pre-existing warnings documented), and `git diff --check`. Those R8 commands retain their route-specific meaning; they must not be represented as direct proof of the R9 ReminderStore replay correction.

Final Terra High approval requires both an architecture verdict and a code verdict of `APPROVE`, plus the R9 focused vendor result and all carried-forward R8 gates. It must specifically inspect `list_events()`'s SQL projection and returned mapping, `_stored_appointment_event()` reconstruction, and the no-attendee contact-key regression. It must also reconfirm that no raw notes, patient metadata, self-attendee signal, or cache-only contact data appears in safe/public calendar outputs.

## Revision 12 corrective validation: rooted Windows-local vendor temp directory (authoritative)

Revision 12 preserves every R9-1 scope boundary, exclusive file list, acceptance criterion, serial order, and final Terra High review requirement. R9-1 remains a Luna High package limited to `vendor/ai-receptionist/receptionist/reminders/store.py`, `vendor/ai-receptionist/receptionist/desktop_config.py`, and `vendor/ai-receptionist/tests/test_patient_metadata.py`; it restores normalized `contact_match_keys` through `list_events()` → `_stored_appointment_event()` → the existing scheduler key collection, with its regression and no other contract changes. Revision 12 changes no product or test contract. The only correction is the authoritative Windows command for the R9 vendor cache-replay gate, replacing the historical Revision 9, Revision 10, and Revision 11 commands above.

The command first asserts the explicit repository root `C:\\Users\\santi\\openwhispr`, then enters it with `Push-Location`. It refuses to reuse an existing directory and creates only `C:\\Users\\santi\\openwhispr\\.omx\\tmp\\r12-vendor-pytest`; it restores pre-existing process values for `TMP`, `TEMP`, and `PYTHONPATH`; records and checks the pytest exit code before cleanup; and removes only that exact created directory. It then runs `git -C $r12Repo diff --check`, captures its exit code, and explicitly propagates a failure.

```powershell
$r12Repo = 'C:\Users\santi\openwhispr'
if (-not (Test-Path -LiteralPath $r12Repo -PathType Container)) {
    throw "R12 repository root does not exist: $r12Repo"
}

$r12ResolvedRepo = (Resolve-Path -LiteralPath $r12Repo).Path
if ($r12ResolvedRepo -ne $r12Repo) {
    throw "R12 repository root resolved unexpectedly: $r12ResolvedRepo"
}

$r12Temp = Join-Path $r12Repo '.omx\tmp\r12-vendor-pytest'
if (Test-Path -LiteralPath $r12Temp) {
    throw "R12 temp directory already exists: $r12Temp"
}

$r12PreviousEnv = @{}
foreach ($r12Name in 'TMP', 'TEMP', 'PYTHONPATH') {
    $r12Entry = Get-Item -LiteralPath "Env:$r12Name" -ErrorAction SilentlyContinue
    $r12PreviousEnv[$r12Name] = if ($null -eq $r12Entry) { $null } else { $r12Entry.Value }
}

$r12CreatedTemp = $false
$r12PytestExit = 1
Push-Location -LiteralPath $r12Repo
try {
    New-Item -ItemType Directory -Path $r12Temp -ErrorAction Stop | Out-Null
    $r12CreatedTemp = $true
    $env:TMP = $r12Temp
    $env:TEMP = $r12Temp
    $env:PYTHONPATH = Join-Path $r12Repo 'vendor\ai-receptionist'

    python -m pytest -q --basetemp (Join-Path $r12Temp 'pytest') vendor/ai-receptionist/tests/test_patient_metadata.py
    $r12PytestExit = $LASTEXITCODE
    if ($r12PytestExit -ne 0) {
        Write-Error "R12 vendor pytest failed with exit code $r12PytestExit"
    }
}
finally {
    foreach ($r12Name in 'TMP', 'TEMP', 'PYTHONPATH') {
        if ($null -eq $r12PreviousEnv[$r12Name]) {
            Remove-Item -LiteralPath "Env:$r12Name" -ErrorAction SilentlyContinue
        }
        else {
            Set-Item -LiteralPath "Env:$r12Name" -Value $r12PreviousEnv[$r12Name]
        }
    }
    if ($r12CreatedTemp) {
        Remove-Item -LiteralPath $r12Temp -Recurse -Force -ErrorAction Stop
    }
    Pop-Location
}

if ($r12PytestExit -ne 0) {
    exit $r12PytestExit
}

git -C $r12Repo diff --check
$r12DiffExit = $LASTEXITCODE
if ($r12DiffExit -ne 0) {
    exit $r12DiffExit
}
```

R12 acceptance requires the same R9 vendor assertions: `list_events()` exposes a normalized non-attendee `contact_match_keys` tuple; `_stored_appointment_event()` restores it while retaining empty attendee emails and `true`/`false`/`null` self-attendee provenance; and the existing scheduler key collector receives that restored key. This command is vendor-only cache-replay evidence: it must not claim bridge or Electron coverage. R8's route-specific verification gates, the R9-2 Terra High corrective final validation, and its required final architecture and code `APPROVE` verdicts remain mandatory without modification.

### Earlier revisions are historical

Revision 11 and every earlier revision below are historical/non-authoritative. They remain as audit evidence and continue to describe invariants that Revision 12 carries forward, but their package routing and any conflicting wording must not be used for implementation.

## Revision 5 execution boundary and order (historical)

The execution workers correctly found that the previous order was impossible: a bridge-only package cannot call an adapter that a later database-only package has not yet created, and a sidecar-only package cannot construct an Electron-owned envelope. This section replaces that order.

### Exact private ingress contract

The sidecar command response is an **internal bridge-input protocol**, not a renderer/public calendar protocol. Its event entries may carry one optional, already-validated field:

```ts
type SidecarBridgeEvent = SidecarPublicEvent & {
  patient_metadata?: {
    name: string | null;
    email: string;
    phone: string | null;
    source: "structured_description";
  };
};
```

Only `desktop_config.py` emits this field, only after parsing the exact bounded `[OpenWhispr Patient]` block. It must contain no raw description, notes, diagnostics, unknown keys, or unvalidated values. The sidecar never creates a `CalendarIngressEnvelope` and never exposes this feed to the renderer.

For Google events, `calendar_google.py` must remove attendee records where Google's `attendee.self == true` before emitting `attendee_emails`. Every attendee email delivered through this AIReceptionist sidecar path is therefore external. This preserves existing reminder behavior for external attendees and never adds raw descriptions or new patient data to the public event shape. The bridge may continue to normalize these already-filtered values as `self: false`; it must not infer self status or recover it from another field.

`ReceptionistCalendarBridge` is the sole boundary owner. For every `SidecarBridgeEvent`, it must destructure `patient_metadata` before building any public object:

```ts
type PublicCalendarEvent = { /* existing public calendar columns only, including the existing attendee JSON */ };
type SanitizedPatientMetadata = {
  name: string | null;
  email: string;
  phone: string | null;
  source: "structured_description";
};
type CalendarIngressEnvelope = {
  publicEvent: PublicCalendarEvent;
  patientMetadata: SanitizedPatientMetadata | null;
};

function projectCalendarIngress(input: SidecarBridgeEvent): CalendarIngressEnvelope | null;
```

The bridge implementation must use separate variables, equivalent to:

```js
const { patient_metadata: rawPatientMetadata, ...sidecarPublic } = appointment;
const publicEvent = projectPublicCalendarEvent(sidecarPublic);
const patientMetadata = parsePatientMetadata(rawPatientMetadata).metadata;
return { publicEvent, patientMetadata };
```

It must not spread `input` into `publicEvent`, attach `patientMetadata` to `publicEvent`, or return the envelope from `_sync()`.

Database signatures are frozen before integration:

```ts
upsertCalendarEvents(publicEvents: PublicCalendarEvent[]): { success: true };
upsertCalendarIngress(envelopes: CalendarIngressEnvelope[]): { success: true };
```

`upsertCalendarIngress()` is the **only** database entry point that accepts `CalendarIngressEnvelope` or metadata. In one transaction it persists `envelope.publicEvent` to `calendar_events`, then upserts/deletes the corresponding row in `calendar_patient_metadata`. `upsertCalendarEvents()` accepts public events only and cannot serialize `patient_metadata` or `metadata_json`. The resolver may read metadata only through a private event-plus-metadata query inside `startEncounterForCalendarEvent`'s transaction.

In `_sync()`, the bridge calls `upsertCalendarIngress(envelopes)`, passes only `envelopes.map(({ publicEvent }) => publicEvent)` to encounter projection and reconciliation, and emits/returns only public events or public counts. No bridge return, broadcast, public database getter, or IPC response may contain the metadata key, `metadata_json`, structured-patient name/email/phone values, or raw-description sentinel. Existing attendee JSON remains allowed only as part of the named public projection.

### Sequenced packages and exclusive ownership

| Order | Package / routing | Exclusive files | Concrete exit condition |
| --- | --- | --- | --- |
| 0 | A — identity/timezone / Luna High **completed** | `src/helpers/patientIdentity.js`, `test/helpers/patientIdentity.test.js` | 10/10 deterministic identity and timezone tests pass. No further A edits unless a new plan cycle is opened. |
| 1 | D0 — private database foundation / Terra High | `src/helpers/database.js`, `test/helpers/calendarDatabase.test.js` | Create `calendar_patient_metadata`, explicit `CALENDAR_EVENT_PUBLIC_COLUMNS`, public-only `upsertCalendarEvents`, and concrete `upsertCalendarIngress(envelopes)`. Add migrations and fake/DB contract tests. It does not edit bridge or sidecar files. |
| 2 | B — bridge envelope integration / Terra Medium | `src/helpers/receptionistCalendarBridge.js`, `test/helpers/receptionistCalendarBridge.test.js` | Replace `projectCalendarRow()` use with bridge-owned envelope construction and call D0's adapter. Assert fake DB receives envelopes only through `upsertCalendarIngress`; assert sync return/broadcast/reconciliation receive only public events. |
| 2 | C — sidecar internal sanitization / Terra Medium | `vendor/ai-receptionist/receptionist/reminders/identity.py`, `vendor/ai-receptionist/receptionist/desktop_config.py`, relevant Python tests | Retain the optional internal `patient_metadata` bridge-input field only; enforce exact block/shape/length rules and prove no raw notes leave Python. Does not edit bridge or database files. |
| 3 | D1 — database patient resolution and title completion / Terra High | `src/helpers/database.js`, `test/helpers/calendarDatabase.test.js` | After B is merged, complete private resolver lookup, patient folders, resolution enum/migration triggers, title/focus timezone flow, and migration cleanup tests. |
| 4 | E — calendar IPC privacy / Luna High | `src/helpers/ipcHandlers.js`, `test/helpers/calendarIpcPrivacy.test.js` | Use D1 public getters only; both calendar IPC handlers pass sentinel-redaction tests. |
| 4 | F — encounter review UI / Luna High | `src/types/electron.ts`, `src/components/EncounterCard.tsx`, `src/components/EncounterHomeView.tsx`, required encounter locale keys, `test/components/encounterHome.test.js` | Enum-only linked/review display; no profile, folder, email, phone, or metadata fields. |
| 4 | G — focus generation / Terra Medium | `src/helpers/clinicalOutputGeneration.ts`, `src/config/prompts/clinicalOutputs.ts`, `src/components/notes/EncounterClinicalOutputs.tsx`, `test/components/encounterClinicalOutputs.test.js` | Generate and route brief focus using D1's token-aware persistence contract; report contract mismatch instead of editing database code. |
| 5 | H — integration/final validation / Terra High | no independent product files | Review combined diff and evidence. Any failure returns to a new planning cycle before a corrective package is assigned. |

### Revision 5 corrective package: Google self-attendee fidelity

This is a bounded correction from final code review. It does not change the deterministic identity rule, private-ingress envelope, metadata storage, no-backfill policy, or fuzzy/LLM prohibition.

| Sequence | Package / routing | Exclusive files | Exact exit condition |
| --- | --- | --- | --- |
| R5-1 | Google self-attendee filter / Luna High | `vendor/ai-receptionist/receptionist/reminders/calendar_google.py`, Google-calendar vendor tests (including `vendor/ai-receptionist/tests/test_patient_metadata.py` only if it is the established fixture location) | Before building `attendee_emails`, exclude only source records whose `attendee.self` is exactly `true`; retain every external attendee and existing reminder behavior. Add sidecar tests for self-only and self-plus-one-external events. |
| R5-2 | Bridge external-attendee regression / Luna High | `src/helpers/receptionistCalendarBridge.test.js` | Add a bridge-contract regression using sidecar-shaped, already-filtered attendee emails. It proves the bridge intentionally emits those attendees as `self: false`, exposes no patient metadata, and forwards the external attendee set unchanged. No bridge production change is expected unless the asserted contract fails. |
| R5-3 | Resolver regression / Luna High | `test/helpers/calendarDatabase.test.js` | Under the Electron-compatible SQLite harness, prove a self-only event starts unassigned and creates no patient profile/folder, while a self-plus-one-external event resolves only the external normalized email and never the clinician/self email. No database production change is expected unless the test reveals a contract defect. |

Run R5-1, then R5-2, then R5-3. This serial order establishes the source guarantee, locks the bridge boundary, then proves the resolver consequence. R5-1 has a disjoint write set from the JavaScript packages; R5-2 and R5-3 modify only their listed regression tests. All three must complete before H may approve code review.

D0 is deliberately first: it establishes an executable adapter without asking B to edit `database.js`. B and C start only after D0's public/private method contract is available. B and C may then run in parallel because their files are disjoint and the envelope is frozen here; B's fake DB tests do not require SQLite and C's Python tests do not require Electron. D1 starts only after B's integration is accepted. E, F, and G start only after D1 publishes the final public calendar and encounter contracts.

All **Revision 4**, **Revision 3**, and earlier package tables, their sequencing paragraphs, and the pre-Revision-3 historical table below are retained solely as audit history. They are non-authoritative and must not be used for worker routing or implementation order.

### Privacy invariants and test gates

- The sidecar's optional `patient_metadata` is permitted only on its private command output en route to `ReceptionistCalendarBridge`. It is not a public calendar field.
- Bridge tests use distinctive structured-patient name/email/phone and raw-description sentinels and prove that `sync()` results, emitted/broadcast payloads, encounter projection calls, and reconciliation calls contain none of them. Existing attendee email values are explicitly permitted only in the named public projection. The fake DB must observe sanitized metadata only as `CalendarIngressEnvelope.patientMetadata` supplied to `upsertCalendarIngress`.
- Database tests prove `calendar_events` public projections, `getUpcomingEvents`, range reads, `getCalendarEventById`, and start-independent getters never select/return metadata. Only the private start-transaction resolver query may join `calendar_patient_metadata`.
- IPC tests prove `gcal-get-upcoming-events` and `gcal-get-event` cannot return structured-patient name/email/phone sentinels, `patient_metadata`, `metadata_json`, or raw-description content even when legacy test rows contain the obsolete `calendar_events.patient_metadata` column; existing attendee JSON remains governed by the named public projection.
- The upgrade migration first normalizes legacy resolution values, relocates only valid sanitized legacy metadata, ignores invalid legacy values without logging raw content, installs enum enforcement, and exposes only public projections. It creates no historical profile, folder, note, or encounter association. Event deletion cascades metadata deletion; a later ingress without metadata deletes that event's private metadata row.
- Fresh and upgrade schema tests directly prove invalid `patient_resolution` `INSERT` and `UPDATE` operations abort. The full patient transaction must prove retry idempotency, exact-email reuse, same-name/different-email folder disambiguation, unavailable-folder review state, and manual-title/stale-token protection.
- Google self-attendee regression is mandatory: sidecar parsing excludes only `attendee.self == true`; a self-only event yields no external attendee and remains `unassigned_missing_email` with no profile/folder; self plus one external attendee resolves only that external normalized email. The bridge's `self: false` value is valid only for this already-filtered sidecar input.
- `REQUIRE_DB_TESTS=1` under an Electron-compatible `better-sqlite3` runtime is a release gate. Local skipped DB tests are informative only and cannot approve the feature. Focused pure bridge/sidecar/identity tests may run locally with fakes.

No manual patient reassignment, historical backfill, fuzzy/LLM identity matching, provider expansion beyond the AIReceptionist sidecar, or unrelated calendar redesign is in scope.

## Historical Revision 4 architecture decisions (non-authoritative)

### Revision 3: binding private-ingestion envelope

This revision overrides any earlier wording that permits `patient_metadata` on a bridge row, `calendar_events` row, sync result, broadcast, public getter, or IPC response.

Freeze this interface before bridge or database implementation begins:

```ts
type SanitizedPatientMetadata = {
  name: string | null;
  email: string;
  phone: string | null;
  source: "structured_description";
};

type CalendarIngressEnvelope = {
  publicEvent: PublicCalendarEvent;
  patientMetadata: SanitizedPatientMetadata | null;
};
```

- `projectCalendarIngress()` is the only bridge projection that may create the envelope. It validates the exact sidecar block, returns a metadata-free `publicEvent`, and retains `patientMetadata` only as a sibling field.
- The bridge passes envelopes only to a dedicated private database method, `upsertCalendarIngress(envelopes)`. It passes `envelope.publicEvent` to public calendar/encounter projection methods.
- `sync()` results, `gcal-events-synced` broadcasts, `listCalendarEvents`, canonical event conversion, public DB getters, and every IPC response may contain `PublicCalendarEvent` only. No metadata key, structured email/phone, or raw-description sentinel may appear in them.
- `patientMetadata` must never be spread into, serialized on, or retained by a public event object. Public event objects and private envelopes are separate types and separate variables; later redaction is not an acceptable boundary.
- Only `upsertCalendarIngress()` and the resolver's private lookup can receive sanitized metadata. The lookup executes only inside `startEncounterForCalendarEvent`'s transaction.

The resolver-only table remains the chosen storage. `upsertCalendarIngress()` writes only `publicEvent` fields to `calendar_events` and separately upserts/deletes metadata in `calendar_patient_metadata`. Existing provider-specific `upsertCalendarEvents()` callers accept public events only.

### 1. Resolver-only metadata storage and public calendar API

Create the following main-process-only table:

```sql
CREATE TABLE IF NOT EXISTS calendar_patient_metadata (
  calendar_event_id TEXT PRIMARY KEY REFERENCES calendar_events(id) ON DELETE CASCADE,
  metadata_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source = 'structured_description'),
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

- `metadata_json` contains only validated `{ name: string|null, email: string, phone: string|null, source: "structured_description" }`. It never contains descriptions, notes, parser diagnostics, or arbitrary upstream fields.
- `upsertCalendarEvents(publicEvents)` accepts only `PublicCalendarEvent`. `upsertCalendarIngress(envelopes)` is the only method that may receive `CalendarIngressEnvelope`; it persists the public events and separately upserts or deletes resolver-only metadata. `calendar_events` receives no `patient_metadata` field.
- The resolver reads metadata through a dedicated private method, e.g. `_getCalendarEventForPatientResolution(eventId)`, which selects the public calendar row plus `calendar_patient_metadata.metadata_json` only inside the encounter-start transaction.
- All renderer-facing/general calendar accessors must use an explicit `CALENDAR_EVENT_PUBLIC_COLUMNS` projection: `getUpcomingEvents`, active-event queries, range queries, `getCalendarEventById`, and the window-deduplication query. No generic calendar method may contain `SELECT *`, `calendar_events.*`, or include `metadata_json`.
- `gcal-get-upcoming-events` and `gcal-get-event` return only those public projections. They must not perform handler-level redaction as their sole protection; the database contract must already be safe.
- Existing development databases may already have the partial `calendar_events.patient_metadata` column. Migration moves valid sanitized values into `calendar_patient_metadata` transactionally, then ignores the old physical column forever. SQLite column removal is not required; explicit projections make it unreachable. This is a **security data relocation**, not historical patient assignment: it must create no profiles, folders, notes, or encounter links.

### 2. Deterministic identity and controlled resolution state

`patient_profiles.normalized_email` remains unique and authoritative. Keep profile data local/private and use a display name only as a label.

`PatientResolution` is an exact persisted enum:

```text
created
matched
unassigned_missing_email
unassigned_multiple_attendees
unassigned_conflict
unassigned_invalid_metadata
unassigned_folder_unavailable
unassigned_legacy
```

- Fresh `encounters` schema has a `CHECK` on those values; upgrades add `patient_resolution` if absent and install `BEFORE INSERT` and `BEFORE UPDATE OF patient_resolution` triggers that abort values outside this enum. This gives legacy SQLite schemas the same enforcement without a risky `encounters` table rebuild.
- New encounter rows default to `unassigned_missing_email`; migration maps null/unknown legacy values to `unassigned_legacy`.
- If a profile exists but its folder is deleted or no longer private, preserve the profile foreign key for auditability, persist `unassigned_folder_unavailable`, create/reuse the normal Meetings note, and never recreate, move, or rehome the folder. The UI treats this as review-required, not assigned.
- On each start/retry, persist the resolver’s current result, even if a profile id already exists. Do not preserve an old `matched` value with `CASE`/`COALESCE` when the folder is unavailable.
- Group invitations, malformed/missing mail, metadata disagreement, and no external attendee create no profile/folder. A structured email may resolve only when there are no external attendee emails.

### 3. Patient-folder transaction

Within the existing synchronous `startEncounterForCalendarEvent` transaction:

1. Load the private resolver event row (public event data plus resolver-only metadata).
2. Reuse an existing linked profile only when its folder is active and private; otherwise retain the relationship and set the unavailable review state.
3. Resolve exact email. Lookup/create the `patient_profiles` record and private folder under the same transaction and unique email constraint.
4. For a newly created note, put it in the profile folder only for `created`/`matched`; unresolved/review-required notes remain in private Meetings.
5. Persist `note_id`, `patient_profile_id` (when known), and the current controlled resolution; create/reuse `encounter_outputs`.

Folder labels use sanitized display name, otherwise email. A collision adds deterministic ` (2)`, ` (3)` numbering, but never changes identity. Existing folders/profiles are not renamed. Retry of the same event or another event with the same normalized email must not make duplicate notes, profiles, or folders.

### 4. Date-first titles with calendar timezone

`formatEncounterAutoTitle({ startTime, timezone, focus })` must format the date in `timezone` using `Intl.DateTimeFormat(..., { timeZone })`; a missing/invalid calendar timezone falls back to the host local timezone, never UTC via `toISOString()`.

- Initial seed: `YYYY-MM-DD — <calendar summary>` or `YYYY-MM-DD — Encounter`.
- Focus promotion: `YYYY-MM-DD — <brief focus>`.
- The start path passes `calendar_events.timezone`; the focus completion query joins the event timezone before calling the helper.
- `notes.encounter_auto_title_seed` is set only for a note created by this path. Completion changes title only when `notes.title === notes.encounter_auto_title_seed`; it never writes note content or transcript.
- Required boundary case: `2026-08-15T03:30:00Z` with `America/New_York` produces `2026-08-14`, while a UTC event produces `2026-08-15`.

### 5. Explicit renderer-facing review state

Expose only the non-sensitive state needed for clinical workflow:

```ts
type PatientResolution =
  | "created" | "matched"
  | "unassigned_missing_email" | "unassigned_multiple_attendees"
  | "unassigned_conflict" | "unassigned_invalid_metadata"
  | "unassigned_folder_unavailable" | "unassigned_legacy";

interface LocalEncounter {
  // existing fields
  patient_profile_id: number | null;
  patient_resolution: PatientResolution;
}
```

`patient_profile_id` and `patient_resolution` flow only through encounter IPC, never calendar event IPC. Do not expose email, phone, metadata JSON, folder name, or the profile record to the renderer.

`EncounterCard` shows a compact neutral state:

- `created`/`matched`: “Patient folder linked”.
- all `unassigned_*`: “Needs patient review”.

`EncounterHomeView` may surface an aggregate review count/section using the enum only. It does not add manual reassignment in this slice. Translation keys are required; do not hard-code production labels.

## Work packages and exclusive ownership

### Revision 3 package order and interface ownership (binding)

The previous package table is superseded where it conflicts with this ordered interface contract.

| Package | Routing | Exclusive files | Deliverable |
| --- | --- | --- | --- |
| A - Identity/timezone contract | Luna High | `src/helpers/patientIdentity.js`, `test/helpers/patientIdentity.test.js` | Deterministic identity helpers and timezone-aware title format tests, including New York/UTC midnight boundaries. |
| B - Ingress-envelope contract | Terra Medium | `src/helpers/receptionistCalendarBridge.js`, `test/helpers/receptionistCalendarBridge.test.js` | Implement the frozen envelope and metadata-free public sync/result/broadcast shapes. It calls a named DB-ingress adapter but does not alter `database.js`. Tests prove bridge results/broadcasts contain no metadata, structured email/phone, or raw-description sentinels. |
| C - Sidecar sanitization | Terra Medium | `vendor/ai-receptionist/receptionist/reminders/identity.py`, `vendor/ai-receptionist/receptionist/desktop_config.py`, relevant Python tests | Emit only metadata specified by B's frozen envelope from the exact bounded block. No Electron or database files. |
| D - Private DB store, migrations, assignment, focus persistence | Terra High | `src/helpers/database.js`, `test/helpers/calendarDatabase.test.js` | Implement B's private-ingress adapter, resolver-only storage, migrations, explicit public projections, patient transaction, persisted resolution semantics, and full start/focus timezone flow. |
| E - Calendar IPC privacy boundary | Luna High | `src/helpers/ipcHandlers.js`, `test/helpers/calendarIpcPrivacy.test.js` | Consume only D's public DB methods and test both calendar IPC handlers for sentinel absence. |
| F - Encounter review presentation | Luna High | `src/types/electron.ts`, `src/components/EncounterCard.tsx`, `src/components/EncounterHomeView.tsx`, required encounter locale keys, `test/components/encounterHome.test.js` | Present enum-only linked/review state without PHI. |
| G - Derived-focus generation integration | Terra Medium | `src/helpers/clinicalOutputGeneration.ts`, `src/config/prompts/clinicalOutputs.ts`, `src/components/notes/EncounterClinicalOutputs.tsx`, `test/components/encounterClinicalOutputs.test.js` | Request and route focus through the token-aware persistence path; report persistence mismatch rather than editing `database.js`. |
| H - Integration/final validation | Terra High | no independent product files | Review combined diff and validation evidence; replan any contract drift before correction. |

Sequence A, then B. C may run alongside B only because B owns the already-frozen envelope and C cannot alter it. D starts only after B's envelope tests pass. E/F/G may run in parallel only after D exposes final public database and encounter contracts. H runs last. B and D must not run in parallel. No package may make another package's architectural decision; return conflicts to Terra High.

> **Superseded historical draft below.** The following pre-Revision 3 table and its sequencing paragraph are retained only for audit context. They are not an execution contract and must not be used for routing, ownership, or order of work. The binding contract is the Revision 3 table and envelope-first sequence above.

Work proceeds in the listed order. A worker must stop and return an interface conflict to Terra High; it may not alter another package’s contract.

| Package | Routing | Exclusive files | Exact deliverable and acceptance tests |
| --- | --- | --- | --- |
| A — Identity/timezone contract | Luna High | `src/helpers/patientIdentity.js`, `test/helpers/patientIdentity.test.js` | Exact metadata/parser/identity functions; timezone-aware title formatting. Tests valid/malformed blocks, attendee/metadata conflict, groups, fallback, and the New York/UTC midnight boundary. |
| B — Sidecar ingress | Terra Medium | `vendor/ai-receptionist/receptionist/reminders/identity.py`, `vendor/ai-receptionist/receptionist/desktop_config.py`, relevant Python tests, `src/helpers/receptionistCalendarBridge.js`, `test/helpers/receptionistCalendarBridge.test.js` | Exact bounded block is parsed only upstream; bridge transmits only sanitized metadata to the **private database ingestion input**. Canonical events remain metadata-free. Tests reject raw notes/descriptions and invalid/overlong blocks. |
| C — Private DB store, migrations, assignment, focus persistence | Terra High | `src/helpers/database.js`, `test/helpers/calendarDatabase.test.js` | Replace calendar-column metadata storage with `calendar_patient_metadata`; implement explicit public projections, legacy relocation, profile/folder transaction, resolution triggers, unavailable-folder persistence, timezone passed through start/focus flow. DB tests cover fresh and upgrade paths, retry, private folder, collision, review states, and no legacy automatic assignment. |
| D — Calendar IPC privacy boundary | Luna High | `src/helpers/ipcHandlers.js`, `test/helpers/calendarIpcPrivacy.test.js` | Make both `gcal-get-upcoming-events` and `gcal-get-event` rely on safe public DB methods; add handler regression tests proving a DB row containing `patient_metadata`, `metadata_json`, email, phone, and raw description cannot appear in either response. Do not edit database code. |
| E — Encounter review presentation and type contract | Luna High | `src/types/electron.ts`, `src/components/EncounterCard.tsx`, `src/components/EncounterHomeView.tsx`, `src/locales/*` only for needed encounter keys, `test/components/encounterHome.test.js` | Add enum/type fields and assigned/review UI with no PHI. Source/UI contract tests cover both states and assert no metadata/email/phone rendering. |
| F — Derived-focus generation integration | Terra Medium | `src/helpers/clinicalOutputGeneration.ts`, `src/config/prompts/clinicalOutputs.ts`, `src/components/notes/EncounterClinicalOutputs.tsx`, `test/components/encounterClinicalOutputs.test.js` | Ensure focus is requested, stored via the existing token-aware completion path, and failure/staleness leaves title seed unchanged. It may not edit `database.js`; report any persistence mismatch to Terra High. |
| G — Integration and final validation | Terra High | no independent product files; may make a narrowly scoped corrective package only after replanning | Inspect combined diff, resolve contract drift through a new plan cycle, run verification, and issue the final architectural verdict. |

**Non-authoritative historical sequencing:** this paragraph is superseded by the Revision 3 envelope-first sequence above and must not be followed.

## Migration and rollout rules

### Revision 3 migration ordering and cleanup (binding)

Upgrade migration runs in one transaction in this order:

1. Add missing tables/columns needed for the temporary migration state.
2. Map null or unknown legacy resolution values to `unassigned_legacy`.
3. Validate and relocate only valid legacy `calendar_events.patient_metadata` values into `calendar_patient_metadata`.
4. Ignore/remove invalid legacy metadata without logging raw contents.
5. Install fresh-schema `CHECK` and upgraded-schema `BEFORE INSERT` / `BEFORE UPDATE OF patient_resolution` abort triggers.
6. Commit only after public getters have explicit public projections, so no public caller can observe a mixed old/new state.

The migration is data relocation only: it creates no profile, folder, note, encounter link, or historical assignment. `calendar_patient_metadata.calendar_event_id` cascades on event deletion. A later ingress sync with no valid metadata deletes that event's private metadata row and must likewise create no profile/folder/note/encounter association.

Fresh and upgraded-schema tests must directly attempt invalid raw SQL `INSERT` and `UPDATE` values for `patient_resolution`, and assert SQLite aborts every invalid write.

1. On fresh databases, create `patient_profiles`, `calendar_patient_metadata`, profile indexes, resolution columns/constraints, output focus fields, and title seed as needed.
2. On upgraded databases, add missing columns/tables/triggers idempotently. Move valid legacy `calendar_events.patient_metadata` rows to the private table in one transaction; leave invalid rows unassigned and do not log raw values.
3. Do not create a profile/folder or attach a patient to an existing encounter during migration. Only a newly started encounter runs the resolver.
4. If a calendar event subsequently loses metadata, delete its private metadata row on upsert; attendee-based resolution still works.
5. The historical backfill remains a separate preview/confirm feature, explicitly out of scope.

## Revision 5 final Terra High validation gate (historical/non-authoritative)

The final code-review finding is: Google parsing discarded `attendee.self`, while the bridge marked every emitted attendee as `self: false`. That could misidentify a clinician as the patient. H may issue `APPROVE` only after these regressions pass and their output is captured:

```powershell
Push-Location vendor/ai-receptionist
python -m pytest tests/test_patient_metadata.py
Pop-Location

node --test test/helpers/receptionistCalendarBridge.test.js

$env:ELECTRON_RUN_AS_NODE = '1'
$env:REQUIRE_DB_TESTS = '1'
.\node_modules\.bin\electron.cmd --test test/helpers/calendarDatabase.test.js
Remove-Item Env:ELECTRON_RUN_AS_NODE
Remove-Item Env:REQUIRE_DB_TESTS
```

- The Python test proves Google self-only input emits no attendee email and self-plus-one-external input emits exactly that external email, preserving external reminder behavior.
- The bridge test proves it only labels this already-filtered sidecar attendee set as `self: false`, and continues to return/broadcast public-only events.
- The Electron SQLite test proves self-only encounter start is `unassigned_missing_email` with no created profile/folder, and self-plus-one-external start links only the external normalized email.
- Re-run the focused privacy, typecheck, scoped lint, renderer-build, migration, timezone, no-backfill, and manual-title gates already required below. Any regression returns to `ralplan`; it is not patched during final review.

## Historical Revision 4 and earlier verification gates (non-authoritative)

### Revision 3 mandatory evidence

- Bridge tests prove `sync()` results and `gcal-events-synced` broadcasts are public-only. Only the dedicated private DB-ingestion call may receive sanitized metadata. Use metadata-key, email, phone, and raw-description sentinels.
- Electron-compatible database tests cover both fresh and upgraded schema invalid-enum `INSERT`/`UPDATE` aborts, valid/invalid legacy metadata relocation, cascade cleanup on event deletion, metadata deletion on subsequent sync, and no profile/folder/encounter creation during migration or metadata cleanup.
- The timezone suite drives the full `startEncounterForCalendarEvent` and focus-completion path with `2026-08-15T03:30:00Z`: `America/New_York` produces `2026-08-14`; UTC produces `2026-08-15`; invalid timezone uses the documented local-time fallback.
- `REQUIRE_DB_TESTS=1` in an Electron-compatible `better-sqlite3` runtime remains a hard final gate. A skip is a failure, not partial evidence.

The next execution phase is not complete until all applicable evidence exists:

- Unit tests: patient identity/parser including timezone boundary; sidecar/bridge sanitization.
- Database tests, under Electron-compatible `better-sqlite3` runtime: fresh migration; upgrade with old column; public accessor/IPC redaction; one-event retry; same email reuse; same name/different email; multiple/missing/conflicting identity; unavailable private/shared/deleted folder; focus stale-token/manual-title guard; no automatic historical assignment.
- IPC tests invoke both handlers and prove sensitive sentinel values are absent from returned JSON, even if an underlying test fixture includes old-column data.
- UI/type tests prove assigned vs review display and that public types contain no patient metadata fields.
- Run the focused Node suite locally. It is currently valid for pure tests, but database tests are skipped because the installed `better-sqlite3` ABI targets Electron rather than the local Node ABI.
- Required authoritative DB evidence: run the database suite in Electron-compatible CI/runtime after `npm rebuild better-sqlite3` (or the project’s Electron test runner), with `REQUIRE_DB_TESTS=1` so a skip is a failure. Capture fresh and upgrade migration output.
- Then run `npm run typecheck`, scoped lint for feature-owned files, and `npm run build:renderer`. If a repository-wide command fails in pre-existing dirty files, report the exact paths and separately show zero feature-owned findings.

## Historical Revision 4 and earlier final Terra High review checklist (non-authoritative)

### Revision 3 additional approval conditions

7. The private envelope is structurally enforced: bridge returns/broadcasts, public DB getters, and IPC responses can carry public events only; only the dedicated ingestion/resolver methods receive metadata.
8. Upgrade ordering prevents mixed public/private reads, invalid legacy metadata is not surfaced or logged, enum enforcement rejects raw invalid writes on both schema paths, and metadata deletion/cascade cleanup is covered.
9. Full database start and focus-completion timezone flows pass for New York, UTC, and invalid-timezone fallback under the required Electron-compatible runtime.

Approve only if all are true:

1. No generic calendar database method, query, or `gcal-*` IPC response can return patient metadata or raw descriptions.
2. Resolver-only metadata is validated at ingress and used only in the start transaction.
3. Resolution values are controlled and persisted, including unavailable folders; the renderer makes review status visible without exposing PHI.
4. Date formatting honors event timezone, and a manual title survives focus completion and stale generation.
5. Migration/retry/folder uniqueness/private-space behavior passed under a compatible SQLite runtime.
6. No automatic history backfill, fuzzy identity, LLM identity decision, or source-file changes outside the owned packages.

Any failure returns to planning with the failed contract; do not patch it ad hoc during final review.
