#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const openWhisprRoot = path.resolve(__dirname, '..');
const embeddedSourceRoot = path.join(openWhisprRoot, 'vendor', 'ai-receptionist');
const siblingSourceRoot = path.resolve(openWhisprRoot, '..', 'AIReceptionist');
const defaultSourceRoot = fs.existsSync(path.join(embeddedSourceRoot, 'receptionist'))
  ? embeddedSourceRoot
  : siblingSourceRoot;
const defaultSeedRoot = fs.existsSync(path.join(embeddedSourceRoot, 'private-seed', '.env.local'))
  ? path.join(embeddedSourceRoot, 'private-seed')
  : defaultSourceRoot;
const defaultOutputDir = path.join(openWhisprRoot, 'build', 'ai-receptionist-dad-stage');
const runtimeManifestName = 'runtime-manifest.json';
const sourceManifestName = 'source-manifest.json';

const requiredEnvKeys = [
  'LIVEKIT_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'OPENAI_API_KEY',
  'RECEPTIONIST_AGENT_NAME',
];

function fail(message) {
  throw new Error(`[ai-receptionist-stage] ${message}`);
}

function resolveInputPath(value, fallback) {
  return path.resolve(value || fallback);
}

function parseArgs(argv) {
  const options = { json: false, arch: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }

    if (argument === '--arch') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) fail('Missing value for --arch');
      options.arch = value;
      continue;
    }

    const match = argument.match(/^--(source-root|seed-root|output)(?:=(.*))?$/);
    if (!match) fail(`Unknown argument: ${argument}`);
    const name = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = match[2] ?? argv[++index];
    if (!value || value.startsWith('--')) fail(`Missing value for ${argument}`);
    options[name] = value;
  }
  return options;
}

function assertDirectory(directory, label) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    fail(`${label} directory is missing: ${directory}`);
  }
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail(`${label} is missing: ${filePath}`);
  }
  if (fs.statSync(filePath).size === 0) fail(`${label} is empty: ${filePath}`);
}

function firstExisting(root, candidates, label) {
  for (const candidate of candidates) {
    const filePath = path.join(root, candidate);
    if (fs.existsSync(filePath)) return filePath;
  }
  fail(`${label} is missing under ${root}. Checked: ${candidates.join(', ')}`);
}

