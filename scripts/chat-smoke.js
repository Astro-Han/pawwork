#!/usr/bin/env node
// PawWork v2 — one real Zen Free turn against the product home. No user key.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildDshArgs,
  buildLaunchEnv,
  ensureProductHome,
  resolveDshBin,
} = require('./product-home');

const home = process.env.DSH_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'pawwork-chat-'));
const officialHome = path.join(os.homedir(), '.dsh');
const officialBefore = snapshotHome(officialHome);

ensureProductHome(home);
const dshBin = resolveDshBin();
const result = spawnSync(
  process.execPath,
  ['--expose-internals', dshBin, ...buildDshArgs('headless', ['Reply with exactly: OK'])],
  {
    encoding: 'utf8',
    env: buildLaunchEnv(home),
    timeout: 120000,
  },
);

const officialAfter = snapshotHome(officialHome);
if (officialAfter !== officialBefore) {
  console.error('chat-smoke mutated ~/.dsh');
  process.exit(1);
}
if (result.status !== 0) {
  console.error(result.stdout);
  console.error(result.stderr);
  process.exit(result.status || 1);
}

const text = (result.stdout || '').trim();
console.log(text);
if (!/\bOK\b/i.test(text)) {
  console.error('chat-smoke: expected a reply containing OK');
  process.exit(1);
}

function snapshotHome(dir) {
  if (!fs.existsSync(dir)) return '';
  const files = [];
  for (const entry of walk(dir)) {
    const stat = fs.statSync(entry);
    files.push(`${path.relative(dir, entry)}:${stat.mtimeMs}:${stat.size}`);
  }
  return files.sort().join('\n');
}

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const next = path.join(dir, name);
    const stat = fs.statSync(next);
    if (stat.isDirectory()) out.push(...walk(next));
    else out.push(next);
  }
  return out;
}
