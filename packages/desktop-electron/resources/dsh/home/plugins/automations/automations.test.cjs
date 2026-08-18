'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AutomationScheduler,
  AutomationStore,
  createAutomationToolDefinitions,
} = require('./automations.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pawwork-automations-'));
  return {
    root,
    file: path.join(root, 'automations.json'),
    cwd: path.join(root, 'workspace'),
  };
}

function oneShot(store, cwd, fireAt, now = 1_000) {
  return store.createDefinition({
    kind: 'oneshot',
    title: 'Send report',
    prompt: 'Prepare the report.',
    cwd,
    fireAt,
    model: { provider: 'opencode', model: 'big-pickle' },
  }, now);
}

function interval(store, cwd, everyMs, now = 1_000) {
  return store.createDefinition({
    kind: 'recurring',
    title: 'Check inbox',
    prompt: 'Check the inbox.',
    cwd,
    rhythm: { kind: 'interval', everyMs },
    model: { provider: 'opencode', model: 'big-pickle' },
  }, now);
}

function fakeClock(initial) {
  let now = initial;
  let armed;
  return {
    now: () => now,
    setNow: (value) => { now = value; },
    setTimeout: (callback, delay) => {
      armed = { callback, delay };
      return armed;
    },
    clearTimeout: () => { armed = undefined; },
    armed: () => armed,
  };
}

test('persists definitions and run history with monotonic ids', () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const created = oneShot(store, cwd, 2_000);
  const run = store.beginRun(created.id, 1_500, false);
  store.completeRun(run.id, {
    state: 'succeeded',
    completedAt: 1_700,
    sessionId: 'pawwork-automation-run-1',
    result: 'done',
  });

  const reopened = new AutomationStore(file);
  assert.equal(reopened.getDefinition(created.id).title, 'Send report');
  assert.deepEqual(reopened.listRuns(created.id), [{
    id: 'automation-run-1',
    automationId: 'automation-1',
    definitionRevision: 1,
    triggeredAt: 1_500,
    startedAt: 1_500,
    completedAt: 1_700,
    state: 'succeeded',
    sessionId: 'pawwork-automation-run-1',
    result: 'done',
    error: null,
    stopReason: null,
  }]);
  assert.equal(oneShot(reopened, cwd, 3_000).id, 'automation-2');
});

test('startup interrupts unfinished runs, does not replay misses, and arms only the next future target', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const missed = oneShot(store, cwd, 2_000);
  const repeating = interval(store, cwd, 300_000);
  const unfinished = store.beginRun(repeating.id, 20_000, true);
  const clock = fakeClock(901_000);
  const scheduler = new AutomationScheduler({
    store,
    execute: async () => assert.fail('startup must not replay missed work'),
    clock,
  });

  await scheduler.start();

  assert.equal(store.getDefinition(missed.id).nextFireAt, null);
  assert.equal(store.getDefinition(repeating.id).nextFireAt, 1_201_000);
  const interrupted = store.listRuns(repeating.id).find((run) => run.id === unfinished.id);
  assert.equal(interrupted.state, 'stopped');
  assert.equal(interrupted.stopReason, 'interrupted');
  assert.equal(clock.armed().delay, 300_000);
  await scheduler.stop();
});

test('executes a due definition once, records its result, and advances recurring cadence', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const created = interval(store, cwd, 300_000);
  const clock = fakeClock(301_000);
  const calls = [];
  const scheduler = new AutomationScheduler({
    store,
    execute: async (definition, run) => {
      calls.push({ definition: definition.id, run: run.id });
      return { sessionId: `pawwork-${run.id}`, result: 'checked' };
    },
    clock,
  });

  await scheduler.runDue();
  await scheduler.runDue();

  assert.deepEqual(calls, [{ definition: created.id, run: 'automation-run-1' }]);
  assert.equal(store.getDefinition(created.id).nextFireAt, 601_000);
  assert.equal(store.listRuns(created.id)[0].state, 'succeeded');
  assert.equal(store.listRuns(created.id)[0].result, 'checked');
});

