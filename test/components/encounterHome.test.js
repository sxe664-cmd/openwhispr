const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Home renders encounter cards from the local encounter hook and preserves cached state", () => {
  const hook = read("src/hooks/useEncounters.ts");
  const home = read("src/components/EncounterHomeView.tsx");
  const card = read("src/components/EncounterCard.tsx");

  assert.match(hook, /getEncountersForLocalDay/);
  assert.doesNotMatch(hook, /getEncounters\?\./);
  assert.match(hook, /onGcalEventsSynced/);
  assert.match(home, /useEncounters/);
  assert.match(home, /cachedDescription/);
  assert.match(card, /data-state=\{encounter\.lifecycle_state\}/);
  assert.match(card, /encounters\.context\.inPerson/);
  assert.match(card, /patient_profile_id/);
  assert.match(card, /patient_resolution/);
  assert.match(card, /encounters\.patient\.linked/);
  assert.match(card, /encounters\.patient\.review/);
  assert.match(card, /data-testid="encounter-patient-state"/);
  assert.doesNotMatch(card, /patient_metadata|metadata_json|patient\.(email|phone)|folder\.name/);
});

test("Encounter patient state is assigned only for created or matched profiles", () => {
  const card = read("src/components/EncounterCard.tsx");

  assert.match(card, /patient_profile_id !== null/);
  assert.match(card, /patient_resolution === "created"/);
  assert.match(card, /patient_resolution === "matched"/);
  assert.match(card, /: "review"/);
});

test("Home start and open actions reuse existing encounter IPC/navigation paths", () => {
  const home = read("src/components/EncounterHomeView.tsx");
  const history = read("src/components/HistoryView.tsx");
  const upcoming = read("src/components/UpcomingMeetings.tsx");
  const card = read("src/components/EncounterCard.tsx");

  assert.match(home, /startEncounter\(encounter\.calendar_event_id/);
  assert.match(home, /getEncounter\?\.\(encounter\.id\)/);
  assert.match(home, /agentOpenNote/);
  assert.match(home, /meetingContext: "in_person"/);
  assert.doesNotMatch(card, /encounters\.context\.telehealth/);
  assert.doesNotMatch(card, /setMeetingContext|useState<MeetingContext>/);
  assert.match(read("src/components/EncounterCard.tsx"), /encounters\.startEncounter/);
  assert.match(history, /EncounterHomeView/);
  assert.match(history, /quickDictation/);
  assert.match(upcoming, /EncounterCard/);
  assert.doesNotMatch(home, /startRecording|diariz|transcri/i);
});

test("Home keeps cached cards visible and avoids a false empty state on sync/read failure", () => {
  const hook = read("src/hooks/useEncounters.ts");
  const home = read("src/components/EncounterHomeView.tsx");

  assert.match(hook, /Promise\.allSettled/);
  assert.match(hook, /syncResult\.success !== true/);
  assert.match(hook, /encountersRef\.current/);
  assert.match(home, /role="alert"/);
  assert.match(home, /encounters\.length === 0 && error/);
  assert.match(home, /!error/);
  assert.doesNotMatch(home, /error && encounters\.length === 0 && syncState === "error"/);
});
