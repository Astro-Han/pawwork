'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  AutomationScheduler,
  AutomationStore,
  createAutomationRpcHandler,
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

test('registers and disposes the loopback management RPC with the scheduler lifecycle', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawwork-automations-plugin-'));
  const pluginUrl = `${pathToFileURL(path.join(__dirname, 'index.mjs')).href}?lifecycle=${Date.now()}`;
  const { apply } = await import(pluginUrl);
  const previousHome = process.env.DSH_HOME;
  let registration;
  let rpcStopped = false;
  let listenerStopped = false;
  let dispose;
  process.env.DSH_HOME = home;
  try {
    apply({
      agents: { roots: () => [] },
      connection: {
        rpc: {
          handle: (channel, _handler, options) => {
            registration = { channel, options };
            return async () => { rpcStopped = true; };
          },
        },
      },
      effect: (setup) => { dispose = setup(); },
      logger: { warn: () => {} },
      on: () => () => { listenerStopped = true; },
      provide: () => {},
    });

    assert.deepEqual(registration, {
      channel: '/pawwork-automations',
      options: { authority: 'loopback' },
    });
    await dispose();
    assert.equal(rpcStopped, true);
    assert.equal(listenerStopped, true);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(home, { force: true, recursive: true });
  }
});

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

test('rearms future work without waiting for a due run to finish', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const first = oneShot(store, cwd, 2_000);
  const second = oneShot(store, cwd, 3_000);
  const clock = fakeClock(1_000);
  let finishFirst;
  const firstCompletion = new Promise((resolve) => { finishFirst = resolve; });
  const started = [];
  const scheduler = new AutomationScheduler({
    store,
    execute: async (definition) => {
      started.push(definition.id);
      return definition.id === first.id
        ? firstCompletion
        : { sessionId: 'pawwork-automation-run-2', result: 'done' };
    },
    clock,
  });

  await scheduler.start();
  const firstTimer = clock.armed();
  clock.setNow(2_000);
  firstTimer.callback();
  await Promise.resolve();
  await Promise.resolve();

  assert.notEqual(clock.armed(), firstTimer);
  assert.equal(clock.armed().delay, 1_000);
  const secondTimer = clock.armed();
  clock.setNow(3_000);
  secondTimer.callback();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(started, [first.id, second.id]);

  finishFirst({ sessionId: 'pawwork-automation-run-1', result: 'done' });
  await scheduler.stop();
});

test('starts an immediate run without making the caller wait for agent completion', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const created = oneShot(store, cwd, 2_000);
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const scheduler = new AutomationScheduler({
    store,
    execute: async () => completed,
    clock: fakeClock(1_500),
  });

  const started = scheduler.startNow(created.id);

  assert.equal(started.run.state, 'running');
  assert.equal(store.listRuns(created.id)[0].state, 'running');
  finish({ sessionId: 'pawwork-automation-run-1', result: 'done' });
  assert.equal((await started.completion).state, 'succeeded');
});

test('records executor failures as failed runs', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const created = oneShot(store, cwd, 2_000);
  const scheduler = new AutomationScheduler({
    store,
    execute: async () => { throw new Error('model unavailable'); },
    clock: fakeClock(1_500),
  });

  const completed = await scheduler.runNow(created.id);

  assert.equal(completed.state, 'failed');
  assert.equal(completed.error, 'model unavailable');
});

test('stopping aborts an active run and records it as stopped', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const created = oneShot(store, cwd, 2_000);
  const scheduler = new AutomationScheduler({
    store,
    execute: async (_definition, _run, signal) => await new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ result: 'late success' }), { once: true });
    }),
    clock: fakeClock(1_500),
  });

  scheduler.startNow(created.id);
  await scheduler.stop();

  const completed = store.listRuns(created.id)[0];
  assert.equal(completed.state, 'stopped');
  assert.equal(completed.stopReason, 'cancelled');
});

test('rejects a second trigger while the previous run is active', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const created = oneShot(store, cwd, 2_000);
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  let executions = 0;
  const scheduler = new AutomationScheduler({
    store,
    execute: async () => { executions += 1; return await pending; },
    clock: fakeClock(1_500),
  });

  const first = scheduler.startNow(created.id);
  const rejected = scheduler.startNow(created.id);

  assert.equal(executions, 1);
  assert.equal(rejected.run.state, 'stopped');
  assert.equal(rejected.run.stopReason, 'previous_run_active');
  finish({ result: 'done' });
  await first.completion;
});

test('the DSH executor cancels an already attached continue agent', async () => {
  const pluginUrl = `${pathToFileURL(path.join(__dirname, 'index.mjs')).href}?executor=${Date.now()}`;
  const { createDshExecutor } = await import(pluginUrl);
  let releaseIdle;
  const idle = new Promise((resolve) => { releaseIdle = resolve; });
  let cancellations = 0;
  const agent = {
    session: {
      events: [
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ],
    },
    followup() {},
    whenIdle: async () => await idle,
    cancel() {
      cancellations += 1;
      releaseIdle();
    },
  };
  const execute = createDshExecutor({
    agents: {
      get: () => agent,
      create: async () => assert.fail('continue execution must reuse the attached agent'),
      resume: async () => assert.fail('continue execution must reuse the attached agent'),
    },
    sessions: { flush: async () => {} },
    sessionTitle: { rename: () => {} },
  });
  const controller = new AbortController();

  const completion = execute({
    context: 'continue',
    sourceSessionId: 'session-existing',
    model: { provider: 'opencode', model: 'big-pickle' },
    prompt: 'Continue.',
  }, { id: 'automation-run-1' }, controller.signal);
  controller.abort();
  const outcome = await Promise.race([
    completion.then(() => 'completed'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 20)),
  ]);

  assert.equal(outcome, 'completed');
  assert.equal(cancellations, 1);
});

