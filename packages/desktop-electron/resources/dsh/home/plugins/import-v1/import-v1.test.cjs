'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const {
  attachDshWorkspace,
  buildDshSession,
  completedV1SessionTargetIds,
  materializeLegacyImages,
  readV1Sessions,
  runV1SessionImport,
} = require('./import-v1.cjs');
const {
  createDatabaseSnapshot,
  discoverV1AppData,
  discoverV1Database,
  openV1Snapshot,
  v1DataPath,
} = require('./migration-io.cjs');

// The snapshot belongs to the whole import run, so these stage tests open one the
// same way index.mjs does. Temporary homes are disposable; no cleanup needed here.
async function snapshotOf(home, sourceDatabase) {
  return (await openV1Snapshot({ home, sourceDatabase })).path;
}

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pawwork-import-v1-'));
}

function fileDigest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// This used to assert that a partial import held the public status back, which
// is what stopped the client refreshing its session list at all: a single
// unreadable v1 session hid every session that had imported fine, and left the
// client polling twice a second for the life of the app. The status answers
// "has the session stage finished", and which sessions made it is in the ledger.
test('publishes cold sessions once and reports the session stage settled even when one fails', async () => {
  const importerModule = require('./import-v1.cjs');
  const settingsModule = require('./import-v1-settings.cjs');
  const automationsModule = require('./import-v1-automations.cjs');
  const originalRun = importerModule.runV1SessionImport;
  const originalCompletedSessionTargetIds = importerModule.completedV1SessionTargetIds;
  const originalAttach = importerModule.attachDshWorkspace;
  const originalCreateSettingImporter = settingsModule.createDshSettingImporter;
  const originalSettingsRun = settingsModule.runV1SettingsImport;
  const originalAutomationsRun = automationsModule.runV1AutomationImport;
  let statusRpc;
  let rpcRegistration;
  let stopPlugin;
  let importStarted;
  const started = new Promise((resolve) => { importStarted = resolve; });
  let backgroundFinished;
  let automationsActivated = false;
  let missingContinueSessionRejected = false;
  let incompleteContinueSessionRejected = false;
  let unavailableAutomationCatalogRejected = false;
  const sessionLifecycle = [];
  const finished = new Promise((resolve) => { backgroundFinished = resolve; });
  importerModule.runV1SessionImport = async ({ importSession }) => {
    await importSession({ id: 'pawwork-v1-session', images: [], meta: {}, seed: [], title: 'Imported session' }, { contentImported: false });
    importStarted();
    throw new Error('one v1 session could not be read');
  };
  importerModule.completedV1SessionTargetIds = () => new Set(['pawwork-v1-session']);
  importerModule.attachDshWorkspace = async () => {
    sessionLifecycle.push('attach-workspace');
    return 'workspace';
  };
  settingsModule.createDshSettingImporter = () => async () => 'skipped';
  settingsModule.runV1SettingsImport = async () => ({ status: 'complete' });
  automationsModule.runV1AutomationImport = async ({ importDefinition, resolveModel }) => {
    try {
      await assert.rejects(
        resolveModel({ data: { model: { providerID: 'opencode', modelID: 'deepseek-v4-flash-free' } } }),
        /temporary automation catalog failure/,
      );
      unavailableAutomationCatalogRejected = true;
      await assert.rejects(
        importDefinition({ id: 'automation-1', context: 'continue', sourceSessionId: 'pawwork-v1-missing' }),
        /source session is unavailable/,
      );
      missingContinueSessionRejected = true;
      await assert.rejects(
        importDefinition({ id: 'automation-2', context: 'continue', sourceSessionId: 'pawwork-v1-incomplete' }),
        /source session is unavailable/,
      );
      incompleteContinueSessionRejected = true;
      return { status: 'partial' };
    } finally {
      backgroundFinished();
    }
  };
  try {
    const pluginUrl = `${pathToFileURL(path.join(__dirname, 'index.mjs')).href}?status=${Date.now()}`;
    const { apply } = await import(pluginUrl);
    apply({
      connection: {
        rpc: {
          handle: (channel, handler, options) => {
            rpcRegistration = { channel, options };
            statusRpc = handler;
            return async () => {};
          },
        },
      },
      effect: (setup) => { stopPlugin = setup(); },
      llm: {
        listProviders: () => [{ id: 'opencode' }],
        listModels: async () => { throw new Error('temporary automation catalog failure'); },
      },
      logger: { warn: () => {} },
      pawworkAutomations: {
        scheduler: { refresh: () => {} },
        store: { activateImportedDefinitions: () => { automationsActivated = true; } },
      },
      sessionTitle: { rename: () => { sessionLifecycle.push('rename'); } },
      sessions: {
        announce: () => { sessionLifecycle.push('announce'); },
        enter: () => {
          sessionLifecycle.push('enter');
          return () => { sessionLifecycle.push('detach'); };
        },
        flush: async () => { sessionLifecycle.push('flush'); },
        prepare: () => ({ id: 'pawwork-v1-session' }),
      },
      attachments: { saveImage: async () => {} },
      workspaceRegistry: {},
    });
    await started;
    await finished;

    assert.deepEqual(rpcRegistration, {
      channel: '/pawwork-import-v1',
      options: { authority: 'loopback' },
    });
    assert.deepEqual(await statusRpc('status'), {
      ok: true,
      value: { sessionsSettled: true },
    });
    assert.equal(automationsActivated, true);
    assert.equal(missingContinueSessionRejected, true);
    assert.equal(incompleteContinueSessionRejected, true);
    assert.equal(unavailableAutomationCatalogRejected, true);
    assert.deepEqual(sessionLifecycle, ['enter', 'rename', 'flush', 'detach', 'attach-workspace']);
    await stopPlugin();
  } finally {
    importerModule.runV1SessionImport = originalRun;
    importerModule.completedV1SessionTargetIds = originalCompletedSessionTargetIds;
    importerModule.attachDshWorkspace = originalAttach;
    settingsModule.createDshSettingImporter = originalCreateSettingImporter;
    settingsModule.runV1SettingsImport = originalSettingsRun;
    automationsModule.runV1AutomationImport = originalAutomationsRun;
  }
});

