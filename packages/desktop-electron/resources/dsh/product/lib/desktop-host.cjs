'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MARKET_NAME = 'dshmarket';
// The floor is a compatibility contract, not a pin: it is the first market
// release that works with the Desktop services we inject in place of its own
// profile and package runtime. Installing targets the latest release, per the
// market's own install instructions, and the market updates itself from there.
const MARKET_MINIMUM_VERSION = '1.21.0';
const MARKET_OPERATION_TIMEOUT_MS = 15 * 60 * 1000;

function readProfile(profileDir) {
  return JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
}

function installedMarketVersion(profileDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(profileDir, 'node_modules', MARKET_NAME, 'package.json'),
      'utf8',
    ));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function versionAtLeast(version, minimum) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
    return match === null
      ? undefined
      : { numbers: match.slice(1, 4).map(Number), prerelease: match[4] };
  };
  const candidate = parse(version);
  const floor = parse(minimum);
  if (candidate === undefined || floor === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    if (candidate.numbers[index] !== floor.numbers[index]) {
      return candidate.numbers[index] > floor.numbers[index];
    }
  }
  return floor.prerelease !== undefined || candidate.prerelease === undefined;
}

function marketStatus(profileDir) {
  const manifest = readProfile(profileDir);
  const declared = typeof manifest.dependencies?.[MARKET_NAME] === 'string';
  const version = installedMarketVersion(profileDir);
  const active = (manifest.dsh?.profile?.bundles ?? []).includes(MARKET_NAME);
  return {
    enabled: declared && active && version !== null && versionAtLeast(version, MARKET_MINIMUM_VERSION),
    version,
  };
}

function dropMarketBundle(profileDir) {
  const manifest = readProfile(profileDir);
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || !bundles.includes(MARKET_NAME)) return;
  manifest.dsh.profile.bundles = bundles.filter((bundle) => bundle !== MARKET_NAME);
  fs.writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

// A bundle row left declared but not installable is what stops DSH from booting
// at all, and neither `dsh plugin add` nor the market rolls it back on failure
// (dsh-market/dsh-market#339, still open against 1.29.2). A failed install drops
// only such a row: one that resolves is the user's to keep, even when it is too
// old for us to drive.
function pruneUnresolvableMarketBundle(profileDir) {
  const manifest = readProfile(profileDir);
  const declared = typeof manifest.dependencies?.[MARKET_NAME] === 'string';
  if (declared && installedMarketVersion(profileDir) !== null) return;
  dropMarketBundle(profileDir);
}

function createDesktopProfiles(profileDir) {
  const current = Object.freeze({ name: 'web', dir: profileDir });
  const onlyWeb = () => new Error('PawWork only supports the web profile');
  return {
    current,
    create() { throw new Error('PawWork profile creation is unavailable'); },
    list() {
      const manifest = readProfile(profileDir);
      return [{
        ...current,
        exists: true,
        bundles: manifest.dsh?.profile?.bundles ?? [],
        webCapable: true,
      }];
    },
    select(name) { return name === current.name ? Promise.resolve() : Promise.reject(onlyWeb()); },
    canDelete() { return false; },
    delete() { return Promise.reject(new Error('PawWork profile deletion is unavailable')); },
  };
}

function createDesktopPnpm(options) {
  let active;

  function runPlugin(args, invokingDir, signal) {
    if (active !== undefined) throw new Error('Another Desktop pnpm operation is already running');
    if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
      throw new Error('PawWork Desktop plugin arguments must be non-empty strings without NUL');
    }
    if (!path.isAbsolute(invokingDir) || invokingDir.includes('\0')) {
      throw new Error('PawWork Desktop plugin invoking directory must be absolute');
    }
    const child = options.subprocess.spawn({
      argv: [
        options.nodeExecutable,
        options.dshBin,
        'plugin',
        '--profile',
        'web',
        ...args,
      ],
      cwd: invokingDir,
      env: { DSH_HOME: options.home, ELECTRON_RUN_AS_NODE: '1' },
      graceMs: 3000,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      signal,
    });
    if (child.stdout === undefined || child.stderr === undefined) {
      child.terminate();
      throw new Error('PawWork Desktop plugin operation did not expose output streams');
    }
    const operation = {
      stdout: child.stdout,
      stderr: child.stderr,
      cancel: () => child.terminate(),
      done: child.done.then(async (outcome) => {
        await child.waitForExit();
        return outcome;
      }).finally(() => {
        if (active === operation) active = undefined;
      }),
    };
    active = operation;
    return operation;
  }

  return {
    service: { runPlugin },
    async dispose() {
      const operation = active;
      operation?.cancel();
      await operation?.done.catch(() => {});
    },
  };
}