test('automation RPC lists only durable definitions and their recent runs', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const definition = oneShot(store, cwd, 2_000);
  const run = store.beginRun(definition.id, 1_200);
  store.completeRun(run.id, {
    state: 'succeeded',
    completedAt: 1_300,
    sessionId: 'session-current',
    result: 'done',
  });
  store.importRun({
    id: 'pawwork-v1-run-orphan',
    automationId: 'pawwork-v1-definition-deleted',
    definitionRevision: 1,
    triggeredAt: 900,
    startedAt: 910,
    completedAt: 950,
    state: 'failed',
    sessionId: 'pawwork-v1-session-orphan',
    result: null,
    error: 'Unavailable',
    stopReason: null,
    migration: {
      source: 'pawwork-v1',
      sourceId: 'run-orphan',
      sourceState: 'failed',
      orphanedDefinition: true,
    },
  });
  const rpc = createAutomationRpcHandler({
    store,
    scheduler: { refresh() {} },
    now: () => 1_500,
  });

  const result = await rpc('list', {}, new AbortController().signal);

  assert.equal(result.ok, true);
  assert.equal(result.value.definitions[0].id, definition.id);
  assert.equal(result.value.definitions[0].recentRuns[0].sessionId, 'session-current');
  assert.deepEqual(Object.keys(result.value), ['definitions']);
});

test('automation RPC validates mutations and returns immediately when running now', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const definition = interval(store, cwd, 300_000);
  let refreshCalls = 0;
  let started;
  const rpc = createAutomationRpcHandler({
    store,
    scheduler: {
      refresh: () => { refreshCalls += 1; },
      startNow: (id) => {
        started = id;
        return { run: { id: 'automation-run-now', automationId: id, state: 'running' }, completion: new Promise(() => {}) };
      },
    },
    now: () => 2_000,
  });

  const badPause = await rpc('set-paused', { id: definition.id, paused: 'yes' }, new AbortController().signal);
  assert.equal(badPause.ok, false);
  assert.equal(badPause.error.code, 'bad-request');

  const paused = await rpc('set-paused', { id: definition.id, paused: true }, new AbortController().signal);
  assert.equal(paused.ok, true);
  assert.equal(paused.value.paused, true);

  const running = await rpc('run-now', { id: definition.id }, new AbortController().signal);
  assert.equal(running.ok, true);
  assert.equal(running.value.state, 'running');
  assert.equal(started, definition.id);
  assert.equal(refreshCalls, 1);
});

test('automation RPC updates definitions and rejects retired form-creation endpoints', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const definition = interval(store, cwd, 300_000);
  let refreshCalls = 0;
  const rpc = createAutomationRpcHandler({
    store,
    scheduler: { refresh: () => { refreshCalls += 1; } },
    now: () => Date.parse('2026-08-18T00:00:00.000Z'),
  });
  const retiredCreate = await rpc('create', {
    title: 'Daily brief', prompt: 'Summarize the workspace.', cwd: '/tmp/work',
    model: { provider: 'opencode', model: 'free-model' }, timezone: 'Asia/Shanghai',
    context: 'fresh', kind: 'recurring', rhythm: { kind: 'cron', expression: '0 9 * * *' },
    stop: { kind: 'count', count: 1 },
  });
  assert.equal(retiredCreate.ok, false);
  assert.equal(retiredCreate.error.code, 'bad-request');
  const retiredDefaults = await rpc('defaults', {});
  assert.equal(retiredDefaults.ok, false);
  assert.equal(retiredDefaults.error.code, 'bad-request');

  const updated = await rpc('update', {
    id: definition.id, title: 'Morning brief', prompt: 'Summarize important changes.',
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.value.title, 'Morning brief');
  assert.equal(refreshCalls, 1);
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

test('imports v1 definitions and history idempotently before scheduling them', () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const definition = {
    id: 'pawwork-v1-automation_source',
    title: 'Imported brief',
    prompt: 'Write the brief.',
    revision: 3,
    paused: false,
    context: 'fresh',
    cwd,
    model: { provider: 'opencode', model: 'big-pickle' },
    timezone: 'Asia/Shanghai',
    createdAt: 1_000,
    updatedAt: 2_000,
    kind: 'recurring',
    rhythm: { kind: 'cron', expression: '0 9 * * *' },
    stop: { kind: 'count', count: 2 },
    migration: { source: 'pawwork-v1', sourceId: 'automation_source', warnings: [] },
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
  assert.equal(store.getDefinition(definition.id).nextFireAt, null);
  store.activateImportedDefinitions(Date.parse('2026-08-18T00:00:00.000Z'));
  store.activateImportedDefinitions(Date.parse('2026-08-18T00:30:00.000Z'));
  assert.equal(store.getDefinition(definition.id).paused, false);
  assert.equal(store.getDefinition(definition.id).nextFireAt, Date.parse('2026-08-18T01:00:00.000Z'));
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