function parseEnvKeys(filePath) {
  const values = new Map();
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1].startsWith('#')) continue;
    values.set(match[1], match[2].replace(/^['"]|['"]$/g, '').trim());
  }
  return values;
}

function parseJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function validatePrivateSeed(seedRoot) {
  const envPath = firstExisting(seedRoot, ['.env.local'], '.env.local');
  const appConfigPath = firstExisting(seedRoot, ['config/app.yaml'], 'config/app.yaml');
  const contactsPath = firstExisting(seedRoot, ['config/contacts.yaml'], 'config/contacts.yaml');
  const googleTokenPath = firstExisting(
    seedRoot,
    ['secrets/google-oauth.json', 'config/secrets/google-oauth.json'],
    'Google OAuth token',
  );
  const googleClientPath = firstExisting(
    seedRoot,
    [
      'oauth/google-calendar-oauth-client.json',
      'desktop/oauth/google-calendar-oauth-client.json',
      'secrets/google-calendar-oauth-client.json',
      'config/secrets/google-calendar-oauth-client.json',
    ],
    'Google OAuth client',
  );

  const values = parseEnvKeys(envPath);
  const missing = requiredEnvKeys.filter((key) => !values.get(key));
  if (missing.length) fail(`.env.local is missing required values: ${missing.join(', ')}`);

  parseJsonFile(googleTokenPath, 'Google OAuth token');
  parseJsonFile(googleClientPath, 'Google OAuth client');

  return {
    envPath,
    appConfigPath,
    contactsPath,
    googleTokenPath,
    googleClientPath,
  };
}

function runtimeExecutablePath(runtimeRoot) {
  const candidates = process.platform === 'win32'
    ? [path.join(runtimeRoot, 'Scripts', 'python.exe')]
    : [path.join(runtimeRoot, 'bin', 'python3'), path.join(runtimeRoot, 'bin', 'python')];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function validateSource(sourceRoot) {
  assertDirectory(sourceRoot, 'AIReceptionist source');
  assertDirectory(path.join(sourceRoot, 'receptionist'), 'AIReceptionist receptionist source');
  assertDirectory(path.join(sourceRoot, 'python-runtime'), 'AIReceptionist Python runtime');
  assertFile(path.join(sourceRoot, 'python-runtime', runtimeManifestName), 'Python runtime manifest');
  assertFile(runtimeExecutablePath(path.join(sourceRoot, 'python-runtime')), 'Platform Python executable');

  const runtimeManifest = parseJsonFile(
    path.join(sourceRoot, 'python-runtime', runtimeManifestName),
    'Python runtime manifest',
  );
  for (const key of ['baseDir', 'baseExecutable', 'venvExecutable']) {
    if (!runtimeManifest[key]) fail(`Python runtime manifest is missing ${key}`);
  }

  return {
    runtimeManifest,
    pyprojectPath: fs.existsSync(path.join(sourceRoot, 'pyproject.toml'))
      ? path.join(sourceRoot, 'pyproject.toml')
      : null,
  };
}

function ensureSourceRuntime(sourceRoot, architecture = null) {
  try {
    return validateSource(sourceRoot);
  } catch (initialError) {
    const builderScript = path.join(sourceRoot, 'scripts', 'build-python-runtime.js');
    if (!fs.existsSync(builderScript)) throw initialError;

    const builderArgs = [builderScript];
    if (process.platform === 'darwin') {
      builderArgs.push('--arch', architecture || process.env.AI_RECEPTIONIST_RUNTIME_ARCH || process.arch);
    }

    const result = spawnSync(process.execPath, builderArgs, {
      cwd: sourceRoot,
      stdio: 'inherit',
      shell: false,
      env: process.env,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `[ai-receptionist-stage] Unable to prepare the platform Python runtime. `
        + `Run ${process.execPath} ${builderScript} directly for diagnostics.`,
      );
    }

    return validateSource(sourceRoot);
  }
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function shouldSkipGeneratedSource(sourcePath, sourceRoot) {
  const relative = path.relative(sourceRoot, sourcePath);
  if (!relative) return false;
  const parts = relative.split(path.sep);
  return parts.includes('__pycache__') || /\.(pyc|pyo)$/.test(path.basename(sourcePath));
}

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (sourcePath) => !shouldSkipGeneratedSource(sourcePath, source),
  });
}

function normalizeRelativePath(value) {
  return value.split(path.sep).join('/');
}