// The two things the plugin's session importer decides, neither of which the
// stage tests can see: whether to write the seed at all, and whether the images
// inside it reach the attachment store. materializeLegacyImages replaces each
// legacy block in place, so a second write both duplicates every attachment and
// hands DSH a seed that no longer matches what it already holds.
test('saves a session\'s images once and leaves an already-imported one alone', async () => {
  const importerModule = require('./import-v1.cjs');
  const settingsModule = require('./import-v1-settings.cjs');
  const automationsModule = require('./import-v1-automations.cjs');
  const originals = {
    run: importerModule.runV1SessionImport,
    attach: importerModule.attachDshWorkspace,
    settingImporter: settingsModule.createDshSettingImporter,
    settingsRun: settingsModule.runV1SettingsImport,
    automationsRun: automationsModule.runV1AutomationImport,
  };
  const imported = {
    id: 'pawwork-v1-session',
    meta: {},
    title: 'Imported session',
    seed: [{
      type: 'user/message',
      data: {
        content: [{
          type: 'pawwork-v1-attachment',
          mime: 'image/png',
          filename: 'pixel.png',
          url: 'data:image/png;base64,iVBORw0KGgo=',
        }],
      },
    }],
  };
  const saved = [];
  const prepared = [];
  const workspaces = [];
  let finishImport;
  const finished = new Promise((resolve) => { finishImport = resolve; });
  let stopPlugin;

  importerModule.runV1SessionImport = async ({ importSession }) => {
    try {
      workspaces.push(await importSession(imported, { contentImported: false }));
      workspaces.push(await importSession(imported, { contentImported: true }));
    } finally {
      finishImport();
    }
  };
  importerModule.attachDshWorkspace = async () => 'attached';
  settingsModule.createDshSettingImporter = () => async () => 'skipped';
  settingsModule.runV1SettingsImport = async () => ({ status: 'complete' });
  automationsModule.runV1AutomationImport = async () => ({ status: 'complete' });

  try {
    const pluginUrl = `${pathToFileURL(path.join(__dirname, 'index.mjs')).href}?images=${Date.now()}`;
    const { apply } = await import(pluginUrl);
    apply({
      attachments: {
        saveImage: async (image) => {
          saved.push(image);
          return { attachmentId: `sha256:${saved.length}`, mediaType: image.mediaType, name: image.name };
        },
      },
      connection: { rpc: { handle: () => async () => {} } },
      effect: (setup) => { stopPlugin = setup(); },
      llm: { listProviders: () => [], listModels: async () => [] },
      logger: { warn: () => {} },
      pawworkAutomations: {
        scheduler: { refresh: () => {} },
        store: { activateImportedDefinitions: () => {} },
      },
      sessionTitle: { rename: () => {} },
      sessions: {
        enter: () => () => {},
        flush: async () => {},
        prepare: (id, options) => { prepared.push({ id, seed: options.seed }); return { id }; },
      },
      workspaceRegistry: {},
    });
    await finished;
    await stopPlugin();
  } finally {
    importerModule.runV1SessionImport = originals.run;
    importerModule.attachDshWorkspace = originals.attach;
    settingsModule.createDshSettingImporter = originals.settingImporter;
    settingsModule.runV1SettingsImport = originals.settingsRun;
    automationsModule.runV1AutomationImport = originals.automationsRun;
  }

  assert.equal(saved.length, 1);
  assert.equal(saved[0].mediaType, 'image/png');
  assert.equal(prepared.length, 1);
  assert.deepEqual(prepared[0].seed[0].data.content[0], {
    type: 'image',
    attachment: { attachmentId: 'sha256:1', mediaType: 'image/png', name: 'pixel.png' },
  });
  // The workspace is retried on both passes; only the content write is skipped.
  assert.deepEqual(workspaces, ['attached', 'attached']);
});

