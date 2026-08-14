const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  platformConfig,
  preparationScriptForTarget,
} = require('../../scripts/build-dad');
const { stageRuntime } = require('../../scripts/stage-ai-receptionist-runtime');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhispr-ai-stage-'));
  const sourceRoot = path.join(root, 'AIReceptionist');
  const seedRoot = path.join(root, 'DadSeed');
  const runtimeRoot = path.join(sourceRoot, 'python-runtime');

  fs.mkdirSync(path.join(sourceRoot, 'receptionist'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'receptionist', '__init__.py'), 'VERSION = "fixture"\n', 'utf8');
  fs.writeFileSync(path.join(sourceRoot, 'pyproject.toml'), '[project]\nname = "fixture"\n', 'utf8');
  fs.mkdirSync(path.join(runtimeRoot, process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(runtimeRoot, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python3'),
    'fixture runtime\n',
    'utf8',
  );
  writeJson(path.join(runtimeRoot, 'runtime-manifest.json'), {
    baseDir: 'base',
    baseExecutable: 'python.exe',
    venvExecutable: 'Scripts/python.exe',
  });

  fs.mkdirSync(seedRoot, { recursive: true });
  fs.writeFileSync(path.join(seedRoot, '.env.local'), [
    'LIVEKIT_URL=https://example.invalid',
    'LIVEKIT_API_KEY=private-key',
    'LIVEKIT_API_SECRET=private-secret',
    'OPENAI_API_KEY=private-openai-key',
    'RECEPTIONIST_AGENT_NAME=fixture-agent',
  ].join('\n'), 'utf8');
  fs.mkdirSync(path.join(seedRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(seedRoot, 'config', 'app.yaml'), 'calendar:\n  enabled: true\n', 'utf8');
  fs.writeFileSync(path.join(seedRoot, 'config', 'contacts.yaml'), 'contacts: []\n', 'utf8');
  writeJson(path.join(seedRoot, 'secrets', 'google-oauth.json'), { token: 'private' });
  writeJson(path.join(seedRoot, 'oauth', 'google-calendar-oauth-client.json'), { client_id: 'private' });

  return { root, sourceRoot, seedRoot, outputDir: path.join(root, 'stage') };
}

test('stages source, platform runtime, and private seed with a manifest', () => {
  const fixture = createFixture();
  try {
    const result = stageRuntime(fixture);
    assert.equal(fs.existsSync(path.join(result.outputDir, 'receptionist', '__init__.py')), true);
    assert.equal(fs.existsSync(path.join(result.outputDir, 'python-runtime', 'runtime-manifest.json')), true);
    assert.equal(fs.existsSync(path.join(result.outputDir, 'dad-seed', '.env.local')), true);
    assert.equal(
      fs.existsSync(path.join(result.outputDir, 'dad-seed', 'secrets', 'google-oauth.json')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(result.outputDir, 'dad-seed', 'oauth', 'google-calendar-oauth-client.json')),
      true,
    );

    const manifest = JSON.parse(
      fs.readFileSync(path.join(result.outputDir, 'source-manifest.json'), 'utf8'),
    );
    assert.equal(manifest.schemaVersion, 1);
    assert.match(manifest.source.sha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.privateSeed.sha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.stagedSource.some((entry) => entry.path.includes('.env')), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('does not accept an incomplete private seed', () => {
  const fixture = createFixture();
  try {
    fs.rmSync(path.join(fixture.seedRoot, 'secrets', 'google-oauth.json'));
    assert.throws(
      () => stageRuntime(fixture),
      /Google OAuth token is missing/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Dad config preserves normal resources and adds the private stage only for Dad builds', () => {
  const config = platformConfig({ outputDir: 'build/ai-receptionist-dad-stage' }, 'win');
  assert.equal(config.files.includes('main.js'), true);
  assert.equal(config.extraResources.some((entry) => entry.to === 'ai-receptionist'), true);
  assert.equal(config.extraResources.some((entry) => entry.to === 'dad-seed'), false);
});

test('Dad builds select the matching platform preparation chain without recursion', () => {
  assert.equal(preparationScriptForTarget('win'), 'prebuild:win');
  assert.equal(preparationScriptForTarget('mac-arm64'), 'prebuild:mac');
  assert.equal(preparationScriptForTarget('mac-x64'), 'prebuild:mac');

  const buildScript = fs.readFileSync(
    path.join(__dirname, '../../scripts/build-dad.js'),
    'utf8',
  );
  assert.doesNotMatch(buildScript, /run\([^\n]*build:dad/);
});