function listFiles(root, relativeRoot = '') {
  const entries = [];
  for (const entry of fs.readdirSync(path.join(root, relativeRoot), { withFileTypes: true })) {
    const relativePath = path.join(relativeRoot, entry.name);
    const absolutePath = path.join(root, relativePath);
    if (entry.isDirectory()) {
      entries.push(...listFiles(root, relativePath));
    } else if (entry.isFile()) {
      entries.push({
        path: normalizeRelativePath(relativePath),
        size: fs.statSync(absolutePath).size,
        sha256: hashFile(absolutePath),
      });
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function hashEntries(entries) {
  const value = entries.map((entry) => `${entry.path}\0${entry.size}\0${entry.sha256}\n`).join('');
  return crypto.createHash('sha256').update(value).digest('hex');
}

function gitRevision(sourceRoot) {
  const result = spawnSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
  });
  if (result.status !== 0) return null;
  const revision = String(result.stdout || '').trim();
  return revision || null;
}

function assertSafeOutput(outputDir, sourceRoot, seedRoot) {
  const resolvedOutput = path.resolve(outputDir);
  const protectedRoots = [openWhisprRoot, sourceRoot, seedRoot].map((root) => path.resolve(root));
  if (protectedRoots.includes(resolvedOutput)) {
    fail(`Refusing to replace a protected directory: ${resolvedOutput}`);
  }
}

function stageRuntime({ sourceRoot, seedRoot, outputDir = defaultOutputDir, architecture = null } = {}) {
  sourceRoot = path.resolve(
    sourceRoot || process.env.AI_RECEPTIONIST_ROOT || defaultSourceRoot,
  );
  seedRoot = path.resolve(
    seedRoot
      || process.env.AI_RECEPTIONIST_SEED_ROOT
      || (sourceRoot === defaultSourceRoot ? defaultSeedRoot : sourceRoot),
  );
  outputDir = path.resolve(outputDir);

  assertSafeOutput(outputDir, sourceRoot, seedRoot);
  const sourceInfo = ensureSourceRuntime(sourceRoot, architecture);
  const privateFiles = validatePrivateSeed(seedRoot);

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  copyDirectory(path.join(sourceRoot, 'receptionist'), path.join(outputDir, 'receptionist'));
  copyDirectory(path.join(sourceRoot, 'python-runtime'), path.join(outputDir, 'python-runtime'));
  if (sourceInfo.pyprojectPath) copyFile(sourceInfo.pyprojectPath, path.join(outputDir, 'pyproject.toml'));

  const seedOutput = path.join(outputDir, 'dad-seed');
  copyFile(privateFiles.envPath, path.join(seedOutput, '.env.local'));
  copyFile(privateFiles.appConfigPath, path.join(seedOutput, 'config', 'app.yaml'));
  copyFile(privateFiles.contactsPath, path.join(seedOutput, 'config', 'contacts.yaml'));
  copyFile(privateFiles.googleTokenPath, path.join(seedOutput, 'secrets', 'google-oauth.json'));
  copyFile(
    privateFiles.googleClientPath,
    path.join(seedOutput, 'oauth', 'google-calendar-oauth-client.json'),
  );

  const allFiles = listFiles(outputDir);
  const sourceFiles = allFiles.filter((entry) => (
    entry.path.startsWith('receptionist/')
    || entry.path.startsWith('python-runtime/')
    || entry.path === 'pyproject.toml'
  ));
  const seedFiles = allFiles.filter((entry) => entry.path.startsWith('dad-seed/'));
  const manifest = {
    schemaVersion: 1,
    edition: 'openwhispr-dad',
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    source: {
      name: path.basename(sourceRoot),
      revision: gitRevision(sourceRoot),
      fileCount: sourceFiles.length,
      sha256: hashEntries(sourceFiles),
    },
    stagedSource: sourceFiles,
    privateSeed: {
      fileCount: seedFiles.length,
      sha256: hashEntries(seedFiles),
      files: seedFiles,
    },
  };
  fs.writeFileSync(
    path.join(outputDir, sourceManifestName),
    `${JSON.stringify(manifest, null, 2)}${os.EOL}`,
    'utf8',
  );

  return { outputDir, manifest, sourceRoot, seedRoot };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = stageRuntime({
    sourceRoot: options.sourceRoot || process.env.AI_RECEPTIONIST_ROOT || defaultSourceRoot,
    seedRoot: options.seedRoot || process.env.AI_RECEPTIONIST_SEED_ROOT,
    architecture: options.arch,
    outputDir: resolveInputPath(options.output, defaultOutputDir),
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result.manifest)}${os.EOL}`);
  } else {
    const summary = `[ai-receptionist-stage] Staged ${result.manifest.source.fileCount} source/runtime files and `
      + `${result.manifest.privateSeed.fileCount} private seed files at ${result.outputDir}${os.EOL}`;
    process.stdout.write(summary);
    process.stdout.write(`[ai-receptionist-stage] Source SHA-256: ${result.manifest.source.sha256}${os.EOL}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`\n${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  defaultOutputDir,
  defaultSourceRoot,
  defaultSeedRoot,
  embeddedSourceRoot,
  ensureSourceRuntime,
  parseEnvKeys,
  stageRuntime,
  validatePrivateSeed,
  validateSource,
};
