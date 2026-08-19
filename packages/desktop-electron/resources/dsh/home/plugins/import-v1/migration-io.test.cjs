'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { readMigrationLedger } = require('./migration-io.cjs');

test('normalizes legacy construction fields without losing migration facts', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawwork-ledger-'));
  const ledgerPath = path.join(home, 'ledger.json');
  fs.writeFileSync(ledgerPath, JSON.stringify({
    schema: 1,
    sourceDatabase: '/v1/pawwork.db',
    sessions: { legacy: { status: 'complete' } },
    credentials: { provider: { status: 'complete' } },
    stage1Complete: true,
    stage2Complete: true,
    stage4DataComplete: true,
    workspaceStageComplete: true,
  }));

  try {
    const ledger = readMigrationLedger(ledgerPath, { schema: 1 });
    assert.deepEqual(ledger, {
      schema: 1,
      sourceDatabase: '/v1/pawwork.db',
      sessions: { legacy: { status: 'complete' } },
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
