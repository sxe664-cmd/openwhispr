const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { AIReceptionistRuntime } = require("../../src/helpers/aiReceptionistRuntime");

const SENSITIVE_DETAILS = [
  "C:\\Users\\santi\\AppData\\Roaming\\AIReceptionist\\token.json",
  "/Users/santi/AIReceptionist/.env.local",
  "super-secret-value",
  "oauth-refresh-token",
  "Bearer private-access-token",
  "session_cookie=private-cookie",
  "--calendar-id secret-calendar",
];

function assertRendererSafe(value) {
  const text = JSON.stringify(value);
  for (const detail of SENSITIVE_DETAILS) {
    assert.doesNotMatch(text, new RegExp(detail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
}

function makeChild({ pid = 1234 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = 0;
  child.kill = () => { child.killCalls += 1; };
  return child;
}

function makeLayout(t, { packaged = false, platform = "win32", devPythonRuntime = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-ai-receptionist-"));
  const userData = path.join(root, "user-data");
  const resources = path.join(root, "resources");
  const source = packaged ? path.join(resources, "ai-receptionist") : path.join(root, "AIReceptionist");
  const seed = packaged ? path.join(resources, "ai-receptionist-seed") : source;
  fs.mkdirSync(path.join(source, "receptionist"), { recursive: true });
  fs.mkdirSync(seed, { recursive: true });
  if (packaged) {
    const runtime = path.join(resources, "ai-receptionist-python-runtime", platform === "win32" ? "Scripts" : "bin");
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, platform === "win32" ? "python.exe" : "python3"), "");
  }
  if (devPythonRuntime) {
    const runtime = path.join(source, "python-runtime", platform === "win32" ? "Scripts" : "bin");
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, platform === "win32" ? "python.exe" : "python3"), "");
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, userData, resources, source, seed };
}

test("packaged runtime uses the bundled Python executable and keeps private paths in the process environment", (t) => {
  const layout = makeLayout(t, { packaged: true });
  fs.writeFileSync(
    path.join(layout.seed, ".env.local"),
    [
      "LIVEKIT_URL=wss://private-livekit.example",
      "LIVEKIT_API_KEY=private-livekit-key",
      "LIVEKIT_API_SECRET=private-livekit-secret",
      "OPENAI_API_KEY=private-openai-key",
      "RECEPTIONIST_AGENT_NAME=receptionist",
    ].join("\n"),
    "utf8",
  );
  const runtime = new AIReceptionistRuntime({
    isPackaged: true,
    platform: "win32",
    resourcesPath: layout.resources,
    userDataPath: layout.userData,
  });

  assert.deepEqual(runtime.resolvePython(), {
    command: path.join(layout.resources, "ai-receptionist-python-runtime", "Scripts", "python.exe"),
    prefix: [],
  });
  const env = runtime.createEnvironment();
  assert.equal(env.RECEPTIONIST_RUNTIME_ROOT, path.join(layout.userData, "ai-receptionist"));
  assert.equal(env.RECEPTIONIST_SEED_ROOT, layout.seed);
  assert.match(env.PYTHONPATH, /ai-receptionist/);
  assert.equal(env.LIVEKIT_URL, "wss://private-livekit.example");
  assert.equal(env.LIVEKIT_API_KEY, "private-livekit-key");
  assert.equal(env.LIVEKIT_API_SECRET, "private-livekit-secret");
  assert.equal(env.OPENAI_API_KEY, "private-openai-key");
  assert.equal(env.RECEPTIONIST_AGENT_NAME, "receptionist");
  assert.equal(runtime.getStatus().available, true);
});

test("packaged sidecars discover the staged nested Dad seed", (t) => {
  const layout = makeLayout(t, { packaged: true });
  const nestedSeed = path.join(layout.source, "dad-seed");
  fs.rmSync(path.join(layout.resources, "ai-receptionist-seed"), { recursive: true, force: true });
  fs.mkdirSync(path.join(nestedSeed, "config"), { recursive: true });
  fs.writeFileSync(path.join(nestedSeed, "config", "app.yaml"), "calendar: {}\n");
  fs.writeFileSync(path.join(nestedSeed, ".env.local"), "LIVEKIT_URL=wss://nested-seed.example\n");

  const runtime = new AIReceptionistRuntime({
    isPackaged: true,
    platform: "win32",
    resourcesPath: layout.resources,
    userDataPath: layout.userData,
  });

  assert.equal(runtime.resolvePaths().seedRoot, nestedSeed);
  assert.equal(runtime.createEnvironment().LIVEKIT_URL, "wss://nested-seed.example");
  assert.equal(runtime.getStatus().seedAvailable, true);
});

test("development prefers the sibling bundled Python runtime and otherwise falls back safely", (t) => {
  const bundled = makeLayout(t, { devPythonRuntime: true });
  const bundledRuntime = new AIReceptionistRuntime({
    platform: "win32",
    devReceptionistRoot: bundled.source,
    userDataPath: bundled.userData,
  });
  assert.deepEqual(bundledRuntime.resolvePython(), {
    command: path.join(bundled.source, "python-runtime", "Scripts", "python.exe"),
    prefix: [],
  });
  assert.equal(bundledRuntime.getStatus().bundledPythonAvailable, true);

  const fallback = makeLayout(t);
  const fallbackRuntime = new AIReceptionistRuntime({
    platform: "win32",
    devReceptionistRoot: fallback.source,
    userDataPath: fallback.userData,
  });
  assert.deepEqual(fallbackRuntime.resolvePython(), { command: "py", prefix: ["-3"] });
  assert.equal(fallbackRuntime.getStatus().bundledPythonAvailable, false);
});

test("one-shot commands replace path and credential-shaped child output with a fixed public error", async (t) => {
  const layout = makeLayout(t);
  let child;
  const runtime = new AIReceptionistRuntime({
    platform: "win32",
    devReceptionistRoot: layout.source,
    userDataPath: layout.userData,
    pythonCommand: "python-test",
    spawn: () => {
      child = makeChild();
      queueMicrotask(() => {
        child.stderr.emit("data", [
          "C:\\Users\\santi\\AppData\\Roaming\\AIReceptionist\\token.json",
          "/Users/santi/AIReceptionist/.env.local",
          '{"refresh_token":"oauth-refresh-token","client_secret":"super-secret-value"}',
          "Authorization: Bearer private-access-token",
          "session_cookie=private-cookie",
        ].join("\n"));
        child.stdout.emit("data", "python -m receptionist.desktop_config --calendar-id secret-calendar");
        child.emit("close", 1);
      });
      return child;
    },
  });

  const result = await runtime.runModule("receptionist.desktop_config", ["get"]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AI_RECEPTIONIST_COMMAND_FAILED");
  assert.equal(result.error.message, "AIReceptionist could not complete that request.");
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assertRendererSafe(result);
});

test("spawn and agent failures never expose exception text through results or status", async (t) => {
  const layout = makeLayout(t);
  const privateError = new Error(`${SENSITIVE_DETAILS.join(" ")} --calendar-id secret-calendar`);
  const logs = [];
  const runtime = new AIReceptionistRuntime({
    platform: "win32",
    devReceptionistRoot: layout.source,
    userDataPath: layout.userData,
    pythonCommand: "python-test",
    spawn: () => { throw privateError; },
    log: (...args) => logs.push(args),
  });

  const commandFailure = await runtime.runModule("receptionist.desktop_config", ["get"]);
  assert.deepEqual(commandFailure.error, {
    code: "AI_RECEPTIONIST_SPAWN_FAILED",
    message: "AIReceptionist could not start.",
  });
  assertRendererSafe(commandFailure);

  const agentFailure = await runtime.startAgent({ enabled: true });
  assert.equal(agentFailure.error.code, "AI_RECEPTIONIST_SPAWN_FAILED");
  assertRendererSafe(agentFailure);
  assertRendererSafe(runtime.getStatus());
  assertRendererSafe(logs);
  assert.deepEqual(logs[0], ["AIReceptionist operation failed", {
    operation: "spawn-command",
    code: "AI_RECEPTIONIST_SPAWN_FAILED",
  }]);
});

test("one-shot commands time out and terminate their Windows process tree", async (t) => {
  const layout = makeLayout(t);
  let child;
  const terminations = [];
  const runtime = new AIReceptionistRuntime({
    platform: "win32",
    devReceptionistRoot: layout.source,
    userDataPath: layout.userData,
    pythonCommand: "python-test",
    commandTimeoutMs: 5,
    terminateProcessTree: (target) => terminations.push(target.pid),
    spawn: () => {
      child = makeChild();
      return child;
    },
  });

  const result = await runtime.runPython(["--version"]);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.error.code, "AI_RECEPTIONIST_TIMEOUT");
  assert.deepEqual(terminations, [child.pid]);
});

test("Windows process-tree termination uses taskkill with child descendants", () => {
  const child = makeChild({ pid: 4567 });
  const invocations = [];
  const runtime = new AIReceptionistRuntime({
    platform: "win32",
    processTreeSpawn: (command, args, options) => {
      invocations.push({ command, args, options });
      return new EventEmitter();
    },
  });

  runtime.terminateProcessTree(child);
  assert.deepEqual(invocations, [{
    command: "taskkill",
    args: ["/PID", "4567", "/T", "/F"],
    options: { shell: false, stdio: "ignore", windowsHide: true },
  }]);
  assert.equal(child.killCalls, 0);
});

test("the long-running agent is not started unless it is explicitly enabled", async (t) => {
  const layout = makeLayout(t);
  let spawnCount = 0;
  const runtime = new AIReceptionistRuntime({
    platform: "win32",
    devReceptionistRoot: layout.source,
    userDataPath: layout.userData,
    pythonCommand: "python-test",
    spawn: () => { spawnCount += 1; return makeChild(); },
  });

  const result = await runtime.startAgent();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AI_RECEPTIONIST_AGENT_DISABLED");
  assert.equal(spawnCount, 0);
});

test("an explicitly enabled agent is initialized once and supervised without launching Electron", async (t) => {
  const layout = makeLayout(t);
  const invocations = [];
  const runtime = new AIReceptionistRuntime({
    platform: "win32",
    devReceptionistRoot: layout.source,
    userDataPath: layout.userData,
    pythonCommand: "python-test",
    spawn: (_command, args) => {
      invocations.push(args);
      const child = makeChild({ pid: invocations.length });
      if (invocations.length === 1) {
        queueMicrotask(() => child.emit("close", 0));
      }
      return child;
    },
  });

  const result = await runtime.startAgent({ enabled: true });
  assert.deepEqual(result, { ok: true, pid: 2 });
  assert.deepEqual(invocations[0].slice(0, 2), ["-c", "from receptionist.runtime import ensure_app_runtime; ensure_app_runtime()"]);
  assert.deepEqual(invocations[1], ["-m", "receptionist.agent", "dev"]);
  assert.equal(runtime.getStatus().agent.running, true);
  assert.equal(runtime.getStatus().agent.enabled, true);
});

test("stopping a supervised agent leaves a clean stopped status", async (t) => {
  const layout = makeLayout(t);
  const children = [];
  const runtime = new AIReceptionistRuntime({
    platform: "win32",
    devReceptionistRoot: layout.source,
    userDataPath: layout.userData,
    pythonCommand: "python-test",
    terminateProcessTree: (child) => child.kill(),
    spawn: () => {
      const child = makeChild({ pid: children.length + 1 });
      children.push(child);
      if (children.length === 1) queueMicrotask(() => child.emit("close", 0));
      if (children.length === 2) child.kill = () => queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  });

  await runtime.startAgent({ enabled: true });
  assert.deepEqual(await runtime.stopAgent(), { ok: true, stopped: true });
  assert.equal(runtime.getStatus().agent.state, "stopped");
  assert.equal(runtime.getStatus().agent.message, "");
});
