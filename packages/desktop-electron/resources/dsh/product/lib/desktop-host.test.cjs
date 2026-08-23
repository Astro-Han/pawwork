'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { createDesktopHost, registerCommunityMarketRoutes } = require('./desktop-host.cjs');

function profileHome(version = undefined) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawwork-desktop-host-'));
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    dependencies: version === undefined ? {} : { dshmarket: version },
    dsh: { profile: { bundles: version === undefined ? ['@deepseek-ai/dsh-base'] : ['@deepseek-ai/dsh-base', 'dshmarket'] } },
  }));
  return { home, profileDir };
}

function fakeSubprocess() {
  return { spawn() { throw new Error('unexpected spawn'); } };
}

function managedSubprocess() {
  const spawns = [];
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  const child = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    done,
    terminate() {},
    waitForExit: async () => true,
  };
  return {
    child,
    settle,
    spawns,
    subprocess: { spawn(spec) { spawns.push(spec); return child; } },
  };
}

function responseRecorder() {
  return {
    status: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = '') { this.body += body; },
  };
}

test('publishes the immutable PawWork web profile through the Desktop host contract', async () => {
  const { home, profileDir } = profileHome();
  const host = createDesktopHost({
    dshBin: '/app/dsh/bin.js',
    home,
    nodeExecutable: '/app/PawWork',
    profileDir,
    subprocess: fakeSubprocess(),
  });

  assert.deepEqual(host.desktopProfiles.current, { name: 'web', dir: profileDir });
  assert.deepEqual(host.desktopProfiles.list(), [{
    name: 'web',
    dir: profileDir,
    exists: true,
    bundles: ['@deepseek-ai/dsh-base'],
    webCapable: true,
  }]);
  assert.equal(host.desktopProfiles.canDelete('web'), false);
  assert.throws(() => host.desktopProfiles.create('other'), /profile creation is unavailable/);
  await assert.rejects(host.desktopProfiles.select('other'), /only supports the web profile/);
})

test('runs plugin commands through the DSH managed subprocess tree', async () => {
  const { home, profileDir } = profileHome();
  const managed = managedSubprocess();
  const host = createDesktopHost({
    dshBin: '/app/dsh/bin.js',
    home,
    nodeExecutable: '/app/PawWork',
    profileDir,
    subprocess: managed.subprocess,
  });

  const operation = host.desktopPnpm.runPlugin(['remove', 'example-plugin'], '/caller');

  assert.equal(operation.stdout, managed.child.stdout);
  assert.equal(operation.stderr, managed.child.stderr);
  assert.deepEqual(managed.spawns, [{
    argv: ['/app/PawWork', '/app/dsh/bin.js', 'plugin', '--profile', 'web', 'remove', 'example-plugin'],
    cwd: '/caller',
    env: { DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
    graceMs: 3000,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    signal: undefined,
  }]);
  managed.settle({ exitCode: 0, signal: null });
  assert.deepEqual(await operation.done, { exitCode: 0, signal: null });
})

test('cancels and awaits the active package tree before the host disposes', async () => {
  const { home, profileDir } = profileHome();
  const managed = managedSubprocess();
  let terminations = 0;
  managed.child.terminate = () => { terminations += 1; };
  const host = createDesktopHost({
    dshBin: '/app/dsh/bin.js',
    home,
    nodeExecutable: '/app/PawWork',
    profileDir,
    subprocess: managed.subprocess,
  });
  host.desktopPnpm.runPlugin(['install'], profileDir);

  assert.throws(
    () => host.desktopPnpm.runPlugin(['update'], profileDir),
    /Another Desktop pnpm operation is already running/,
  );
  const disposal = host.dispose();
  assert.equal(terminations, 1);
  let disposed = false;
  void disposal.then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false);
  managed.settle({ exitCode: null, signal: 'SIGTERM' });
  await disposal;
  assert.equal(disposed, true);
})

test('requires the minimum market version and derives restart from the boot generation', async () => {
  const { home, profileDir } = profileHome('1.20.0');
  const host = createDesktopHost({
    dshBin: '/app/dsh/bin.js',
    home,
    nodeExecutable: '/app/PawWork',
    profileDir,
    subprocess: fakeSubprocess(),
  });

  assert.deepEqual(await host.communityMarket.status(), {
    enabled: false,
    restartRequired: false,
    version: '1.20.0',
  });

  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    dependencies: { dshmarket: '1.21.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dshmarket'] } },
  }));
  assert.deepEqual(await host.communityMarket.status(), {
    enabled: true,
    restartRequired: true,
    version: '1.21.0',
  });
})

test('installs only the pinned compatible market through the managed service', async () => {
  const { home, profileDir } = profileHome();
  const managed = managedSubprocess();
  const host = createDesktopHost({
    dshBin: '/app/dsh/bin.js',
    home,
    nodeExecutable: '/app/PawWork',
    profileDir,
    subprocess: managed.subprocess,
  });

  const enabling = host.communityMarket.enable();
  await Promise.resolve();
  assert.deepEqual(managed.spawns[0].argv, [
    '/app/PawWork',
    '/app/dsh/bin.js',
    'plugin',
    '--profile',
    'web',
    'add',
    'dshmarket@1.21.0',
    '--save-exact',
  ]);
  assert.equal(managed.spawns[0].signal instanceof AbortSignal, true);
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    dependencies: { dshmarket: '1.21.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dshmarket'] } },
  }));
  managed.settle({ exitCode: 0, signal: null });

  assert.deepEqual(await enabling, {
    enabled: true,
    restartRequired: true,
    version: '1.21.0',
  });
})

test('keeps a newer compatible market without spawning a downgrade', async () => {
  const { home, profileDir } = profileHome('1.24.0');
  const host = createDesktopHost({
    dshBin: '/app/dsh/bin.js',
    home,
    nodeExecutable: '/app/PawWork',
    profileDir,
    subprocess: fakeSubprocess(),
  });

  assert.deepEqual(await host.communityMarket.enable(), {
    enabled: true,
    restartRequired: false,
    version: '1.24.0',
  });
})

test('rejects a successful command that did not activate the market', async () => {
  const { home, profileDir } = profileHome();
  const managed = managedSubprocess();
  const host = createDesktopHost({
    dshBin: '/app/dsh/bin.js',
    home,
    nodeExecutable: '/app/PawWork',
    profileDir,
    subprocess: managed.subprocess,
  });

  const enabling = host.communityMarket.enable();
  await Promise.resolve();
  managed.settle({ exitCode: 0, signal: null });

  await assert.rejects(enabling, /did not activate a compatible community market/);
})

test('rejects market mutations that do not carry the per-launch host token', async () => {
  const routes = [];
  let enables = 0;
  registerCommunityMarketRoutes({
    register(route) { routes.push(route); return () => {}; },
  }, {
    status: async () => ({ enabled: false, restartRequired: false, version: null }),
    enable: async () => { enables += 1; },
  }, 'secret-host-token');
  const route = routes.find((item) => item.path.endsWith('/enable'));
  const response = responseRecorder();

  await route.handler({ method: 'POST', headers: {} }, response);

  assert.equal(response.status, 403);
  assert.deepEqual(JSON.parse(response.body), { error: 'PawWork host authorization failed' });
  assert.equal(enables, 0);
})