test('conversation tools manage only the current workspace and keep model choice with the definition', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const runNow = [];
  const scheduler = {
    refresh() {},
    runNow: async (id) => {
      runNow.push(id);
      return { id: 'automation-run-1', state: 'succeeded' };
    },
  };
  const tools = createAutomationToolDefinitions({
    store,
    scheduler,
    cwd: () => cwd,
    model: () => ({ provider: 'opencode', model: 'deepseek-v4-flash-free' }),
    now: () => 1_000,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  const created = await byName.automation_create.execute({
    title: 'Daily brief',
    prompt: 'Write the brief.',
    at: '1970-01-01T00:00:02.000Z',
  });
  assert.equal(created.model.model, 'deepseek-v4-flash-free');
  assert.equal((await byName.automation_list.execute({})).items.length, 1);
  assert.equal((await byName.automation_set_paused.execute({ id: created.id, paused: true })).paused, true);
  assert.equal((await byName.automation_run_now.execute({ id: created.id })).state, 'succeeded');
  assert.deepEqual(runNow, [created.id]);
  assert.equal((await byName.automation_delete.execute({ id: created.id })).deleted, true);
  assert.equal((await byName.automation_list.execute({})).items.length, 0);
});

test('cron definitions keep their timezone and stop after the requested completed run count', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const created = store.createDefinition({
    kind: 'recurring',
    title: 'Weekday brief',
    prompt: 'Write the brief.',
    cwd,
    timezone: 'Asia/Shanghai',
    rhythm: { kind: 'cron', expression: '0 9 * * 1-5' },
    stop: { kind: 'count', count: 1 },
    model: { provider: 'opencode', model: 'big-pickle' },
  }, Date.parse('2026-08-18T00:30:00.000Z'));
  const clock = fakeClock(Date.parse('2026-08-18T01:00:00.000Z'));
  const scheduler = new AutomationScheduler({
    store,
    execute: async () => ({ sessionId: 'pawwork-automation-run-1', result: 'done' }),
    clock,
  });

  assert.equal(created.nextFireAt, Date.parse('2026-08-18T01:00:00.000Z'));
  await scheduler.runDue();

  assert.equal(store.listRuns(created.id)[0].state, 'succeeded');
  assert.equal(store.getDefinition(created.id).nextFireAt, null);
});

test('conversation create accepts cron and finite schedules', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const tools = createAutomationToolDefinitions({
    store,
    scheduler: { refresh() {} },
    cwd: () => cwd,
    model: () => ({ provider: 'opencode', model: 'big-pickle' }),
    now: () => Date.parse('2026-08-18T00:30:00.000Z'),
  });
  const create = tools.find((entry) => entry.name === 'automation_create');

  const definition = await create.execute({
    title: 'Weekday brief',
    prompt: 'Write the brief.',
    cron: '0 9 * * 1-5',
    timezone: 'Asia/Shanghai',
    run_count: 3,
  });

  assert.deepEqual(definition.rhythm, { kind: 'cron', expression: '0 9 * * 1-5' });
  assert.deepEqual(definition.stop, { kind: 'count', count: 3 });
  assert.equal(definition.timezone, 'Asia/Shanghai');
});

test('conversation update edits v1-manageable fields atomically without changing identity', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const tools = createAutomationToolDefinitions({
    store,
    scheduler: { refresh() {} },
    cwd: () => cwd,
    model: () => ({ provider: 'opencode', model: 'big-pickle' }),
    now: () => Date.parse('2026-08-18T00:30:00.000Z'),
  });
  const byName = Object.fromEntries(tools.map((entry) => [entry.name, entry]));
  const created = await byName.automation_create.execute({
    title: 'Daily brief',
    prompt: 'Write the brief.',
    cron: '0 9 * * *',
    timezone: 'UTC',
  });

  const updated = await byName.automation_update.execute({
    id: created.id,
    title: 'Weekday brief',
    prompt: 'Write a concise brief.',
    cron: '30 9 * * 1-5',
    timezone: 'Asia/Shanghai',
    run_count: 4,
    model: 'opencode/deepseek-v4-flash-free',
  });

  assert.equal(updated.id, created.id);
  assert.equal(updated.revision, 2);
  assert.equal(updated.title, 'Weekday brief');
  assert.deepEqual(updated.rhythm, { kind: 'cron', expression: '30 9 * * 1-5' });
  assert.deepEqual(updated.stop, { kind: 'count', count: 4 });
  assert.deepEqual(updated.model, { provider: 'opencode', model: 'deepseek-v4-flash-free' });
  assert.equal(updated.nextFireAt, Date.parse('2026-08-18T01:30:00.000Z'));

  await assert.rejects(
    () => byName.automation_update.execute({ id: created.id, at: '2026-08-19T09:00:00+08:00' }),
    /recurring automation/,
  );
  assert.deepEqual(store.getDefinition(created.id), updated);
});

