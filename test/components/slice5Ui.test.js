const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("calendar UI defaults to Day and uses bounded list/calendar APIs", () => {
  const view = read("src/components/CalendarRemindersView.tsx");
  const hook = read("src/hooks/useCalendarEvents.ts");
  assert.match(view, /useState<CalendarView>\("day"\)/);
  assert.match(view, /Previous period/);
  assert.match(view, /Next period/);
  assert.match(view, /type="date"/);
  assert.match(view, /appointment-card/);
  assert.match(read("src/index.css"), /\.appointment-actions button\.is-used[\s\S]*linear-gradient/);
  assert.match(read("src/index.css"), /\.encounter-card,[\s\S]*\.appointment-card[\s\S]*linear-gradient\(180deg/);
  assert.doesNotMatch(view, /startEncounter/);
  assert.doesNotMatch(view, /LocalEncounter/);
  assert.match(hook, /gcalListEvents/);
  assert.match(hook, /startIso/);
  assert.match(hook, /endIso/);
  assert.match(hook, /gcalGetCalendars/);
  assert.match(hook, /limit: view === "month" \? 500 : 200/);
  assert.match(view, /sendAppointmentEmail/);
  assert.match(view, /sendAppointmentSms/);
  assert.match(view, /getAppointmentReminderStatuses/);
  assert.doesNotMatch(view, /Send (SMS|email) again|window\.confirm/);
});

test("Home uses the main-process local-day boundary and settings persist through preload", () => {
  const homeHook = read("src/hooks/useEncounters.ts");
  const settings = read("src/components/AIReceptionistView.tsx");
  assert.match(homeHook, /getEncountersForLocalDay\?\./);
  assert.match(settings, /getReceptionistConfig/);
  assert.match(settings, /saveReceptionistConfig/);
  assert.match(settings, /getMessageConfig/);
  assert.match(settings, /saveMessageConfig/);
  assert.match(settings, /getPostAppointmentWorkspace/);
  assert.match(settings, /savePostAppointmentConfig/);
  assert.match(settings, /getEmailSetup/);
  assert.match(settings, /saveEmailSetup/);
  assert.match(settings, /thank_you_review/);
  assert.match(settings, /book_next_appointment/);
  assert.match(settings, /1, Math\.min\(365/);
});