// Both database stages used to VACUUM the user's whole v1 database into a private
// copy of their own. What binds the fix is not that a snapshot exists but that the
// two stages are handed the same one, so assert on the file identity they observe.
test('opens one v1 database snapshot for the whole import run', { timeout: 20_000 }, async () => {
  const importerModule = require('./import-v1.cjs');
  const settingsModule = require('./import-v1-settings.cjs');
  const automationsModule = require('./import-v1-automations.cjs');
  const originalRun = importerModule.runV1SessionImport;
  const originalSettingsRun = settingsModule.runV1SettingsImport;
  const originalCreateSettingImporter = settingsModule.createDshSettingImporter;
  const originalAutomationsRun = automationsModule.runV1AutomationImport;
  const originalHome = process.env.DSH_HOME;
  const originalSource = process.env.PAWWORK_V1_DATABASE;

  const root = temporaryDirectory();
  const source = path.join(root, 'pawwork.db');
  const home = path.join(root, 'v2-home');
  createV1Fixture(source);
  process.env.DSH_HOME = home;
  process.env.PAWWORK_V1_DATABASE = source;

  const observed = [];
  const observe = (stage) => ({ snapshot }) => {
    observed.push({ stage, snapshot, inode: fs.statSync(snapshot).ino });
    return { status: 'complete' };
  };
  let stopPlugin;
  let finishedResolve;
  const finished = new Promise((resolve) => { finishedResolve = resolve; });
  importerModule.runV1SessionImport = async (options) => observe('sessions')(options);
  settingsModule.createDshSettingImporter = () => async () => 'skipped';
  settingsModule.runV1SettingsImport = async () => ({ status: 'complete' });
  automationsModule.runV1AutomationImport = async (options) => {
    const result = observe('automations')(options);
    finishedResolve();
    return result;
  };

  try {
    const { apply } = await import(`${pathToFileURL(path.join(__dirname, 'index.mjs')).href}?snapshot=${Date.now()}`);
    apply({
      connection: { rpc: { handle: () => async () => {} } },
      effect: (setup) => { stopPlugin = setup(); },
      llm: { listProviders: () => [], listModels: async () => [] },
      logger: { warn: () => { finishedResolve(); } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'opencode', model: 'big-pickle' }) },
      pawworkAutomations: { scheduler: { refresh: () => {} }, store: { activateImportedDefinitions: () => {} } },
      sessionTitle: { rename: () => {} },
      sessions: { enter: () => () => {}, flush: async () => {}, prepare: () => ({}) },
      attachments: { saveImage: async () => {} },
      workspaceRegistry: {},
    });
    await finished;
    await stopPlugin();

    assert.deepEqual(observed.map((entry) => entry.stage), ['sessions', 'automations']);
    assert.equal(observed[0].snapshot, observed[1].snapshot);
    assert.equal(observed[0].inode, observed[1].inode);
    assert.notEqual(observed[0].snapshot, source);
    assert.equal(fs.existsSync(path.join(home, 'import-v1', 'snapshot.db')), false);
    assert.equal(fs.existsSync(path.join(home, 'import-v1', 'automation-snapshot.db')), false);
  } finally {
    importerModule.runV1SessionImport = originalRun;
    settingsModule.createDshSettingImporter = originalCreateSettingImporter;
    settingsModule.runV1SettingsImport = originalSettingsRun;
    automationsModule.runV1AutomationImport = originalAutomationsRun;
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    if (originalSource === undefined) delete process.env.PAWWORK_V1_DATABASE;
    else process.env.PAWWORK_V1_DATABASE = originalSource;
  }
});

// Every stage is caught individually, so the snapshot cleanup in the finally is
// the one statement that can reject importTask — and nothing awaits it until the
// plugin is disposed, so a rejection there reaches DSH's fail-loud handler and
// takes the backend down over a temp file.
test('survives a snapshot it cannot delete', { timeout: 20_000 }, async () => {
  const importerModule = require('./import-v1.cjs');
  const settingsModule = require('./import-v1-settings.cjs');
  const automationsModule = require('./import-v1-automations.cjs');
  const originalRun = importerModule.runV1SessionImport;
  const originalSettingsRun = settingsModule.runV1SettingsImport;
  const originalCreateSettingImporter = settingsModule.createDshSettingImporter;
  const originalAutomationsRun = automationsModule.runV1AutomationImport;
  const originalHome = process.env.DSH_HOME;
  const originalSource = process.env.PAWWORK_V1_DATABASE;

  const root = temporaryDirectory();
  const source = path.join(root, 'pawwork.db');
  const home = path.join(root, 'v2-home');
  createV1Fixture(source);
  process.env.DSH_HOME = home;
  process.env.PAWWORK_V1_DATABASE = source;

  const warnings = [];
  let stopPlugin;
  let finishedResolve;
  const finished = new Promise((resolve) => { finishedResolve = resolve; });
  const migrationDir = path.join(home, 'import-v1');
  importerModule.runV1SessionImport = async () => ({ status: 'complete' });
  settingsModule.createDshSettingImporter = () => async () => 'skipped';
  settingsModule.runV1SettingsImport = async () => ({ status: 'complete' });
  // What the guard catches is close() throwing — on Windows an indexer or AV
  // scanner holding the snapshot, on POSIX a directory that denies unlink. Both
  // are awkward to stage portably (a directory mode is not enforced on Windows,
  // and Node opens files sharing delete permission), so the snapshot is replaced
  // with a non-empty directory: rmSync refuses that on every platform.
  const snapshotPath = path.join(migrationDir, 'snapshot.db');
  automationsModule.runV1AutomationImport = async () => {
    fs.rmSync(snapshotPath, { force: true });
    fs.mkdirSync(snapshotPath, { recursive: true });
    fs.writeFileSync(path.join(snapshotPath, 'held'), 'still in use');
    finishedResolve();
    return { status: 'complete' };
  };

  try {
    const { apply } = await import(`${pathToFileURL(path.join(__dirname, 'index.mjs')).href}?locked=${Date.now()}`);
    apply({
      connection: { rpc: { handle: () => async () => {} } },
      effect: (setup) => { stopPlugin = setup(); },
      llm: { listProviders: () => [], listModels: async () => [] },
      logger: { warn: (message) => warnings.push(message) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'opencode', model: 'big-pickle' }) },
      pawworkAutomations: { scheduler: { refresh: () => {} }, store: { activateImportedDefinitions: () => {} } },
      sessionTitle: { rename: () => {} },
      sessions: { enter: () => () => {}, flush: async () => {}, prepare: () => ({}) },
      attachments: { saveImage: async () => {} },
      workspaceRegistry: {},
    });
    await finished;
    // Rejects if the cleanup failure escaped the task.
    await stopPlugin();

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /snapshot cleanup failed/);
  } finally {
    importerModule.runV1SessionImport = originalRun;
    settingsModule.createDshSettingImporter = originalCreateSettingImporter;
    settingsModule.runV1SettingsImport = originalSettingsRun;
    automationsModule.runV1AutomationImport = originalAutomationsRun;
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    if (originalSource === undefined) delete process.env.PAWWORK_V1_DATABASE;
    else process.env.PAWWORK_V1_DATABASE = originalSource;
  }
});

