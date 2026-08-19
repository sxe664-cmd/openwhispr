#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const runtimeDir = path.join(rootDir, 'python-runtime');
const bundledBaseDirName = 'base';
const runtimeManifestName = 'runtime-manifest.json';
const standaloneRuntimeDir = path.join(rootDir, '.python-standalone-runtime');
const pythonBuildStandaloneRepo = 'astral-sh/python-build-standalone';
// Pin the standalone release so two Dad builds do not silently receive
// different Python patch releases from the moving GitHub "latest" tag.
const pinnedPythonBuildStandaloneRelease = '20260718';
const macStandalonePythonMajorMinor = '3.14';

function requestedArchitecture() {
  const argumentIndex = process.argv.indexOf('--arch');
  return argumentIndex >= 0 && process.argv[argumentIndex + 1]
    ? process.argv[argumentIndex + 1]
    : process.env.PYTHON_RUNTIME_ARCH || process.arch;
}

function run(command, args, options = {}) {
  const pretty = `${command} ${args.join(' ')}`.trim();
  process.stdout.write(`\n[python-runtime] ${pretty}\n`);
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: false,
    env: process.env,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${pretty}`);
  }
}

function commandExists(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'ignore',
    shell: false,
    env: process.env,
  });
  if (result.error) return false;
  return result.status === 0;
}

function requestHeaders() {
  const headers = { 'User-Agent': 'AIReceptionist-build-runtime' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function download(url, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: requestHeaders(),
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode || 0) && response.headers.location) {
        response.resume();
        download(response.headers.location, destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed (${response.statusCode}): ${url}`));
        return;
      }
      const file = fs.createWriteStream(destination);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    request.on('error', reject);
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: requestHeaders(),
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`GitHub API request failed (${response.statusCode}): ${url}`));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
  });
}

function macStandaloneTarget() {
  const architecture = requestedArchitecture();
  if (architecture === 'arm64') return 'aarch64-apple-darwin';
  if (architecture === 'x64') return 'x86_64-apple-darwin';
  throw new Error(`Unsupported macOS architecture for standalone Python: ${architecture}`);
}

async function resolveMacStandalonePython() {
  const target = macStandaloneTarget();
  const releaseTag = process.env.PYTHON_BUILD_STANDALONE_RELEASE || pinnedPythonBuildStandaloneRelease;
  const releasesUrl = `https://api.github.com/repos/${pythonBuildStandaloneRepo}/releases/tags/${releaseTag}`;
  const release = await fetchJson(releasesUrl);
  const asset = (release.assets || []).find((candidate) => {
    const name = candidate.name || '';
    return name.startsWith(`cpython-${macStandalonePythonMajorMinor}.`)
      && name.includes(`-${target}-`)
      && !name.includes('-freethreaded-')
      && name.endsWith('-install_only_stripped.tar.gz');
  });
  if (!asset?.browser_download_url) {
    throw new Error(`No Python ${macStandalonePythonMajorMinor} standalone asset found for ${target} in ${release.tag_name || releasesUrl}`);
  }

  fs.rmSync(standaloneRuntimeDir, { recursive: true, force: true });
  fs.mkdirSync(standaloneRuntimeDir, { recursive: true });
  const archivePath = path.join(standaloneRuntimeDir, asset.name);
  process.stdout.write(`\n[python-runtime] Downloading ${asset.name}\n`);
  await download(asset.browser_download_url, archivePath);
  run('tar', ['-xzf', archivePath, '-C', standaloneRuntimeDir]);

  const executableCandidates = [
    path.join(standaloneRuntimeDir, 'python', 'install', 'bin', 'python3'),
    path.join(standaloneRuntimeDir, 'python', 'bin', 'python3'),
    path.join(standaloneRuntimeDir, 'python', 'bin', 'python'),
  ];
  const executable = executableCandidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    throw new Error(`Standalone Python executable missing. Checked: ${executableCandidates.join(', ')}`);
  }
  return { command: executable, prefix: [] };
}