function createDesktopHost(options) {
  const profileDir = path.join(options.home, 'profiles', 'web');
  const pnpm = createDesktopPnpm(options);
  const bootMarket = marketStatus(profileDir);
  const status = async () => {
    const current = marketStatus(profileDir);
    return {
      ...current,
      restartRequired: current.enabled !== bootMarket.enabled
        || (current.enabled && current.version !== bootMarket.version),
    };
  };
  const runMarketPlugin = async (args, failureLabel) => {
    const operation = pnpm.service.runPlugin(
      args,
      profileDir,
      AbortSignal.timeout(options.operationTimeoutMs ?? MARKET_OPERATION_TIMEOUT_MS),
    );
    let stderr = '';
    operation.stdout.on('data', () => {});
    operation.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-64 * 1024);
    });
    const outcome = await operation.done;
    if (outcome.exitCode !== 0 || outcome.signal !== null) {
      throw new Error(stderr.trim() || `${failureLabel} failed with code ${String(outcome.exitCode)}`);
    }
  };
  return {
    desktopProfiles: createDesktopProfiles(profileDir),
    desktopPnpm: pnpm.service,
    communityMarket: {
      status,
      async enable() {
        const current = await status();
        if (current.enabled) return current;
        try {
          await runMarketPlugin(['add', MARKET_NAME], 'DSH plugin install');
          const installed = await status();
          if (!installed.enabled) {
            throw new Error(installed.version === null
              ? 'DSH did not activate a compatible community market'
              : `The community market requires ${MARKET_MINIMUM_VERSION} or newer, but ${installed.version} was installed`);
          }
          return installed;
        } catch (error) {
          pruneUnresolvableMarketBundle(profileDir);
          throw error;
        }
      },
      async disable() {
        const current = await status();
        if (!current.enabled && !readProfile(profileDir).dsh?.profile?.bundles?.includes(MARKET_NAME)) return current;
        await runMarketPlugin(['remove', MARKET_NAME], 'DSH plugin removal');
        // Turning the market off must not be able to leave a row behind: the
        // removal is only complete once the bundle row is gone too, whatever
        // state DSH left the rest of the manifest in.
        dropMarketBundle(profileDir);
        return status();
      },
    },
    dispose: pnpm.dispose,
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function registerCommunityMarketRoutes(webServer, market, hostToken) {
  const routes = [
    { path: '/pawwork/community-market/status', method: 'GET', invoke: () => market.status() },
    { path: '/pawwork/community-market/enable', method: 'POST', invoke: () => market.enable() },
    { path: '/pawwork/community-market/disable', method: 'POST', invoke: () => market.disable() },
  ];
  const dispose = routes.map((route) => webServer.register({
    kind: 'exact',
    path: route.path,
    async handler(request, response) {
      if (request.method !== route.method) {
        response.writeHead(405, { allow: route.method });
        response.end();
        return;
      }
      if (request.headers['x-pawwork-host-token'] !== hostToken) {
        sendJson(response, 403, { error: 'PawWork host authorization failed' });
        return;
      }
      try {
        sendJson(response, 200, await route.invoke());
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    },
  }));
  return () => {
    for (const unregister of dispose.reverse()) unregister();
  };
}

module.exports = {
  MARKET_MINIMUM_VERSION,
  MARKET_NAME,
  createDesktopHost,
  registerCommunityMarketRoutes,
};
