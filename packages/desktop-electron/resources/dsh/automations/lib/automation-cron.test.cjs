'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidCronExpression,
  nextCronFireAfter,
} = require('./automation-cron.cjs');

test('finds the next cron fire in the requested IANA timezone', () => {
  const from = Date.parse('2026-08-18T00:30:00.000Z');
  assert.equal(
    nextCronFireAfter('0 9 * * 1-5', 'Asia/Shanghai', from),
    Date.parse('2026-08-18T01:00:00.000Z'),
  );
});

test('skips nonexistent wall times and preserves both fall-back occurrences', () => {
  assert.equal(
    nextCronFireAfter('30 2 * * *', 'America/New_York', Date.parse('2026-03-08T06:00:00.000Z')),
    Date.parse('2026-03-09T06:30:00.000Z'),
  );
  assert.equal(
    nextCronFireAfter('30 1 * * *', 'America/New_York', Date.parse('2026-11-01T05:45:00.000Z')),
    Date.parse('2026-11-01T06:30:00.000Z'),
  );
});

test('accepts the v1 five-field grammar and rejects unreachable schedules', () => {
  assert.equal(isValidCronExpression('*/15 9-17 * * 1-5'), true);
  assert.equal(isValidCronExpression('0 9 31 2 *'), false);
  assert.equal(isValidCronExpression('0 9 * * MON'), false);
});
