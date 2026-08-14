const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("AIReceptionist product surfaces use only managed status and bounded local APIs", () => {
  const calendarPage = read("src/components/CalendarRemindersView.tsx");
  const receptionistPage = read("src/components/AIReceptionistView.tsx");
  const hook = read("src/components/ai-receptionist/useManagedCalendar.ts");
  const boundedHook = read("src/hooks/useCalendarEvents.ts");
  const combined = `${calendarPage}\n${receptionistPage}\n${hook}\n${boundedHook}`;

  assert.match(combined, /gcalGetConnectionStatus/);
  assert.match(combined, /gcalListEvents/);
  assert.match(combined, /gcalGetCalendarStatus/);
  assert.match(receptionistPage, /getReceptionistConfig/);
  assert.match(receptionistPage, /savePostAppointmentConfig/);
  assert.match(combined, /Managed by AIReceptionist|managed by AIReceptionist/);
  assert.doesNotMatch(combined, /gcalStartOAuth|gcalDisconnect|\.env|client_secret|token/i);
});

test("managed calendar status renders fixed state copy rather than arbitrary IPC error text", () => {
  const status = read("src/components/ai-receptionist/ManagedCalendarStatus.tsx");
  const hook = read("src/components/ai-receptionist/useManagedCalendar.ts");
  const pages = `${read("src/components/CalendarRemindersView.tsx")}\n${read("src/components/AIReceptionistView.tsx")}`;

  assert.match(status, /description:\s*"AIReceptionist could not refresh just now/);
  assert.doesNotMatch(status, /\{error\s*\|\|\s*copy\.description\}/);
  assert.doesNotMatch(status, /error\?:\s*string/);
  assert.match(hook, /errorCode/);
  assert.doesNotMatch(pages, /ManagedCalendarStatus[^\n]*error=/);
});

test("sidebar and settings point to dedicated Calendar & Reminders and AI Receptionist surfaces", () => {
  const sidebar = read("src/components/ControlPanelSidebar.tsx");
  const panel = read("src/components/ControlPanel.tsx");
  const settings = read("src/components/SettingsPage.tsx");

  assert.match(sidebar, /id: "calendar-reminders"/);
  assert.match(sidebar, /id: "ai-receptionist"/);
  assert.match(panel, /CalendarRemindersView/);
  assert.match(panel, /AIReceptionistView/);
  assert.match(settings, /case "calendarReminders":\s*return \(\s*<CalendarRemindersView embedded \/>\s*\)/);
  assert.match(settings, /case "aiReceptionist":\s*return <AIReceptionistView embedded \/>;/);
});

test("AI Receptionist surfaces keep panels and message fields visually distinct", () => {
  const receptionistPage = read("src/components/AIReceptionistView.tsx");
  const status = read("src/components/ai-receptionist/AIReceptionistStatus.tsx");
  const styles = read("src/index.css");

  assert.match(receptionistPage, /ai-receptionist-editor-card/);
  assert.match(receptionistPage, /ai-receptionist-message-field/);
  assert.match(receptionistPage, /ai-receptionist-preview/);
  assert.match(status, /ai-receptionist-status-panel/);
  assert.match(styles, /\.ai-receptionist-editor-card[\s\S]*linear-gradient\(180deg/);
  assert.match(styles, /\.ai-receptionist-view textarea[\s\S]*background-color/);
});
