'use strict';

const MAX_LOOKAHEAD_DAYS = 366 * 5;
const formatterCache = new Map();

function cronValues(field, minimum, maximum, { sundayAlias = false } = {}) {
  const values = new Set();
  for (const item of field.split(',')) {
    const segments = item.split('/');
    if (segments.length > 2 || !segments[0]) throw new Error(`invalid cron field: ${item}`);
    const [base, rawStep] = segments;
    const step = rawStep === undefined ? 1 : Number(rawStep);
    if (!Number.isInteger(step) || step <= 0) throw new Error(`invalid cron step: ${item}`);
    const range = base === '*' ? [minimum, maximum] : base.split('-').map(Number);
    if (range.length === 0 || range.length > 2 || range.some((value) => !Number.isInteger(value))) {
      throw new Error(`invalid cron field: ${item}`);
    }
    const start = range[0];
    const end = base === '*' || (range.length === 1 && rawStep !== undefined)
      ? maximum
      : range.at(-1);
    if (start < minimum || end > maximum || start > end) throw new Error(`invalid cron range: ${item}`);
    for (let value = start; value <= end; value += step) {
      values.add(sundayAlias && value === 7 ? 0 : value);
    }
  }
  return values;
}

function parseCronExpression(expression) {
  if (typeof expression !== 'string') throw new Error('cron expression must be a string');
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('cron expression must have five fields');
  const [minute, hour, day, month, weekday] = fields;
  return {
    minutes: cronValues(minute, 0, 59),
    hours: cronValues(hour, 0, 23),
    days: cronValues(day, 1, 31),
    months: cronValues(month, 1, 12),
    weekdays: cronValues(weekday, 0, 7, { sundayAlias: true }),
    dayRestricted: day !== '*',
    weekdayRestricted: weekday !== '*',
  };
}

function isValidTimezone(timezone) {
  if (typeof timezone !== 'string' || timezone.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function hasReachableCalendarDate(schedule) {
  const lastDay = new Map([
    [1, 31], [2, 29], [3, 31], [4, 30], [5, 31], [6, 30],
    [7, 31], [8, 31], [9, 30], [10, 31], [11, 30], [12, 31],
  ]);
  return [...schedule.months].some((month) => (
    [...schedule.days].some((day) => day <= lastDay.get(month))
  ));
}

function isValidCronExpression(expression) {
  try {
    const schedule = parseCronExpression(expression);
    return schedule.weekdayRestricted || hasReachableCalendarDate(schedule);
  } catch {
    return false;
  }
}

function formatter(timezone) {
  let value = formatterCache.get(timezone);
  if (value) return value;
  if (!isValidTimezone(timezone)) throw new Error(`invalid timezone: ${timezone}`);
  value = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  formatterCache.set(timezone, value);
  return value;
}

function zonedParts(timestamp, timezone) {
  const values = {};
  for (const part of formatter(timezone).formatToParts(new Date(timestamp))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
  };
}

function zoneOffsetAt(timestamp, timezone) {
  const parts = zonedParts(timestamp, timezone);
  const minute = Math.floor(timestamp / 60_000) * 60_000;
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - minute;
}

function sameWallTime(left, right) {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute;
}

function instantsForWallTime(wallTime, timezone) {
  const naive = Date.UTC(
    wallTime.year,
    wallTime.month - 1,
    wallTime.day,
    wallTime.hour,
    wallTime.minute,
  );
  const offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    offsets.add(zoneOffsetAt(naive + hours * 3_600_000, timezone));
  }
  return [...offsets]
    .map((offset) => naive - offset)
    .filter((timestamp) => sameWallTime(zonedParts(timestamp, timezone), wallTime))
    .sort((left, right) => left - right);
}

function dateMatches(schedule, year, month, day) {
  if (!schedule.months.has(month)) return false;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const dayMatches = schedule.days.has(day);
  const weekdayMatches = schedule.weekdays.has(weekday);
  return schedule.dayRestricted && schedule.weekdayRestricted
    ? dayMatches || weekdayMatches
    : dayMatches && weekdayMatches;
}

function nextCronFireAfter(expression, timezone, from) {
  if (!Number.isSafeInteger(from) || from < 0) throw new Error('from must be a non-negative integer');
  const schedule = parseCronExpression(expression);
  if (!schedule.weekdayRestricted && !hasReachableCalendarDate(schedule)) {
    throw new Error(`cron expression has no reachable date: ${expression}`);
  }
  if (!isValidTimezone(timezone)) throw new Error(`invalid timezone: ${timezone}`);
  const local = zonedParts(from, timezone);
  const localStart = Date.UTC(local.year, local.month - 1, local.day);
  const hours = [...schedule.hours].sort((left, right) => left - right);
  const minutes = [...schedule.minutes].sort((left, right) => left - right);
  for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset += 1) {
    const date = new Date(localStart + offset * 86_400_000);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!dateMatches(schedule, year, month, day)) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const instants = instantsForWallTime({ year, month, day, hour, minute }, timezone);
        const next = instants.find((timestamp) => timestamp > from);
        if (next !== undefined) return next;
      }
    }
  }
  return null;
}

module.exports = {
  isValidCronExpression,
  isValidTimezone,
  nextCronFireAfter,
};