test('derives completed session targets from the migration ledger', () => {
  const home = temporaryDirectory();
  const directory = path.join(home, 'import-v1');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'ledger.json'), JSON.stringify({
    schema: 1,
    sessions: {
      complete: { status: 'complete', targetId: 'pawwork-v1-complete' },
      failed: { status: 'failed', targetId: 'pawwork-v1-failed' },
    },
  }));

  assert.deepEqual([...completedV1SessionTargetIds(home)], ['pawwork-v1-complete']);
});

test('plugin disposal aborts and awaits the background migration before unregistering RPC', async () => {
  const importerModule = require('./import-v1.cjs');
  const settingsModule = require('./import-v1-settings.cjs');
  const automationsModule = require('./import-v1-automations.cjs');
  const originalRun = importerModule.runV1SessionImport;
  const originalSettingsRun = settingsModule.runV1SettingsImport;
  const originalAutomationsRun = automationsModule.runV1AutomationImport;
  let started;
  const importStarted = new Promise((resolve) => { started = resolve; });
  let stopPlugin;
  let rpcStopped = false;
  let settingsCalls = 0;
  let automationCalls = 0;
  importerModule.runV1SessionImport = async ({ signal }) => {
    started();
    await new Promise((resolve) => signal.addEventListener('abort', () => setImmediate(resolve), { once: true }));
    signal.throwIfAborted();
  };
  settingsModule.runV1SettingsImport = async () => { settingsCalls += 1; };
  automationsModule.runV1AutomationImport = async () => { automationCalls += 1; };
  try {
    const pluginUrl = `${pathToFileURL(path.join(__dirname, 'index.mjs')).href}?dispose=${Date.now()}`;
    const { apply } = await import(pluginUrl);
    apply({
      connection: { rpc: { handle: () => async () => { rpcStopped = true; } } },
      effect: (setup) => { stopPlugin = setup(); },
      logger: { warn: () => {} },
    });
    await importStarted;

    const stopped = stopPlugin();
    assert.equal(rpcStopped, false);
    await stopped;

    assert.equal(rpcStopped, true);
    assert.equal(settingsCalls, 0);
    assert.equal(automationCalls, 0);
  } finally {
    importerModule.runV1SessionImport = originalRun;
    settingsModule.runV1SettingsImport = originalSettingsRun;
    automationsModule.runV1AutomationImport = originalAutomationsRun;
  }
});

