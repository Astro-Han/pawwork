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

// The cron quirk: when both the day-of-month and the day-of-week fields are
// restricted, a date matches if EITHER does — not both. Nothing exercised it,
// so flipping the rule to AND stayed green, and `0 9 1 * 1` would have fired
// only on Mondays that happen to fall on the 1st.
test('a restricted day-of-month and day-of-week match as either, not both', () => {
  // 2026-09-01 is a Tuesday, so the 1st and the Mondays are different days.
  const next = (from) => nextCronFireAfter('0 9 1 * 1', 'UTC', Date.parse(from));

  // From late August: the next Monday, 2026-08-31, before the 1st.
  assert.equal(next('2026-08-29T00:00:00.000Z'), Date.parse('2026-08-31T09:00:00.000Z'));
  // From that Monday's afternoon: the 1st, which is not a Monday.
  assert.equal(next('2026-08-31T12:00:00.000Z'), Date.parse('2026-09-01T09:00:00.000Z'));
  // From the 1st's afternoon: the following Monday, 2026-09-07.
  assert.equal(next('2026-09-01T12:00:00.000Z'), Date.parse('2026-09-07T09:00:00.000Z'));

  // With only one of the two restricted the rule is unchanged: every Monday.
  assert.equal(
    nextCronFireAfter('0 9 * * 1', 'UTC', Date.parse('2026-09-01T12:00:00.000Z')),
    Date.parse('2026-09-07T09:00:00.000Z'),
  );
  // And only the 15th, whatever weekday it lands on.
  assert.equal(
    nextCronFireAfter('0 9 15 * *', 'UTC', Date.parse('2026-09-01T12:00:00.000Z')),
    Date.parse('2026-09-15T09:00:00.000Z'),
  );
});

test('accepts the v1 five-field grammar and rejects unreachable schedules', () => {
  assert.equal(isValidCronExpression('*/15 9-17 * * 1-5'), true);
  assert.equal(isValidCronExpression('0 9 31 2 *'), false);
  assert.equal(isValidCronExpression('0 9 * * MON'), false);
});
