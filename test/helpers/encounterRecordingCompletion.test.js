const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const broadcasts = [];

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersModulePath && request === "./windowBroadcast") {
    return {
      broadcastToWindows: (channel, payload) => broadcasts.push({ channel, payload }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function anything() {
  return new Proxy(function () {}, {
    get: (target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

function buildFakeThis() {
  const target = {
    databaseManager: {
      completeEncounterRecording: (_noteId, transcript) => ({
        success: true,
        note: { id: 17, transcript },
        encounter: { id: 23, lifecycle_state: "completed" },
        output: null,
      }),
    },
    _asyncVectorUpsert: () => {
      target.vectorUpserted = true;
    },
    _asyncMirrorWrite: () => {
      target.mirrorWritten = true;
    },
  };
  const fake = new Proxy(target, {
    get: (object, property) => (property in object ? object[property] : anything()),
  });
  return fake;
}

let completionHandler;
test.before(() => {
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  const fake = buildFakeThis();
  Object.setPrototypeOf(fake, Ctor.prototype);
  Ctor.prototype.setupHandlers.call(fake);
  completionHandler = handlers.get("encounter-recording-complete");
  assert.ok(completionHandler, "encounter completion handler must be registered");
});

test.after(() => {
  Module._load = originalLoad;
});

test("final encounter completion publishes the canonical note for live renderer refresh", async () => {
  broadcasts.length = 0;

  for (const transcript of [
    '[{"text":"Short recording"}]',
    '[{"speaker":"SPEAKER_00","text":"Diarization failed but transcript remains"}]',
  ]) {
    const result = await completionHandler({ sender: {} }, 17, transcript);
    assert.equal(result.success, true);
    await new Promise((resolve) => setImmediate(resolve));
  }

  const noteEvents = broadcasts.filter((entry) => entry.channel === "note-updated");
  assert.equal(noteEvents.length, 2);
  assert.equal(noteEvents.at(-1).payload.transcript, '[{"speaker":"SPEAKER_00","text":"Diarization failed but transcript remains"}]');
});
