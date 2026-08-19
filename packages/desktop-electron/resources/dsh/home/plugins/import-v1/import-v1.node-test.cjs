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
  createDatabaseSnapshot,
  discoverV1Database,
  materializeLegacyImages,
  readV1Sessions,
  runV1SessionImport,
  v1DatabaseCandidates,
} = require('./import-v1.cjs');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pawwork-import-v1-'));
}

function fileDigest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('publishes only the final cold-session workspace state to the UI', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.mjs'), 'utf8');
  const flushAt = source.indexOf('await ctx.sessions.flush(session)');
  const detachAt = source.indexOf('detach();');
  const attachAt = source.indexOf('await importer.attachDshWorkspace(imported, ctx.workspaceRegistry)');
  assert.ok(flushAt >= 0 && flushAt < detachAt);
  assert.ok(detachAt < attachAt);
  assert.equal(source.includes('ctx.sessions.announce(session)'), false);
});

test('exposes only migration completion through the public DSH RPC seam', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.mjs'), 'utf8');
  assert.match(source, /'connection'/);
  assert.match(source, /ctx\.connection\.rpc\.handle\('\/pawwork-import-v1'/);
  assert.match(source, /sessionsComplete/);
});

test('keeps the public migration status incomplete after a partial session import', async () => {
  const importerModule = require('./import-v1.cjs');
  const settingsModule = require('./import-v1-settings.cjs');
  const automationsModule = require('./import-v1-automations.cjs');
  const originalRun = importerModule.runV1SessionImport;
  const originalCreateSettingImporter = settingsModule.createDshSettingImporter;
  const originalSettingsRun = settingsModule.runV1SettingsImport;
  const originalAutomationsRun = automationsModule.runV1AutomationImport;
  let statusRpc;
  let stopPlugin;
  let importStarted;
  const started = new Promise((resolve) => { importStarted = resolve; });
  let backgroundFinished;
  const finished = new Promise((resolve) => { backgroundFinished = resolve; });
  importerModule.runV1SessionImport = async () => {
    importStarted();
    return { status: 'partial' };
  };
  settingsModule.createDshSettingImporter = () => async () => 'skipped';
  settingsModule.runV1SettingsImport = async () => ({ status: 'complete' });
  automationsModule.runV1AutomationImport = async () => {
    backgroundFinished();
    return { status: 'complete' };
  };
  try {
    const pluginUrl = `${pathToFileURL(path.join(__dirname, 'index.mjs')).href}?status=${Date.now()}`;
    const { apply } = await import(pluginUrl);
    apply({
      connection: {
        rpc: {
          handle: (_channel, handler) => {
            statusRpc = handler;
            return async () => {};
          },
        },
      },
      effect: (setup) => { stopPlugin = setup(); },
      llm: { listProviders: () => [] },
      logger: { warn: () => {} },
      pawworkAutomations: { scheduler: { refresh: () => {} } },
      sessionPersistence: { list: async () => [] },
    });
    await started;
    await finished;

    assert.deepEqual(await statusRpc('status'), {
      ok: true,
      value: { sessionsComplete: false },
    });
    await stopPlugin();
  } finally {
    importerModule.runV1SessionImport = originalRun;
    settingsModule.createDshSettingImporter = originalCreateSettingImporter;
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

test('discovers only the official v1 production database on macOS and Windows', () => {
  assert.deepEqual(
    v1DatabaseCandidates({
      platform: 'darwin',
      home: '/Users/alice',
      env: {},
    }),
    [
      path.join(
        '/Users/alice',
        'Library',
        'Application Support',
        'ai.pawwork.desktop',
        'data',
        'pawwork',
        'pawwork.db',
      ),
    ],
  );

  assert.deepEqual(
    v1DatabaseCandidates({
      platform: 'win32',
      home: 'C:\\Users\\alice',
      env: { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' },
      pathApi: path.win32,
    }),
    [
      'C:\\Users\\alice\\AppData\\Roaming\\ai.pawwork.desktop\\data\\pawwork\\pawwork.db',
    ],
  );
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

  await createDatabaseSnapshot(source, destination);

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

test('reads v1 sessions one at a time with hierarchy, workspace, messages, and parts intact', async () => {
  const root = temporaryDirectory();
  const source = path.join(root, 'pawwork.db');
  createV1Fixture(source);

  const sessions = [];
  for await (const session of readV1Sessions(source)) sessions.push(session);

  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0], {
    id: 'ses_parent',
    projectId: 'project_1',
    workspaceId: 'workspace_1',
    parentId: null,
    directory: '/Users/alice/work',
    executionContext: { ownerDirectory: '/Users/alice/work', activeDirectory: '/Users/alice/worktree' },
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
    projectId: 'project_1',
    workspaceId: 'workspace_1',
    parentId: null,
    directory: '/Users/alice/work',
    executionContext: { ownerDirectory: '/Users/alice/work', activeDirectory: '/Users/alice/worktree' },
    title: 'Original title',
    version: '1.2.3',
    createdAt: 1_000,
    updatedAt: 4_000,
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

  const first = await runV1SessionImport({
    home,
    sourceDatabase: source,
    importSession: async (session) => {
      importedIds.push(session.id);
      return 'imported';
    },
  });
  assert.deepEqual(importedIds, ['pawwork-v1-ses_parent', 'pawwork-v1-ses_child']);
  assert.equal(first.status, 'complete');
  assert.deepEqual(first.sessions, { imported: 2, skipped: 0, failed: 0 });
  assert.equal(first.parts.unsupported, 0);
  assert.equal(fs.existsSync(path.join(home, 'import-v1', 'snapshot.db')), false);
  assert.equal(fs.existsSync(path.join(home, 'import-v1', 'snapshot.db-shm')), false);
  assert.equal(fs.existsSync(path.join(home, 'import-v1', 'snapshot.db-wal')), false);

  const ledger = JSON.parse(fs.readFileSync(path.join(home, 'import-v1', 'ledger.json'), 'utf8'));
  assert.equal(ledger.schema, 1);
  assert.equal(ledger.stage1Complete, true);
  assert.equal(ledger.sessions.ses_parent.targetId, 'pawwork-v1-ses_parent');
  assert.equal(ledger.sessions.ses_parent.status, 'complete');
  assert.equal(ledger.sessions.ses_child.status, 'complete');

  const second = await runV1SessionImport({
    home,
    sourceDatabase: source,
    importSession: async () => {
      throw new Error('completed import must not run again');
    },
  });
  assert.deepEqual(second, first);
});

test('finishes both migration stages when no v1 database exists', async () => {
  const home = path.join(temporaryDirectory(), 'v2-home');
  const result = await runV1SessionImport({
    home,
    sourceDatabase: null,
    importSession: async () => { throw new Error('no session should be imported'); },
  });

  assert.equal(result.status, 'not-found');
  const ledger = JSON.parse(fs.readFileSync(path.join(home, 'import-v1', 'ledger.json'), 'utf8'));
  assert.equal(ledger.stage1Complete, true);
  assert.equal(ledger.workspaceStageComplete, true);
});

test('resumes after a per-session failure without duplicating completed sessions', async () => {
  const root = temporaryDirectory();
  const source = path.join(root, 'pawwork.db');
  const home = path.join(root, 'v2-home');
  createV1Fixture(source);
  const firstAttempt = [];

  const partial = await runV1SessionImport({
    home,
    sourceDatabase: source,
    importSession: async (session) => {
      firstAttempt.push(session.id);
      if (session.id === 'pawwork-v1-ses_parent') session.stats.unsupportedParts += 1;
      if (session.id === 'pawwork-v1-ses_child') throw new Error('simulated interruption');
      return 'imported';
    },
  });
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.sessions, { imported: 1, skipped: 0, failed: 1 });
  assert.equal(partial.parts.unsupported, 1);

  const resumed = [];
  const complete = await runV1SessionImport({
    home,
    sourceDatabase: source,
    importSession: async (session) => {
      resumed.push(session.id);
      return 'imported';
    },
  });
  assert.deepEqual(resumed, ['pawwork-v1-ses_child']);
  assert.equal(complete.status, 'complete');
  assert.deepEqual(complete.sessions, { imported: 1, skipped: 1, failed: 0 });
  assert.equal(complete.parts.unsupported, 1);
});

test('can resume Stage 1 from a ledger first written by the settings stage', async () => {
  const root = temporaryDirectory();
  const source = path.join(root, 'pawwork.db');
  const home = path.join(root, 'v2-home');
  createV1Fixture(source);
  fs.mkdirSync(path.join(home, 'import-v1'), { recursive: true });
  fs.writeFileSync(path.join(home, 'import-v1', 'ledger.json'), JSON.stringify({
    schema: 1,
    sourceAppData: '/tmp/v1-app-data',
    stage2Complete: true,
    settings: {},
    credentials: {},
  }));

  const imported = await runV1SessionImport({
    home,
    sourceDatabase: source,
    importSession: async () => 'imported',
  });

  assert.equal(imported.status, 'complete');
  assert.deepEqual(imported.sessions, { imported: 2, skipped: 0, failed: 0 });
});

test('repairs workspace ownership recorded by a pre-workspace migration ledger', async () => {
  const root = temporaryDirectory();
  const source = path.join(root, 'pawwork.db');
  const home = path.join(root, 'v2-home');
  createV1Fixture(source);
  fs.mkdirSync(path.join(home, 'import-v1'), { recursive: true });
  fs.writeFileSync(path.join(home, 'import-v1', 'ledger.json'), JSON.stringify({
    schema: 1,
    sourceDatabase: source,
    stage1Complete: true,
    sessions: {
      ses_parent: { status: 'complete', targetId: 'pawwork-v1-ses_parent' },
      ses_child: { status: 'complete', targetId: 'pawwork-v1-ses_child' },
    },
  }));

  const repaired = [];
  const result = await runV1SessionImport({
    home,
    sourceDatabase: source,
    importSession: async (session) => {
      repaired.push(session.id);
      return {
        session: 'skipped',
        workspace: session.id === 'pawwork-v1-ses_child' ? 'unavailable' : 'attached',
      };
    },
  });

  assert.deepEqual(repaired, ['pawwork-v1-ses_parent', 'pawwork-v1-ses_child']);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.sessions, { imported: 0, skipped: 2, failed: 0 });
  assert.deepEqual(result.workspaces, { attached: 1, unavailable: 1, failed: 0 });
  const ledger = JSON.parse(fs.readFileSync(path.join(home, 'import-v1', 'ledger.json'), 'utf8'));
  assert.equal(ledger.workspaceStageComplete, true);
  assert.equal(ledger.sessions.ses_parent.workspaceAttached, true);
  assert.equal(ledger.sessions.ses_child.workspaceAttached, false);
  assert.equal(ledger.sessions.ses_child.workspaceUnavailable, true);
});
