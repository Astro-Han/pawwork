'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  createDatabaseSnapshot,
  discoverV1Database,
  readV1Sessions,
  v1DatabaseCandidates,
} = require('./import-v1');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pawwork-import-v1-'));
}

function fileDigest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

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
