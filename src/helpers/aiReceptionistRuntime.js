const fs = require("fs");
const path = require("path");
const { spawn: nodeSpawn } = require("child_process");
const dotenv = require("dotenv");

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

/**
 * This is the only error shape that may leave the AIReceptionist runtime.
 * Do not derive messages from child-process output or exceptions: both can
 * contain paths, command arguments, environment values, or credentials.
 */
const PUBLIC_ERROR_MESSAGES = Object.freeze({
  AI_RECEPTIONIST_UNAVAILABLE: "AIReceptionist is unavailable in this build.",
  AI_RECEPTIONIST_RUNTIME_UNAVAILABLE: "AIReceptionist's local runtime is unavailable.",
  AI_RECEPTIONIST_INVALID_COMMAND: "AIReceptionist could not complete that request.",
  AI_RECEPTIONIST_SPAWN_FAILED: "AIReceptionist could not start.",
  AI_RECEPTIONIST_TIMEOUT: "AIReceptionist took too long to respond.",
  AI_RECEPTIONIST_COMMAND_FAILED: "AIReceptionist could not complete that request.",
  AI_RECEPTIONIST_INVALID_RESPONSE: "AIReceptionist returned an invalid response.",
  AI_RECEPTIONIST_AGENT_DISABLED: "AIReceptionist agent is disabled.",
  AI_RECEPTIONIST_AGENT_START_FAILED: "AIReceptionist agent could not start.",
  AI_RECEPTIONIST_AGENT_STOP_FAILED: "AIReceptionist agent could not stop.",
  AI_RECEPTIONIST_AGENT_STOP_TIMEOUT: "AIReceptionist agent did not stop in time.",
  AI_RECEPTIONIST_AGENT_EXITED: "AIReceptionist agent stopped unexpectedly.",
  AI_RECEPTIONIST_AUTH_STATUS_FAILED: "Google Calendar authorization status is unavailable.",
  AI_RECEPTIONIST_AUTH_SETUP_FAILED: "Google Calendar authorization could not be started.",
  AI_RECEPTIONIST_SETUP_REQUIRED: "Google Calendar setup is required.",
  AI_RECEPTIONIST_AUTHORIZATION_REQUIRED: "Google Calendar authorization is required.",
  AI_RECEPTIONIST_PERMISSION_DENIED: "Google Calendar permission was denied.",
  AI_RECEPTIONIST_PROVIDER_FAILED: "The calendar provider could not complete that request.",
  AI_RECEPTIONIST_CONFIG_INVALID: "The AIReceptionist configuration is invalid.",
  AI_RECEPTIONIST_CONFIG_SAVE_FAILED: "The AIReceptionist configuration could not be saved.",
  AI_RECEPTIONIST_EVENT_NOT_FOUND: "That appointment is no longer available.",
  AI_RECEPTIONIST_EMAIL_NOT_ELIGIBLE: "Email is unavailable for this appointment.",
  AI_RECEPTIONIST_SMS_NOT_ELIGIBLE: "SMS is unavailable for this appointment.",
});

function serializedError(code) {
  const safeCode = Object.hasOwn(PUBLIC_ERROR_MESSAGES, code)
    ? code
    : "AI_RECEPTIONIST_COMMAND_FAILED";
  return { code: safeCode, message: PUBLIC_ERROR_MESSAGES[safeCode] };
}

function existingPath(paths, existsSync) {
  return paths.find((candidate) => candidate && existsSync(candidate)) || null;
}

function terminateProcessTree(child, { platform = process.platform, spawn = nodeSpawn } = {}) {
  if (!child) return;

  if (platform === "win32" && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      const terminator = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      terminator?.once?.("error", () => {
        try { child.kill(); } catch { /* best-effort fallback */ }
      });
      return;
    } catch {
      // Fall through to the child-process fallback when taskkill cannot start.
    }
  }

  try { child.kill("SIGTERM"); } catch { /* best effort */ }
}

