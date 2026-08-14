#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  defaultSeedRoot,
  defaultSourceRoot,
  stageRuntime,
} = require('./stage-ai-receptionist-runtime');

const rootDir = path.resolve(__dirname, '..');
const builderConfig = JSON.parse(fs.readFileSync(path.join(rootDir, 'electron-builder.json'), 'utf8'));
const buildDir = path.join(rootDir, 'build');
const stageDir = path.join(buildDir, 'ai-receptionist-dad-stage');
const configPath = path.join(buildDir, `electron-builder.dad-${process.pid}.json`);

function fail(message) {
  throw new Error(`[dad-build] ${message}`);
}

function cleanupPrivateBuildInputs() {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.rmSync(configPath, { force: true });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cleanupPrivateBuildInputs();
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
  });
}

function targetFromArgs() {
  const target = process.argv[2] || (process.platform === 'win32' ? 'win' : `mac-${process.arch}`);
  if (!['win', 'mac-arm64', 'mac-x64'].includes(target)) {
    fail(`Target must be win, mac-arm64, or mac-x64; received ${target}`);
  }
  if (target === 'win' && process.platform !== 'win32') fail('Windows Dad builds must run on Windows.');
  if (target.startsWith('mac-') && process.platform !== 'darwin') fail('macOS Dad builds must run on macOS.');
  return target;
}

function platformConfig(stageResult, target) {
  const baseBuild = builderConfig;
  const hasReceptionistStage = (baseBuild.extraResources || []).some(
    (entry) => entry && typeof entry === 'object' && entry.to === 'ai-receptionist',
  );
  const common = {
    ...baseBuild,
    publish: null,
    extraResources: [
      ...(baseBuild.extraResources || []),
      ...(hasReceptionistStage ? [] : [{ from: stageResult.outputDir, to: 'ai-receptionist' }]),
    ],
  };

  if (target === 'win') {
    return {
      ...common,
      win: {
        ...baseBuild.win,
        artifactName: 'OpenWhispr-Dad-Windows-Setup.${ext}',
      },
    };
  }

  return {
    ...common,
    mac: {
      ...baseBuild.mac,
      artifactName: `OpenWhispr-Dad-macOS-${target === 'mac-arm64' ? 'arm64' : 'x64'}.\${ext}`,
    },
  };
}

function executable(name) {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  return path.join(rootDir, 'node_modules', '.bin', `${name}${suffix}`);
}

function preparationScriptForTarget(target) {
  return target === 'win' ? 'prebuild:win' : 'prebuild:mac';
}

function run(command, args, options = {}) {
  process.stdout.write(`[dad-build] ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: options.env || process.env,
    stdio: 'inherit',
    shell: options.shell || false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`Command failed with exit code ${result.status}: ${command}`);
}

function main() {
  const target = targetFromArgs();
  const sourceRoot = path.resolve(process.env.AI_RECEPTIONIST_ROOT || defaultSourceRoot);
  const seedRoot = path.resolve(
    process.env.AI_RECEPTIONIST_SEED_ROOT
      || (sourceRoot === defaultSourceRoot ? defaultSeedRoot : sourceRoot),
  );

  fs.mkdirSync(buildDir, { recursive: true });
  const stageResult = stageRuntime({ sourceRoot, seedRoot, outputDir: stageDir });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(platformConfig(stageResult, target), null, 2)}${require('os').EOL}`,
    'utf8',
  );

  try {
    // Run OpenWhispr's platform preparation chain before packaging so native
    // helpers and downloaded local models are present in the normal build
    // resources. Calling the prebuild script directly avoids npm invoking
    // build:dad again through a lifecycle hook.
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
      'run',
      preparationScriptForTarget(target),
    ]);
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:renderer']);
    run(executable('electron-builder'), [
      '--config', configPath,
      target === 'win' ? '--win' : '--mac',
      target === 'win' ? 'nsis' : 'dmg',
      target === 'win' ? '--x64' : `--${target === 'mac-arm64' ? 'arm64' : 'x64'}`,
      '--publish', 'never',
    ], { shell: process.platform === 'win32' });
  } finally {
    cleanupPrivateBuildInputs();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    cleanupPrivateBuildInputs();
    process.stderr.write(`\n${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { platformConfig, preparationScriptForTarget };
