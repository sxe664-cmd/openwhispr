const test = require("node:test");
const assert = require("node:assert/strict");

const WindowManager = require("../../src/helpers/windowManager.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeWindow() {
  let visible = false;
  let destroyed = false;
  const messages = [];

  return {
    messages,
    isDestroyed: () => destroyed,
    isMinimized: () => false,
    isVisible: () => visible,
    showInactive: () => {
      visible = true;
    },
    show: () => {
      visible = true;
    },
    focus: () => {},
    hide: () => {
      visible = false;
    },
    destroy: () => {
      destroyed = true;
      visible = false;
    },
    webContents: {
      send: (channel, payload) => messages.push({ channel, payload }),
    },
  };
}

function lifecycleManager() {
  const manager = Object.create(WindowManager.prototype);
  manager.mainWindow = null;
  manager._mainWindowCreationPromise = null;
  manager.isQuitting = false;
  manager._isDictatingToggle = false;
  manager._dictationLifecycleGeneration = 0;
  manager.macCompoundPushState = null;
  manager.winPushState = null;
  manager.hotkeyManager = {
    isInListeningMode: () => false,
    setMainWindow: () => {},
  };
  manager._repositionToActiveDisplay = async () => {};
  return manager;
}

test("cold lifecycle state has no dictation window until ensureMainWindow", async () => {
  const manager = lifecycleManager();
  let createCount = 0;
  const window = fakeWindow();

  manager._createMainWindow = async () => {
    createCount += 1;
    manager.mainWindow = window;
    return window;
  };

  assert.equal(manager.mainWindow, null);
  assert.equal(createCount, 0);

  await manager.ensureMainWindow();
  assert.equal(createCount, 1);
});

test("concurrent first-use actions share one window creation promise", async () => {
  const manager = lifecycleManager();
  const loading = deferred();
  const window = fakeWindow();
  let createCount = 0;

  manager._createMainWindow = async () => {
    createCount += 1;
    await loading.promise;
    manager.mainWindow = window;
    return window;
  };

  const first = manager.sendToggleDictation();
  const second = manager.sendToggleVoiceAgent();
  await Promise.resolve();
  assert.equal(createCount, 1);
  assert.deepEqual(window.messages, []);

  loading.resolve();
  await Promise.all([first, second]);

  assert.equal(createCount, 1);
  const channels = window.messages.map(({ channel }) => channel);
  assert.ok(channels.includes("toggle-dictation"));
  assert.ok(channels.includes("toggle-voice-agent"));
  assert.ok(channels.includes("prepare-dictation"));
});

test("closing the console during first-use loading invalidates the pending tap", async () => {
  const manager = lifecycleManager();
  const loading = deferred();
  const window = fakeWindow();

  manager._createMainWindow = async () => {
    await loading.promise;
    manager.mainWindow = window;
    return window;
  };

  const pendingTap = manager.sendToggleDictation();
  await Promise.resolve();
  await manager.cancelAndHideDictation();
  loading.resolve();
  await pendingTap;

  assert.deepEqual(window.messages, []);
  assert.equal(window.isVisible(), false);
});

test("push-to-talk release during lazy loading never starts recording", async () => {
  const manager = lifecycleManager();
  const loading = deferred();
  const window = fakeWindow();

  manager._createMainWindow = async () => {
    await loading.promise;
    manager.mainWindow = window;
    return window;
  };

  const pendingPress = manager.startWindowsPushToTalk("F8");
  await Promise.resolve();
  assert.equal(manager.winPushState?.active, true);

  manager.handleWindowsPushKeyUp("F8");
  assert.equal(manager.winPushState, null);

  loading.resolve();
  await pendingPress;

  assert.deepEqual(window.messages, []);
  assert.equal(window.isVisible(), false);
});

test("push-to-talk release while start is loading cannot start after stop", async () => {
  const manager = lifecycleManager();
  const window = fakeWindow();
  const startLoading = deferred();
  manager.mainWindow = window;
  manager._createMainWindow = async () => window;
  manager.showDictationPanel = () => startLoading.promise;

  await manager.startWindowsPushToTalk("F8");
  await new Promise((resolve) => setTimeout(resolve, 170));
  assert.equal(manager.winPushState?.isRecording, true);

  manager.handleWindowsPushKeyUp("F8");
  startLoading.resolve();
  await Promise.resolve();

  assert.deepEqual(
    window.messages.map(({ channel }) => channel),
    ["prepare-dictation", "stop-dictation"]
  );
});

test("cancelAndHideDictation resets state and hides an existing widget", async () => {
  const manager = lifecycleManager();
  const window = fakeWindow();
  window.show();
  manager.mainWindow = window;
  manager.winPushState = { active: true, isRecording: true, key: "F8" };
  manager._isDictatingToggle = true;
  manager.meetingDetectionEngine = {
    states: [],
    setUserRecording(value) {
      this.states.push(value);
    },
  };

  await manager.cancelAndHideDictation();

  assert.equal(window.isVisible(), false);
  assert.equal(manager.winPushState, null);
  assert.equal(manager._isDictatingToggle, false);
  assert.deepEqual(
    window.messages.map(({ channel }) => channel),
    ["cancel-dictation-preparation", "cancel-hotkey-pressed"]
  );
  assert.deepEqual(manager.meetingDetectionEngine.states, [false]);
});