class AIReceptionistRuntime {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    this.path = options.path || path;
    this.spawn = options.spawn || nodeSpawn;
    this.processTreeSpawn = options.processTreeSpawn || nodeSpawn;
    this.platform = options.platform || process.platform;
    this.isPackaged = Boolean(options.isPackaged);
    this.resourcesPath = options.resourcesPath || process.resourcesPath || null;
    this.projectRoot = options.projectRoot || this.path.resolve(__dirname, "..", "..");
    const embeddedReceptionistRoot = this.path.join(this.projectRoot, "vendor", "ai-receptionist");
    const siblingReceptionistRoot = this.path.resolve(this.projectRoot, "..", "AIReceptionist");
    this.devReceptionistRoot = options.devReceptionistRoot
      || process.env.AI_RECEPTIONIST_ROOT
      || existingPath([
        embeddedReceptionistRoot,
        siblingReceptionistRoot,
      ], this.fs.existsSync.bind(this.fs))
      || siblingReceptionistRoot;
    this.userDataPath = options.userDataPath || null;
    this.getUserDataPath = options.getUserDataPath || (() => this.userDataPath);
    this.pythonCommand = options.pythonCommand || process.env.PYTHON || process.env.PYTHON_EXECUTABLE || null;
    this.commandTimeoutMs = options.commandTimeoutMs || DEFAULT_COMMAND_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs || DEFAULT_STOP_TIMEOUT_MS;
    this.log = options.log || (() => {});
    this.agentEnabled = options.agentEnabled === true;
    this.terminateProcessTree = options.terminateProcessTree
      || ((child) => terminateProcessTree(child, {
        platform: this.platform,
        spawn: this.processTreeSpawn,
      }));
    this.agentProcess = null;
    this.agentStartPromise = null;
    this.agentStopRequested = false;
    this.agentStatus = {
      enabled: this.agentEnabled,
      running: false,
      pid: null,
      state: "stopped",
      message: "",
      errorCode: null,
    };
  }

  resolvePaths() {
    const sourceRoot = this.isPackaged
      ? existingPath([
        this.resourcesPath && this.path.join(this.resourcesPath, "ai-receptionist"),
        this.resourcesPath && this.path.join(this.resourcesPath, "app.asar.unpacked", "ai-receptionist"),
      ], this.fs.existsSync.bind(this.fs))
      : this.devReceptionistRoot;
    const runtimeRoot = this.getUserDataPath()
      ? this.path.join(this.getUserDataPath(), "ai-receptionist")
      : null;
    const seedRoot = this.isPackaged
      ? existingPath([
        this.resourcesPath && this.path.join(this.resourcesPath, "ai-receptionist-seed"),
        this.resourcesPath && this.path.join(this.resourcesPath, "dad-seed"),
        sourceRoot && this.path.join(sourceRoot, "dad-seed"),
        sourceRoot,
      ], this.fs.existsSync.bind(this.fs))
      : existingPath([
        sourceRoot && this.path.join(sourceRoot, "private-seed"),
        sourceRoot,
      ], this.fs.existsSync.bind(this.fs));
    const pythonRuntimeRoot = existingPath([
      this.isPackaged && runtimeRoot && this.path.join(runtimeRoot, "python-runtime"),
      sourceRoot && this.path.join(sourceRoot, "python-runtime"),
      this.isPackaged && this.resourcesPath && this.path.join(this.resourcesPath, "ai-receptionist-python-runtime"),
      this.isPackaged && this.resourcesPath && this.path.join(this.resourcesPath, "python-runtime"),
    ], this.fs.existsSync.bind(this.fs));

    return { sourceRoot, runtimeRoot, seedRoot, pythonRuntimeRoot };
  }

  resolvePython() {
    const paths = this.resolvePaths();
    if (this.isPackaged) {
      const runtimeRoot = paths.pythonRuntimeRoot;
      if (!runtimeRoot) return null;
      const executable = this.platform === "win32"
        ? this.path.join(runtimeRoot, "Scripts", "python.exe")
        : existingPath([
          this.path.join(runtimeRoot, "bin", "python3"),
          this.path.join(runtimeRoot, "bin", "python"),
        ], this.fs.existsSync.bind(this.fs));
      return executable && this.fs.existsSync(executable) ? { command: executable, prefix: [] } : null;
    }
    if (this.pythonCommand) return { command: this.pythonCommand, prefix: [] };
    const runtimeRoot = paths.pythonRuntimeRoot;
    const bundledExecutable = runtimeRoot && (this.platform === "win32"
      ? this.path.join(runtimeRoot, "Scripts", "python.exe")
      : existingPath([
        this.path.join(runtimeRoot, "bin", "python3"),
        this.path.join(runtimeRoot, "bin", "python"),
      ], this.fs.existsSync.bind(this.fs)));
    if (bundledExecutable && this.fs.existsSync(bundledExecutable)) {
      return { command: bundledExecutable, prefix: [] };
    }
    return this.platform === "win32"
      ? { command: "py", prefix: ["-3"] }
      : { command: "python3", prefix: [] };
  }

  createEnvironment(overrides = {}) {
    const paths = this.resolvePaths();
    const pythonPath = [
      paths.sourceRoot,
      ...this._sitePackages(paths.pythonRuntimeRoot),
      process.env.PYTHONPATH || "",
    ].filter(Boolean).join(this.path.delimiter);
    const privateEnvironment = this._loadPrivateEnvironment(paths);
    return {
      ...process.env,
      ...privateEnvironment,
      PYTHONUNBUFFERED: "1",
      RECEPTIONIST_DESKTOP_ROOT: paths.runtimeRoot || "",
      RECEPTIONIST_RUNTIME_ROOT: paths.runtimeRoot || "",
      RECEPTIONIST_SEED_ROOT: paths.seedRoot || "",
      RECEPTIONIST_LEGACY_ROOT: paths.runtimeRoot ? this.path.join(paths.runtimeRoot, "legacy") : "",
      ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
      ...overrides,
    };
  }

  _loadPrivateEnvironment(paths) {
    const roots = [paths.sourceRoot, paths.seedRoot, paths.runtimeRoot]
      .filter(Boolean)
      .filter((root, index, values) => values.indexOf(root) === index);
    const environment = {};

    for (const root of roots) {
      const envPath = this.path.join(root, ".env.local");
      if (!this.fs.existsSync(envPath)) continue;
      try {
        Object.assign(environment, dotenv.parse(this.fs.readFileSync(envPath, "utf8")));
      } catch {
        // The Python worker will report the startup failure without exposing
        // private seed contents through the Electron bridge.
      }
    }

    return environment;
  }

  _sitePackages(runtimeRoot) {
    if (!runtimeRoot) return [];
    const candidates = [this.path.join(runtimeRoot, "Lib", "site-packages")];
    const libRoot = this.path.join(runtimeRoot, "lib");
    try {
      for (const entry of this.fs.readdirSync(libRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && /^python\d+\.\d+$/.test(entry.name)) {
          candidates.push(this.path.join(libRoot, entry.name, "site-packages"));
        }
      }
    } catch {
      // Windows bundles do not have a POSIX lib directory.
    }
    return candidates.filter((candidate) => this.fs.existsSync(candidate));
  }

  isAvailable() {
    const { sourceRoot, runtimeRoot, seedRoot } = this.resolvePaths();
    return Boolean(
      sourceRoot
      && this.fs.existsSync(this.path.join(sourceRoot, "receptionist"))
      && runtimeRoot
      && seedRoot
      && this.resolvePython()
    );
  }

  getStatus() {
    const { sourceRoot, runtimeRoot, seedRoot, pythonRuntimeRoot } = this.resolvePaths();
    const available = this.isAvailable();
    return {
      available,
      sourceAvailable: Boolean(sourceRoot),
      runtimeAvailable: Boolean(runtimeRoot),
      seedAvailable: Boolean(seedRoot),
      bundledPythonAvailable: Boolean(pythonRuntimeRoot && this.resolvePython()),
      mode: this.isPackaged ? "packaged" : "development",
      agent: { ...this.agentStatus },
    };
  }

  async initialize() {
    return this.runPython([
      "-c",
      "from receptionist.runtime import ensure_app_runtime; ensure_app_runtime()",
    ]);
  }

  async runModule(moduleName, args = [], options = {}) {
    if (!/^[a-zA-Z_][\w.]*$/.test(moduleName)) {
      return this._failure("AI_RECEPTIONIST_INVALID_COMMAND", "run-module");
    }
    return this.runPython(["-m", moduleName, ...args.map(String)], options);
  }

  async runPython(args, options = {}) {
    try {
      this._ensurePackagedPythonRuntime();
    } catch {
      return this._failure("AI_RECEPTIONIST_RUNTIME_UNAVAILABLE", "initialize-runtime");
    }
    const command = this.resolvePython();
    const paths = this.resolvePaths();
    if (
      !paths.sourceRoot
      || !this.fs.existsSync(this.path.join(paths.sourceRoot, "receptionist"))
      || !paths.runtimeRoot
      || !paths.seedRoot
      || !command
    ) {
      return this._failure("AI_RECEPTIONIST_UNAVAILABLE", "run-python");
    }
    try {
      this.fs.mkdirSync(paths.runtimeRoot, { recursive: true });
    } catch {
      return this._failure("AI_RECEPTIONIST_RUNTIME_UNAVAILABLE", "create-runtime-directory");
    }
    return this._run(command, args, options);
  }

  _ensurePackagedPythonRuntime() {
    if (!this.isPackaged) return;
    const paths = this.resolvePaths();
    if (!paths.sourceRoot || !paths.runtimeRoot || !paths.pythonRuntimeRoot) return;

    const bundledRuntime = this.path.join(paths.sourceRoot, "python-runtime");
    const writableRuntime = this.path.join(paths.runtimeRoot, "python-runtime");
    if (paths.pythonRuntimeRoot === writableRuntime || this.fs.existsSync(writableRuntime)) return;

    this.fs.mkdirSync(paths.runtimeRoot, { recursive: true });
    this.fs.cpSync(bundledRuntime, writableRuntime, { recursive: true, dereference: true });

    const manifestPath = this.path.join(writableRuntime, "runtime-manifest.json");
    if (!this.fs.existsSync(manifestPath)) return;
    const manifest = JSON.parse(this.fs.readFileSync(manifestPath, "utf8"));
    const configPath = this.path.join(writableRuntime, "pyvenv.cfg");
    if (!this.fs.existsSync(configPath) || !manifest.baseDir || !manifest.baseExecutable) return;

    const baseExecutable = this.path.join(writableRuntime, manifest.baseDir, manifest.baseExecutable);
    const command = `${baseExecutable} -m venv ${writableRuntime}`;
    const lines = this.fs.readFileSync(configPath, "utf8").split(/\r?\n/).filter(Boolean);
    const replacements = new Map([
      ["home", `home = ${this.path.dirname(baseExecutable)}`],
      ["executable", `executable = ${baseExecutable}`],
      ["command", `command = ${command}`],
    ]);
    const seen = new Set();
    const rewritten = lines.map((line) => {
      const key = line.split("=")[0]?.trim();
      if (!replacements.has(key)) return line;
      seen.add(key);
      return replacements.get(key);
    });
    for (const [key, value] of replacements) {
      if (!seen.has(key)) rewritten.push(value);
    }
    this.fs.writeFileSync(configPath, `${rewritten.join("\n")}\n`, "utf8");
  }

  _run(command, args, options) {
    const timeoutMs = Math.max(1, Number(options.timeoutMs || this.commandTimeoutMs));
    const paths = this.resolvePaths();
    return new Promise((resolve) => {
      let child;
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        this.terminateProcessTree(child);
        finish({
          ok: false,
          code: null,
          stdout: "",
          stderr: "",
          timedOut: true,
          error: this._publicError("AI_RECEPTIONIST_TIMEOUT", "command-timeout"),
        });
      }, timeoutMs);

      try {
        child = this.spawn(command.command, [...command.prefix, ...args], {
          cwd: paths.sourceRoot,
          env: this.createEnvironment(options.env || {}),
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        finish(this._failure("AI_RECEPTIONIST_SPAWN_FAILED", "spawn-command"));
        return;
      }
      child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", () => finish({
        ok: false,
        code: null,
        stdout: "",
        stderr: "",
        timedOut,
        error: this._publicError("AI_RECEPTIONIST_SPAWN_FAILED", "command-error"),
      }));
      child.once("close", (code) => {
        if (timedOut) return;
        if (code === 0) {
          // stdout is consumed only by trusted main-process bridge code. stderr
          // is never needed by the product and is discarded unconditionally.
          finish({ ok: true, code, stdout, stderr: "", timedOut: false, error: null });
        } else {
          finish({
            ok: false,
            code,
            stdout: "",
            stderr: "",
            timedOut: false,
            error: this._publicError("AI_RECEPTIONIST_COMMAND_FAILED", "command-exit"),
          });
        }
      });
    });
  }

  setAgentEnabled(enabled) {
    this.agentEnabled = enabled === true;
    this.agentStatus.enabled = this.agentEnabled;
  }

  async startAgent({ enabled = false, playgroundMode = false } = {}) {
    if (!(enabled === true || this.agentEnabled)) {
      return this._failure("AI_RECEPTIONIST_AGENT_DISABLED", "start-agent");
    }
    if (enabled === true) this.setAgentEnabled(true);
    if (this.agentStartPromise) return this.agentStartPromise;
    if (this.agentProcess) return { ok: true, alreadyRunning: true, pid: this.agentProcess.pid || null };
    this.agentStartPromise = this._startAgent(playgroundMode);
    try {
      return await this.agentStartPromise;
    } finally {
      this.agentStartPromise = null;
    }
  }

  async _startAgent(playgroundMode) {
    const command = this.resolvePython();
    const paths = this.resolvePaths();
    if (
      !paths.sourceRoot
      || !this.fs.existsSync(this.path.join(paths.sourceRoot, "receptionist"))
      || !paths.runtimeRoot
      || !paths.seedRoot
      || !command
    ) {
      return this._failure("AI_RECEPTIONIST_UNAVAILABLE", "start-agent");
    }
    const initialised = await this.initialize();
    if (!initialised.ok) return initialised;
    try {
      const env = this.createEnvironment(playgroundMode ? { RECEPTIONIST_AGENT_NAME: "" } : {});
      const mode = this.isPackaged ? "start" : "dev";
      const child = this.spawn(command.command, [...command.prefix, "-m", "receptionist.agent", mode], {
        cwd: paths.sourceRoot,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.agentProcess = child;
      this.agentStopRequested = false;
      this.agentStatus = {
        enabled: true,
        running: true,
        pid: child.pid || null,
        state: "starting",
        message: "",
        errorCode: null,
      };
      child.stdout?.on("data", (chunk) => this._agentOutput(chunk));
      child.stderr?.on("data", (chunk) => this._agentOutput(chunk));
      child.once("error", () => this._agentExited(child, "AI_RECEPTIONIST_AGENT_START_FAILED"));
      child.once("close", (code) => this._agentExited(child, code === 0 ? null : "AI_RECEPTIONIST_AGENT_EXITED"));
      return { ok: true, pid: child.pid || null };
    } catch {
      this.agentStatus = this._agentErrorStatus("AI_RECEPTIONIST_AGENT_START_FAILED");
      return this._failure("AI_RECEPTIONIST_AGENT_START_FAILED", "start-agent");
    }
  }

  _agentOutput(chunk) {
    const line = String(chunk || "").trim();
    if (line.includes("HIRA_AGENT_STATUS") && line.includes("worker_registered")) {
      this.agentStatus = { ...this.agentStatus, state: "ready", message: "", errorCode: null };
    }
    // Agent output can include third-party diagnostics. Retain only its
    // readiness signal; never copy arbitrary Python output into app logs.
  }

  _agentExited(child, errorCode = null) {
    if (this.agentProcess !== child) return;
    const stopped = this.agentStopRequested;
    this.agentStopRequested = false;
    this.agentProcess = null;
    if (!stopped && errorCode) this._logFailure("agent-exited", serializedError(errorCode).code);
    this.agentStatus = {
      enabled: this.agentEnabled,
      running: false,
      pid: null,
      state: stopped || !errorCode ? "stopped" : "error",
      message: stopped || !errorCode ? "" : serializedError(errorCode).message,
      errorCode: stopped || !errorCode ? null : serializedError(errorCode).code,
    };
  }

  async stopAgent({ timeoutMs = this.stopTimeoutMs } = {}) {
    const child = this.agentProcess;
    if (!child) return { ok: true, stopped: true };
    this.agentStopRequested = true;
    this.agentStatus = { ...this.agentStatus, state: "stopping" };
    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const timeout = setTimeout(() => {
        this.terminateProcessTree(child);
        this.agentStopRequested = false;
        this.agentProcess = null;
        this.agentStatus = this._agentErrorStatus("AI_RECEPTIONIST_AGENT_STOP_TIMEOUT");
        finish(this._failure("AI_RECEPTIONIST_AGENT_STOP_TIMEOUT", "stop-agent-timeout"));
      }, Math.max(1, Number(timeoutMs)));
      child.once("close", () => {
        this._agentExited(child, "");
        finish({ ok: true, stopped: true });
      });
      try {
        this.terminateProcessTree(child);
      } catch {
        this.agentStatus = this._agentErrorStatus("AI_RECEPTIONIST_AGENT_STOP_FAILED");
        finish(this._failure("AI_RECEPTIONIST_AGENT_STOP_FAILED", "stop-agent"));
      }
    });
  }

  shutdown() {
    return this.stopAgent();
  }

  _agentErrorStatus(code) {
    const error = serializedError(code);
    this._logFailure("agent", error.code);
    return {
      enabled: this.agentEnabled,
      running: false,
      pid: null,
      state: "error",
      message: error.message,
      errorCode: error.code,
    };
  }

  _publicError(code, operation) {
    const error = serializedError(code);
    this._logFailure(operation, error.code);
    return error;
  }

  _logFailure(operation, code) {
    this.log?.("AIReceptionist operation failed", { operation, code });
  }

  _failure(code, operation) {
    return { ok: false, code: null, stdout: "", stderr: "", timedOut: false, error: this._publicError(code, operation) };
  }
}

module.exports = { AIReceptionistRuntime, PUBLIC_ERROR_MESSAGES, serializedError, terminateProcessTree };