test('continue automations bind immutably to the creating DSH session', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const tools = createAutomationToolDefinitions({
    store,
    scheduler: { refresh() {} },
    cwd: () => cwd,
    sessionId: () => 'session-existing',
    model: () => ({ provider: 'opencode', model: 'big-pickle' }),
    now: () => 1_000,
  });
  const create = tools.find((entry) => entry.name === 'automation_create');

  const definition = await create.execute({
    title: 'Conversation loop',
    prompt: 'Continue this conversation.',
    every_seconds: 300,
    continue_session: true,
  });

  assert.equal(definition.context, 'continue');
  assert.equal(definition.sourceSessionId, 'session-existing');
  assert.equal(Object.hasOwn(definition, 'automationSessionId'), false);
});

test('imports v1 history idempotently and activates all pending definitions in one takeover', () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const definition = {
    id: 'pawwork-v1-automation_source',
    title: 'Imported brief',
    prompt: 'Write the brief.',
    revision: 3,
    paused: true,
    context: 'fresh',
    cwd,
    model: { provider: 'opencode', model: 'big-pickle' },
    timezone: 'Asia/Shanghai',
    createdAt: 1_000,
    updatedAt: 2_000,
    kind: 'recurring',
    rhythm: { kind: 'cron', expression: '0 9 * * *' },
    stop: { kind: 'never' },
    nextFireAt: null,
    migration: { source: 'pawwork-v1', sourceId: 'automation_source', takeover: 'pending', warnings: [] },
  };
  const run = {
    id: 'pawwork-v1-automation_run_source',
    automationId: definition.id,
    definitionRevision: 2,
    triggeredAt: 1_500,
    startedAt: 1_600,
    completedAt: 1_900,
    state: 'succeeded',
    sessionId: 'pawwork-v1-ses_source',
    result: 'Done',
    error: null,
    stopReason: null,
    migration: { source: 'pawwork-v1', sourceId: 'automation_run_source', sourceState: 'succeeded' },
  };

  assert.equal(store.importDefinition(definition), 'imported');
  assert.equal(store.importDefinition(definition), 'skipped');
  assert.equal(store.importRun(run), 'imported');
  assert.equal(store.importRun(run), 'skipped');
  assert.equal(store.pendingV1Takeover().length, 1);

  const confirmed = store.confirmV1Takeover(Date.parse('2026-08-18T00:30:00.000Z'));
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].paused, false);
  assert.equal(confirmed[0].migration.takeover, 'confirmed');
  assert.equal(confirmed[0].nextFireAt, Date.parse('2026-08-18T01:00:00.000Z'));
  assert.equal(store.confirmV1Takeover(Date.parse('2026-08-18T00:31:00.000Z')).length, 0);
  assert.equal(store.listRuns(definition.id).length, 1);
});

test('imports orphaned v1 history without creating a schedulable definition', () => {
  const { file } = fixture();
  const store = new AutomationStore(file);
  const run = {
    id: 'pawwork-v1-run_orphan',
    automationId: 'pawwork-v1-definition_deleted',
    definitionRevision: 1,
    triggeredAt: 1_500,
    startedAt: 1_600,
    completedAt: 1_900,
    state: 'failed',
    sessionId: null,
    result: null,
    error: 'Unavailable',
    stopReason: null,
    migration: {
      source: 'pawwork-v1',
      sourceId: 'run_orphan',
      sourceState: 'failed',
      orphanedDefinition: true,
    },
  };

  assert.equal(store.importRun(run), 'imported');
  assert.equal(store.listRuns(run.automationId).length, 1);
  assert.throws(() => store.getDefinition(run.automationId), /automation not found/);
  assert.throws(
    () => store.importRun({ ...run, id: 'pawwork-v1-run_unmarked', migration: { ...run.migration, sourceId: 'run_unmarked', orphanedDefinition: false } }),
    /automation not found/,
  );
});
