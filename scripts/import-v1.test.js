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
  v1DatabaseCandidates,
} = require('./import-v1');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pawwork-import-v1-'));
}

function fileDigest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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
