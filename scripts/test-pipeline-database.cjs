const { spawnSync } = require("node:child_process");
const path = require("node:path");
const electron = require("electron");

// better-sqlite3 is installed for the app's Electron ABI, not the shell Node ABI.
// Keep each fixture's Electron module stub and temporary database isolated.
const tests = [
  "test/helpers/calendarDatabase.test.js",
  "test/helpers/noteTemplatesDatabase.test.js",
  "test/helpers/receptionistCalendarPatientResolution.integration.test.js",
];
for (const file of tests) {
  const result = spawnSync(electron, [file], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", REQUIRE_DB_TESTS: "1" },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    console.error(`Database gate failed: ${file}`);
    process.exit(result.status || 1);
  }
}