function createV1Fixture(file) {
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      execution_context TEXT,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  const insertSession = database.prepare(`
    INSERT INTO session (
      id, project_id, workspace_id, parent_id, slug, directory,
      execution_context, title, version, time_created, time_updated, time_archived
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertSession.run(
    'ses_parent',
    'project_1',
    'workspace_1',
    null,
    'parent',
    '/Users/alice/work',
    JSON.stringify({ ownerDirectory: '/Users/alice/work', activeDirectory: '/Users/alice/worktree' }),
    'Original title',
    '1.2.3',
    1_000,
    4_000,
    null,
  );
  insertSession.run(
    'ses_child',
    'project_1',
    'workspace_1',
    'ses_parent',
    'child',
    '/Users/alice/worktree',
    null,
    'Child title',
    '1.2.3',
    5_000,
    6_000,
    7_000,
  );

  const insertMessage = database.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
  );
  insertMessage.run(
    'msg_user',
    'ses_parent',
    2_000,
    2_100,
    JSON.stringify({
      role: 'user',
      time: { created: 2_000 },
      agent: 'build',
      model: { providerID: 'opencode', modelID: 'big-pickle' },
    }),
  );
  insertMessage.run(
    'msg_assistant',
    'ses_parent',
    3_000,
    4_000,
    JSON.stringify({
      role: 'assistant',
      time: { created: 3_000, completed: 4_000 },
      parentID: 'msg_user',
      providerID: 'opencode',
      modelID: 'big-pickle',
    }),
  );

  const insertPart = database.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insertPart.run(
    'part_user_text',
    'msg_user',
    'ses_parent',
    2_000,
    2_000,
    JSON.stringify({ type: 'text', text: 'Inspect the project' }),
  );
  insertPart.run(
    'part_file',
    'msg_user',
    'ses_parent',
    2_001,
    2_001,
    JSON.stringify({ type: 'file', mime: 'text/plain', filename: 'notes.txt', url: 'data:text/plain;base64,aGVsbG8=' }),
  );
  insertPart.run(
    'part_reasoning',
    'msg_assistant',
    'ses_parent',
    3_000,
    3_100,
    JSON.stringify({ type: 'reasoning', text: 'I should inspect the files.', time: { start: 3_000, end: 3_100 } }),
  );
  insertPart.run(
    'part_tool',
    'msg_assistant',
    'ses_parent',
    3_200,
    3_300,
    JSON.stringify({
      type: 'tool',
      callID: 'call_1',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'ls' },
        output: 'README.md',
        title: 'List files',
        metadata: {},
        time: { start: 3_200, end: 3_300 },
      },
    }),
  );
  insertPart.run(
    'part_assistant_text',
    'msg_assistant',
    'ses_parent',
    3_400,
    3_400,
    JSON.stringify({ type: 'text', text: 'The project contains a README.' }),
  );
  database.close();
}

// Both import stages locate v1 through this one function, so the platform layout
// is pinned here for the app-data root and the database alike.
test('locates the official v1 data root and database on macOS and Windows', () => {
  const darwin = { platform: 'darwin', home: '/Users/alice', env: {} };
  assert.equal(
    v1DataPath(darwin),
    path.join('/Users/alice', 'Library', 'Application Support', 'ai.pawwork.desktop'),
  );
  assert.equal(
    v1DataPath(darwin, 'data', 'pawwork', 'pawwork.db'),
    path.join(
      '/Users/alice',
      'Library',
      'Application Support',
      'ai.pawwork.desktop',
      'data',
      'pawwork',
      'pawwork.db',
    ),
  );

  const windows = {
    platform: 'win32',
    home: 'C:\\Users\\alice',
    env: { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' },
    pathApi: path.win32,
  };
  assert.equal(v1DataPath(windows), 'C:\\Users\\alice\\AppData\\Roaming\\ai.pawwork.desktop');
  assert.equal(
    v1DataPath(windows, 'data', 'pawwork', 'pawwork.db'),
    'C:\\Users\\alice\\AppData\\Roaming\\ai.pawwork.desktop\\data\\pawwork\\pawwork.db',
  );

  assert.equal(v1DataPath({ platform: 'linux', home: '/home/alice', env: {} }), null);
});

test('prefers an explicit source and otherwise returns the first existing official database', () => {
  const root = temporaryDirectory();
  const explicit = path.join(root, 'selected.db');
  const official = path.join(
    root,
    'Library',
    'Application Support',
    'ai.pawwork.desktop',
    'data',
    'pawwork',
    'pawwork.db',
  );
  fs.mkdirSync(path.dirname(official), { recursive: true });
  fs.writeFileSync(official, 'official');
  fs.writeFileSync(explicit, 'explicit');

  assert.equal(
    discoverV1Database({
      platform: 'darwin',
      home: root,
      env: { PAWWORK_V1_DATABASE: explicit },
    }),
    explicit,
  );
  assert.equal(discoverV1Database({ platform: 'darwin', home: root, env: {} }), official);

  // The settings stage reads the same root through the same rule, so its own
  // override name is pinned here rather than only where it is consumed.
  const appData = path.join(root, 'Library', 'Application Support', 'ai.pawwork.desktop');
  const movedProfile = path.join(root, 'moved-profile');
  fs.mkdirSync(movedProfile, { recursive: true });

  assert.equal(discoverV1AppData({ platform: 'darwin', home: root, env: {} }), appData);
  assert.equal(
    discoverV1AppData({ platform: 'darwin', home: root, env: { PAWWORK_V1_APP_DATA: movedProfile } }),
    movedProfile,
  );
  assert.equal(discoverV1AppData({ platform: 'linux', home: root, env: {} }), null);
});

test('creates a consistent SQLite snapshot without changing source data or its WAL', async () => {
  const root = temporaryDirectory();
  const source = path.join(root, 'pawwork.db');
  const destination = path.join(root, 'snapshot.db');
  const secondDestination = path.join(root, 'snapshot-second.db');
  const database = new DatabaseSync(source);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA wal_autocheckpoint = 0');
  database.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
  database.prepare('INSERT INTO session VALUES (?, ?)').run('ses_1', 'First');
  database.prepare('INSERT INTO session VALUES (?, ?)').run('ses_2', 'Second');

  // SQLite readers briefly update lock bytes in the shared-memory sidecar. The
  // database and WAL are the durable source records that must remain untouched.
  const sourceFiles = [source, `${source}-wal`].filter(fs.existsSync);
  const before = new Map(
    sourceFiles.map((file) => [
      file,
      { digest: fileDigest(file), size: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs },
    ]),
  );

  fs.writeFileSync(destination, 'stale snapshot from an interrupted migration');
  await createDatabaseSnapshot(source, destination);
  if (process.platform !== 'win32') assert.equal(fs.statSync(destination).mode & 0o777, 0o600);

  const snapshot = new DatabaseSync(destination, { readOnly: true });
  assert.deepEqual(
    snapshot.prepare('SELECT id, title FROM session ORDER BY id').all().map((row) => ({ ...row })),
    [
      { id: 'ses_1', title: 'First' },
      { id: 'ses_2', title: 'Second' },
    ],
  );
  snapshot.close();

  await createDatabaseSnapshot(source, secondDestination);
  const secondSnapshot = new DatabaseSync(secondDestination, { readOnly: true });
  assert.equal(secondSnapshot.prepare('SELECT count(*) AS total FROM session').get().total, 2);
  secondSnapshot.close();

  for (const [file, expected] of before) {
    const stat = fs.statSync(file);
    assert.equal(fileDigest(file), expected.digest, file);
    assert.equal(stat.size, expected.size, file);
    assert.equal(stat.mtimeMs, expected.mtimeMs, file);
  }
  database.close();
});

test('reads v1 sessions one at a time with hierarchy, working path, messages, and parts intact', async () => {
  const root = temporaryDirectory();
  const source = path.join(root, 'pawwork.db');
  createV1Fixture(source);

  const sessions = [];
  for await (const session of readV1Sessions(source)) sessions.push(session);

  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0], {
    id: 'ses_parent',
    parentId: null,
    cwd: '/Users/alice/worktree',
    title: 'Original title',
    version: '1.2.3',
    createdAt: 1_000,
    updatedAt: 4_000,
    archivedAt: null,
    messages: [
      {
        id: 'msg_user',
        createdAt: 2_000,
        updatedAt: 2_100,
        data: {
          role: 'user',
          time: { created: 2_000 },
          agent: 'build',
          model: { providerID: 'opencode', modelID: 'big-pickle' },
        },
        parts: [
          {
            id: 'part_user_text',
            createdAt: 2_000,
            updatedAt: 2_000,
            data: { type: 'text', text: 'Inspect the project' },
          },
          {
            id: 'part_file',
            createdAt: 2_001,
            updatedAt: 2_001,
            data: {
              type: 'file',
              mime: 'text/plain',
              filename: 'notes.txt',
              url: 'data:text/plain;base64,aGVsbG8=',
            },
          },
        ],
      },
      {
        id: 'msg_assistant',
        createdAt: 3_000,
        updatedAt: 4_000,
        data: {
          role: 'assistant',
          time: { created: 3_000, completed: 4_000 },
          parentID: 'msg_user',
          providerID: 'opencode',
          modelID: 'big-pickle',
        },
        parts: [
          {
            id: 'part_reasoning',
            createdAt: 3_000,
            updatedAt: 3_100,
            data: {
              type: 'reasoning',
              text: 'I should inspect the files.',
              time: { start: 3_000, end: 3_100 },
            },
          },
          {
            id: 'part_tool',
            createdAt: 3_200,
            updatedAt: 3_300,
            data: {
              type: 'tool',
              callID: 'call_1',
              tool: 'bash',
              state: {
                status: 'completed',
                input: { command: 'ls' },
                output: 'README.md',
                title: 'List files',
                metadata: {},
                time: { start: 3_200, end: 3_300 },
              },
            },
          },
          {
            id: 'part_assistant_text',
            createdAt: 3_400,
            updatedAt: 3_400,
            data: { type: 'text', text: 'The project contains a README.' },
          },
        ],
      },
    ],
  });
  assert.equal(sessions[1].id, 'ses_child');
  assert.equal(sessions[1].parentId, 'ses_parent');
  assert.equal(sessions[1].archivedAt, 7_000);
});

test('builds a valid DSH seed with an explicit legacy boundary and no native tool events', async () => {
  const root = temporaryDirectory();
  const source = path.join(root, 'pawwork.db');
  createV1Fixture(source);
  const sessions = [];
  for await (const session of readV1Sessions(source)) sessions.push(session);

  const imported = buildDshSession(sessions[0]);
  assert.equal(imported.id, 'pawwork-v1-ses_parent');
  assert.equal(imported.title, 'Original title');
  assert.deepEqual(imported.meta, {
    cwd: '/Users/alice/worktree',
    createdAt: 1_000,
    seedLength: imported.seed.length,
  });
  assert.equal(imported.seed.some((event) => event.type === 'tool/call'), false);
  assert.equal(imported.seed.some((event) => event.type === 'tool/result'), false);
  assert.deepEqual(imported.stats, {
    messages: 2,
    parts: 5,
    skippedParts: 0,
    unsupportedParts: 0,
  });

  const legacySession = imported.seed[0];
  assert.equal(legacySession.type, 'pawwork-v1/session');
  assert.equal(legacySession.ignorable, true);
  assert.deepEqual(legacySession.data, {
    schema: 1,
    sourceSessionId: 'ses_parent',
    version: '1.2.3',
    archivedAt: null,
  });

  const dshPackageRequire = createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
  const dshSessionUrl = pathToFileURL(dshPackageRequire.resolve('@deepseek-ai/dsh-session')).href;
  const { Session } = await import(dshSessionUrl);
  const validated = Session.create(imported.id, imported.seed);
  assert.equal(validated.events.at(-1).type, 'session/end-seed');
  const messages = validated.deriveMessages();
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0].content, [
    { type: 'text', text: 'Inspect the project' },
    {
      type: 'pawwork-v1-attachment',
      id: 'part_file',
      createdAt: 2_001,
      updatedAt: 2_001,
      mime: 'text/plain',
      filename: 'notes.txt',
      url: 'data:text/plain;base64,aGVsbG8=',
    },
  ]);
  assert.deepEqual(messages[1].content, [
    { type: 'reasoning', text: 'I should inspect the files.' },
    {
      type: 'pawwork-v1-tool',
      id: 'part_tool',
      createdAt: 3_200,
      updatedAt: 3_300,
      callId: 'call_1',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'ls' },
        output: 'README.md',
        title: 'List files',
        metadata: {},
        time: { start: 3_200, end: 3_300 },
      },
    },
    { type: 'text', text: 'The project contains a README.' },
  ]);
  assert.deepEqual(messages[1].source, {
    kind: 'model',
    provider: 'opencode',
    model: 'big-pickle',
  });

  const child = buildDshSession(sessions[1]);
  assert.equal(child.meta.parentSession, 'pawwork-v1-ses_parent');
});

test('materializes v1 data images through the official DSH attachment store', async () => {
  const imported = {
    seed: [
      {
        type: 'user/message',
        data: {
          content: [
            {
              type: 'pawwork-v1-attachment',
              mime: 'image/png',
              filename: 'pixel.png',
              url: 'data:image/png;base64,iVBORw0KGgo=',
            },
            {
              type: 'pawwork-v1-attachment',
              mime: 'text/plain',
              filename: 'notes.txt',
              url: 'data:text/plain;base64,aGVsbG8=',
            },
          ],
        },
      },
    ],
  };
  const saved = [];

  await materializeLegacyImages(imported, async (image) => {
    saved.push(image);
    return {
      attachmentId: 'sha256:image',
      mediaType: image.mediaType,
      bytes: image.data.byteLength,
      width: 1,
      height: 1,
      name: image.name,
    };
  });

  assert.equal(saved.length, 1);
  assert.equal(saved[0].mediaType, 'image/png');
  assert.equal(saved[0].name, 'pixel.png');
  assert.equal(Buffer.from(saved[0].data).toString('base64'), 'iVBORw0KGgo=');
  assert.deepEqual(imported.seed[0].data.content[0], {
    type: 'image',
    attachment: {
      attachmentId: 'sha256:image',
      mediaType: 'image/png',
      bytes: 8,
      width: 1,
      height: 1,
      name: 'pixel.png',
    },
  });
  assert.equal(imported.seed[0].data.content[1].type, 'pawwork-v1-attachment');
});

test('attaches an imported session through the official DSH workspace registry', async () => {
  const attached = [];
  const created = [];
  const workspaceRegistry = {
    create: async (directory) => {
      created.push(directory);
      return {
        attachSession: async (sessionId) => attached.push(sessionId),
      };
    },
  };

  await attachDshWorkspace({
    id: 'pawwork-v1-ses_parent',
    meta: { cwd: '/Users/alice/worktree' },
  }, workspaceRegistry);

  assert.deepEqual(created, ['/Users/alice/worktree']);
  assert.deepEqual(attached, ['pawwork-v1-ses_parent']);
});

test('records a removed v1 directory as unavailable instead of retrying forever', async () => {
  const missing = Object.assign(new Error('directory no longer exists'), { code: 'ENOENT' });
  const workspaceRegistry = {
    create: async () => { throw missing; },
  };

  const result = await attachDshWorkspace({
    id: 'pawwork-v1-ses_removed',
    meta: { cwd: '/Users/alice/removed-worktree' },
  }, workspaceRegistry);

  assert.equal(result, 'unavailable');
});

test('records an idempotent ledger and does no work after a complete session import', async () => {
  const root = temporaryDirectory();
  const source = path.join(root, 'pawwork.db');
  const home = path.join(root, 'v2-home');
  createV1Fixture(source);
  const importedIds = [];

  await runV1SessionImport({
    home,
    sourceDatabase: source,
    snapshot: await snapshotOf(home, source),
    importSession: async (session) => {
      importedIds.push(session.id);
      return 'attached';
    },
  });
  assert.deepEqual(importedIds, ['pawwork-v1-ses_parent', 'pawwork-v1-ses_child']);

  const ledger = JSON.parse(fs.readFileSync(path.join(home, 'import-v1', 'ledger.json'), 'utf8'));
  assert.equal(ledger.schema, 1);
  assert.equal(ledger.sessions.ses_parent.targetId, 'pawwork-v1-ses_parent');
  assert.equal(ledger.sessions.ses_parent.status, 'complete');
  assert.equal(ledger.sessions.ses_child.status, 'complete');
  await runV1SessionImport({
    home,
    sourceDatabase: source,
    snapshot: await snapshotOf(home, source),
    importSession: async () => {
      throw new Error('completed import must not run again');
    },
  });
});

test('a run without a v1 database leaves the recorded source identity intact', async () => {
  const root = temporaryDirectory();
  const source = path.join(root, 'pawwork.db');
  const home = path.join(root, 'v2-home');
  createV1Fixture(source);

  await runV1SessionImport({
    home,
    sourceDatabase: source,
    snapshot: await snapshotOf(home, source),
    importSession: async () => 'attached',
  });
  await runV1SessionImport({
    home,
    sourceDatabase: null,
    importSession: async () => { throw new Error('no session should be imported'); },
  });

  const ledger = JSON.parse(fs.readFileSync(path.join(home, 'import-v1', 'ledger.json'), 'utf8'));
  assert.equal(ledger.sourceDatabase, source);
  // Recording null above erased the identity, so a later run against a
  // different database was accepted instead of refused.
  const other = path.join(root, 'other.db');
  createV1Fixture(other);
  await assert.rejects(
    runV1SessionImport({
      home,
      sourceDatabase: other,
      snapshot: await snapshotOf(home, other),
      importSession: async () => { throw new Error('a swapped source must not import'); },
    }),
    /v1 migration source changed/,
  );
});

// All three stages and the ledger reader route through one owner now, so this is
// the only implementation of either guard left to break.
test('refuses a ledger home that is not absolute', async () => {
  await assert.rejects(
    runV1SessionImport({ home: 'v2-home', importSession: async () => {} }),
    /v1 import home must be absolute/,
  );
  assert.throws(() => completedV1SessionTargetIds('v2-home'), /v1 import home must be absolute/);
});

test('refuses to keep importing when the v1 database underneath the ledger changed', async () => {
  const root = temporaryDirectory();
  const first = path.join(root, 'pawwork.db');
  const second = path.join(root, 'moved.db');
  const home = path.join(root, 'v2-home');
  createV1Fixture(first);
  createV1Fixture(second);

  await runV1SessionImport({
    home,
    sourceDatabase: first,
    snapshot: await snapshotOf(home, first),
    importSession: async () => 'attached',
  });

  await assert.rejects(
    runV1SessionImport({
      home,
      sourceDatabase: second,
      snapshot: await snapshotOf(home, second),
      importSession: async () => { throw new Error('a swapped source must not import'); },
    }),
    /v1 migration source changed from .*pawwork\.db to .*moved\.db/,
  );
});

test('resumes after a per-session failure without duplicating completed sessions', async () => {
  const root = temporaryDirectory();
  const source = path.join(root, 'pawwork.db');
  const home = path.join(root, 'v2-home');
  createV1Fixture(source);
  const firstAttempt = [];

  await runV1SessionImport({
    home,
    sourceDatabase: source,
    snapshot: await snapshotOf(home, source),
    importSession: async (session) => {
      firstAttempt.push(session.id);
      if (session.id === 'pawwork-v1-ses_parent') session.stats.unsupportedParts += 1;
      if (session.id === 'pawwork-v1-ses_child') throw new Error('simulated interruption');
      return 'attached';
    },
  });
  // The aggregate status is gone: what the resume actually turns on is the
  // per-session ledger record the first attempt left behind.
  const afterFailure = JSON.parse(fs.readFileSync(path.join(home, 'import-v1', 'ledger.json'), 'utf8'));
  assert.equal(afterFailure.sessions.ses_parent.status, 'complete');
  assert.equal(afterFailure.sessions.ses_child.status, 'failed');

  const resumed = [];
  await runV1SessionImport({
    home,
    sourceDatabase: source,
    snapshot: await snapshotOf(home, source),
    importSession: async (session) => {
      resumed.push(session.id);
      return 'attached';
    },
  });
  assert.deepEqual(resumed, ['pawwork-v1-ses_child']);
  const ledger = JSON.parse(fs.readFileSync(path.join(home, 'import-v1', 'ledger.json'), 'utf8'));
  assert.equal(ledger.sessions.ses_parent.stats.unsupportedParts, 1);
});

test('does not commit a session after cancellation during its import', async () => {
  const root = temporaryDirectory();
  const source = path.join(root, 'pawwork.db');
  const home = path.join(root, 'v2-home');
  createV1Fixture(source);
  fs.mkdirSync(path.join(home, 'import-v1'), { recursive: true });
  fs.writeFileSync(path.join(home, 'import-v1', 'ledger.json'), JSON.stringify({ schema: 1, sessions: {} }));
  const controller = new AbortController();

  await assert.rejects(runV1SessionImport({
    home,
    sourceDatabase: source,
    snapshot: await snapshotOf(home, source),
    signal: controller.signal,
    importSession: async () => {
      controller.abort(new Error('session import stopped'));
      return 'attached';
    },
  }), /session import stopped/);

  const ledger = JSON.parse(fs.readFileSync(path.join(home, 'import-v1', 'ledger.json'), 'utf8'));
  assert.equal(ledger.sessions.ses_parent, undefined);
});

test('records a malformed session and continues importing later sessions', async () => {
  const root = temporaryDirectory();
  const source = path.join(root, 'pawwork.db');
  const home = path.join(root, 'v2-home');
  createV1Fixture(source);
  const database = new DatabaseSync(source);
  database.prepare('UPDATE message SET data = ? WHERE session_id = ?').run('{', 'ses_parent');
  database.close();
  const imported = [];

  await runV1SessionImport({
    home,
    sourceDatabase: source,
    snapshot: await snapshotOf(home, source),
    importSession: async (session) => {
      imported.push(session.id);
      return 'attached';
    },
  });

  assert.deepEqual(imported, ['pawwork-v1-ses_child']);
  const ledger = JSON.parse(fs.readFileSync(path.join(home, 'import-v1', 'ledger.json'), 'utf8'));
  assert.equal(ledger.sessions.ses_parent.status, 'failed');
  assert.match(ledger.sessions.ses_parent.message, /invalid JSON in message/);
  assert.equal(ledger.sessions.ses_child.status, 'complete');
});

test('can import sessions from a ledger first written by settings migration', async () => {
  const root = temporaryDirectory();
  const source = path.join(root, 'pawwork.db');
  const home = path.join(root, 'v2-home');
  createV1Fixture(source);
  fs.mkdirSync(path.join(home, 'import-v1'), { recursive: true });
  fs.writeFileSync(path.join(home, 'import-v1', 'ledger.json'), JSON.stringify({
    schema: 1,
    sourceAppData: '/tmp/v1-app-data',
    settings: { theme: { status: 'complete', outcome: 'imported' } },
  }));

  await runV1SessionImport({
    home,
    sourceDatabase: source,
    snapshot: await snapshotOf(home, source),
    importSession: async () => 'attached',
  });

  // The three stages share one ledger file and each writes the whole document
  // back, so what matters is that a stage carries the other stages' records
  // through rather than replacing them with its own view.
  const ledger = JSON.parse(fs.readFileSync(path.join(home, 'import-v1', 'ledger.json'), 'utf8'));
  assert.equal(ledger.sourceAppData, '/tmp/v1-app-data');
  assert.deepEqual(ledger.settings, { theme: { status: 'complete', outcome: 'imported' } });
  assert.equal(ledger.sessions.ses_parent.status, 'complete');
});

test('repairs workspace ownership when session records lack an outcome', async () => {
  const root = temporaryDirectory();
  const source = path.join(root, 'pawwork.db');
  const home = path.join(root, 'v2-home');
  createV1Fixture(source);
  fs.mkdirSync(path.join(home, 'import-v1'), { recursive: true });
  fs.writeFileSync(path.join(home, 'import-v1', 'ledger.json'), JSON.stringify({
    schema: 1,
    sourceDatabase: source,
    sessions: {
      ses_parent: { status: 'complete', targetId: 'pawwork-v1-ses_parent' },
      ses_child: { status: 'complete', targetId: 'pawwork-v1-ses_child' },
    },
  }));

  const repaired = [];
  await runV1SessionImport({
    home,
    sourceDatabase: source,
    snapshot: await snapshotOf(home, source),
    importSession: async (session, { contentImported }) => {
      repaired.push({ id: session.id, contentImported });
      return session.id === 'pawwork-v1-ses_child' ? 'unavailable' : 'attached';
    },
  });

  // Both records say complete, so the workspace retry must not write the seed
  // again: materializeLegacyImages would save every image in them a second time.
  assert.deepEqual(repaired, [
    { id: 'pawwork-v1-ses_parent', contentImported: true },
    { id: 'pawwork-v1-ses_child', contentImported: true },
  ]);
  const ledger = JSON.parse(fs.readFileSync(path.join(home, 'import-v1', 'ledger.json'), 'utf8'));
  assert.equal(ledger.sessions.ses_parent.workspaceAttached, true);
  assert.equal(ledger.sessions.ses_child.workspaceAttached, false);
  assert.equal(ledger.sessions.ses_child.workspaceUnavailable, true);
});