function resolveHostPython() {
  if (process.env.PYTHON) return { command: process.env.PYTHON, prefix: [] };
  if (process.env.PYTHON_EXECUTABLE) return { command: process.env.PYTHON_EXECUTABLE, prefix: [] };
  if (process.platform === 'win32') {
    if (commandExists('py', ['-3', '--version'])) return { command: 'py', prefix: ['-3'] };
    if (commandExists('python', ['--version'])) return { command: 'python', prefix: [] };
    if (commandExists('python3', ['--version'])) return { command: 'python3', prefix: [] };
  } else {
    if (commandExists('python3', ['--version'])) return { command: 'python3', prefix: [] };
    if (commandExists('python', ['--version'])) return { command: 'python', prefix: [] };
  }
  return null;
}

function runtimePythonPath() {
  if (process.platform === 'win32') {
    return path.join(runtimeDir, 'Scripts', 'python.exe');
  }
  return path.join(runtimeDir, 'bin', 'python3');
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
    shell: false,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${command} ${args.join(' ')}\n${result.stderr || ''}`);
  }
  return String(result.stdout || '').trim();
}

function verifyNoHomebrewLinkage(binaryPath) {
  if (process.platform !== 'darwin') return;
  const output = capture('otool', ['-L', binaryPath]);
  const forbidden = ['/opt/homebrew/Cellar/', '/usr/local/Cellar/'];
  const hit = forbidden.find((needle) => output.includes(needle));
  if (hit) {
    throw new Error(
      `Bundled Python binary has forbidden host linkage (${hit}). Refusing to package non-portable runtime.`,
    );
  }
}

function verifyMacRuntimeLinkage(runtimePath) {
  if (process.platform !== 'darwin') return;
  const pending = [runtimePath];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
      continue;
    }
    const fileDescription = capture('file', [current]);
    if (fileDescription.includes('Mach-O')) verifyNoHomebrewLinkage(current);
  }
}

function verifyMacRuntimeArchitecture(binaryPath) {
  if (process.platform !== 'darwin') return;
  const architecture = requestedArchitecture();
  const output = capture('file', [binaryPath]);
  const expected = architecture === 'arm64' ? 'arm64' : 'x86_64';
  if (!output.includes(expected)) {
    throw new Error(`Bundled Python architecture mismatch: expected ${expected}, got ${output}`);
  }
}

function normalizeForConfig(value) {
  return value.replace(/\\/g, '\\');
}

function rewritePyvenvConfig({ baseExecutable, venvExecutable }) {
  const cfgPath = path.join(runtimeDir, 'pyvenv.cfg');
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`Bundled runtime config missing at ${cfgPath}`);
  }
  const home = path.dirname(baseExecutable);
  const lines = fs.readFileSync(cfgPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const next = [];
  const seen = new Set();
  for (const line of lines) {
    const key = line.split('=')[0]?.trim();
    if (key === 'home') {
      next.push(`home = ${normalizeForConfig(home)}`);
      seen.add('home');
    } else if (key === 'executable') {
      next.push(`executable = ${normalizeForConfig(baseExecutable)}`);
      seen.add('executable');
    } else if (key === 'command') {
      next.push(`command = ${normalizeForConfig(baseExecutable)} -m venv ${normalizeForConfig(runtimeDir)}`);
      seen.add('command');
    } else {
      next.push(line);
    }
  }
  if (!seen.has('home')) next.push(`home = ${normalizeForConfig(home)}`);
  if (!seen.has('executable')) next.push(`executable = ${normalizeForConfig(baseExecutable)}`);
  if (!seen.has('command')) next.push(`command = ${normalizeForConfig(baseExecutable)} -m venv ${normalizeForConfig(runtimeDir)}`);
  fs.writeFileSync(cfgPath, `${next.join('\n')}\n`, 'utf8');

  const manifest = {
    baseDir: bundledBaseDirName,
    baseExecutable: path.relative(path.join(runtimeDir, bundledBaseDirName), baseExecutable),
    venvExecutable: path.relative(runtimeDir, venvExecutable),
  };
  fs.writeFileSync(path.join(runtimeDir, runtimeManifestName), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function bundledExecutableCandidates(basePrefix, bundledBaseDir, baseExecutable) {
  const candidates = [];
  const relative = path.relative(basePrefix, baseExecutable);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    candidates.push(path.join(bundledBaseDir, relative));
  }
  candidates.push(path.join(bundledBaseDir, path.basename(baseExecutable)));
  candidates.push(path.join(bundledBaseDir, 'bin', path.basename(baseExecutable)));
  if (process.platform === 'win32') {
    candidates.push(path.join(bundledBaseDir, 'python.exe'));
  } else {
    candidates.push(path.join(bundledBaseDir, 'bin', 'python3'));
    candidates.push(path.join(bundledBaseDir, 'bin', 'python'));
  }
  return [...new Set(candidates)];
}

function bundleBasePython(pythonExe) {
  const raw = capture(pythonExe, ['-c', [
    'import json, sys',
    'print(json.dumps({"base_prefix": sys.base_prefix, "base_executable": getattr(sys, "_base_executable", sys.executable)}))',
  ].join('; ')]);
  const info = JSON.parse(raw);
  const basePrefix = path.resolve(info.base_prefix);
  const baseExecutable = path.resolve(info.base_executable);
  if (!fs.existsSync(basePrefix)) {
    throw new Error(`Base Python prefix not found at ${basePrefix}`);
  }
  if (!fs.existsSync(baseExecutable)) {
    throw new Error(`Base Python executable not found at ${baseExecutable}`);
  }

  const bundledBaseDir = path.join(runtimeDir, bundledBaseDirName);
  fs.rmSync(bundledBaseDir, { recursive: true, force: true });
  fs.cpSync(basePrefix, bundledBaseDir, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (source) => {
      const relative = path.relative(basePrefix, source);
      if (!relative) return true;
      const parts = relative.split(path.sep);
      return !parts.some((part) => part === '__pycache__');
    },
  });

  const bundledBaseExecutable = bundledExecutableCandidates(basePrefix, bundledBaseDir, baseExecutable)
    .find((candidate) => fs.existsSync(candidate));
  if (!bundledBaseExecutable) {
    throw new Error(`Copied base Python executable missing. Checked: ${bundledExecutableCandidates(basePrefix, bundledBaseDir, baseExecutable).join(', ')}`);
  }
  rewritePyvenvConfig({ baseExecutable: bundledBaseExecutable, venvExecutable: pythonExe });
  return bundledBaseExecutable;
}

async function buildRuntime() {
  const hostPython = process.platform === 'darwin'
    ? await resolveMacStandalonePython()
    : resolveHostPython();
  if (!hostPython) {
    throw new Error('No host Python found. Set PYTHON or install Python 3 on the build machine.');
  }

  fs.rmSync(runtimeDir, { recursive: true, force: true });
  const venvArgs = [...hostPython.prefix, '-m', 'venv', runtimeDir, '--copies'];
  run(hostPython.command, venvArgs);

  const pythonExe = runtimePythonPath();
  if (!fs.existsSync(pythonExe)) {
    throw new Error(`Bundled runtime executable missing at ${pythonExe}`);
  }

  run(pythonExe, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel']);
  run(pythonExe, ['-m', 'pip', 'install', '.']);

  const bundledBaseExecutable = bundleBasePython(pythonExe);
  verifyMacRuntimeLinkage(runtimeDir);
  verifyMacRuntimeArchitecture(bundledBaseExecutable);

  // Catches packaged base Python binaries that still reference host-only paths.
  run(bundledBaseExecutable, ['-c', 'import sys; print("base-runtime-ok")']);

  const manifestPath = path.join(runtimeDir, runtimeManifestName);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Runtime manifest missing at ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.baseDir || !manifest.baseExecutable || !manifest.venvExecutable) {
    throw new Error(`Runtime manifest is incomplete at ${manifestPath}`);
  }

  // Verify every import used by the packaged desktop and Google flows.
  run(pythonExe, ['-c', [
    'import receptionist',
    'import yaml, dotenv',
    'import google.auth, google.oauth2.credentials, google_auth_oauthlib.flow',
    'import googleapiclient.discovery, googleapiclient.errors',
    'print("runtime-ok")',
  ].join('; ')]);
  process.stdout.write('\n[python-runtime] Build complete.\n');
}

try {
  buildRuntime().catch((error) => {
    process.stderr.write(`\n[python-runtime] ERROR: ${error.message}\n`);
    process.exit(1);
  });
} catch (error) {
  process.stderr.write(`\n[python-runtime] ERROR: ${error.message}\n`);
  process.exit(1);
}
