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
  MIN_INTERVAL_MS,
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
  const pluginUrl = `${pathToFileURL(path.join(__dirname, 'index.js')).href}?lifecycle=${Date.now()}`;
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

// Every other listRuns assertion runs against a store holding a single
// automation, where the automationId filter cannot be observed at all: drop it
// and they still pass. Two automations are what make the scoping visible, and
// the undefined case is the whole-history read the RPC layer relies on.
test('scopes run history to one automation and returns all of it when unscoped', () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const reports = oneShot(store, cwd, 2_000);
  const inbox = interval(store, cwd, 60_000);

  const first = store.beginRun(reports.id, 1_500);
  const second = store.beginRun(inbox.id, 1_600);
  const third = store.beginRun(reports.id, 1_700);

  assert.deepEqual(store.listRuns(reports.id).map((run) => run.id), [third.id, first.id]);
  assert.deepEqual(store.listRuns(inbox.id).map((run) => run.id), [second.id]);
  assert.deepEqual(store.listRuns().map((run) => run.id), [third.id, second.id, first.id]);
});

test('persists definitions and run history with monotonic ids', () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const created = oneShot(store, cwd, 2_000);
  const run = store.beginRun(created.id, 1_500);
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
  const unfinished = store.beginRun(repeating.id, 20_000);
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

// An automation turn still in flight when the sidecar quits is the case the
// abort loop exists for: without it stop() waits on a promise nothing will ever
// settle. This test is the only one that reaches that deadlock — the others
// abort runs that have already settled.
test('aborts a run still in flight when the scheduler stops', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const created = oneShot(store, cwd, 2_000);
  const clock = fakeClock(1_000);
  let observedSignal;
  let releaseRun;
  const scheduler = new AutomationScheduler({
    store,
    execute: (definition, run, signal) => {
      observedSignal = signal;
      // A hung agent turn: settles on abort, or when this test lets it go so a
      // failing run does not leave the whole file waiting on it.
      return new Promise((resolve, reject) => {
        releaseRun = () => reject(new Error('test released the run'));
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    clock,
  });

  const { run } = scheduler.startNow(created.id, 1_500);
  assert.equal(store.listRuns(created.id)[0].state, 'running');

  // Raced rather than awaited: without the abort loop stop() never returns, and
  // awaiting it would stall the whole file instead of failing this test.
  const outcome = await Promise.race([
    scheduler.stop().then(() => 'stopped'),
    new Promise((resolve) => setTimeout(() => resolve('still waiting on the run'), 2_000).unref()),
  ]);

  try {
    assert.equal(outcome, 'stopped');
    assert.equal(observedSignal.aborted, true);
    const stopped = store.listRuns(created.id).find((entry) => entry.id === run.id);
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.stopReason, 'cancelled');
  } finally {
    releaseRun();
  }
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

test('persists a due claim and its running record in one write', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const created = interval(store, cwd, 300_000);
  const clock = fakeClock(301_000);
  const scheduler = new AutomationScheduler({
    store,
    execute: async (_definition, _run, signal) => await new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ result: 'done' }), { once: true });
    }),
    clock,
  });

  await scheduler.runDue();

  const reopened = new AutomationStore(file);
  assert.equal(reopened.getDefinition(created.id).nextFireAt, 601_000);
  assert.equal(reopened.listRuns(created.id)[0].state, 'running');
  await scheduler.stop();
  assert.equal(store.listRuns(created.id)[0].state, 'stopped');
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

test('records executor failures as failed runs', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const created = oneShot(store, cwd, 2_000);
  const scheduler = new AutomationScheduler({
    store,
    execute: async () => { throw new Error('model unavailable'); },
    clock: fakeClock(1_500),
  });

  const completed = await scheduler.startNow(created.id).completion;

  assert.equal(completed.state, 'failed');
  assert.equal(completed.error, 'model unavailable');
});

test('a stopped scheduler rejects new immediate runs', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const created = oneShot(store, cwd, 2_000);
  const scheduler = new AutomationScheduler({
    store,
    execute: async () => ({ result: 'must not run' }),
    clock: fakeClock(1_500),
  });
  await scheduler.stop();

  assert.throws(() => scheduler.startNow(created.id), /scheduler is stopped/);
  assert.equal(store.listRuns(created.id).length, 0);
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
  const pluginUrl = `${pathToFileURL(path.join(__dirname, 'index.js')).href}?executor=${Date.now()}`;
  const { createDshExecutor } = await import(pluginUrl);
  let releaseIdle;
  const idle = new Promise((resolve) => { releaseIdle = resolve; });
  let cancellations = 0;
  const agent = {
    session: {
      snapshotEvents: () => [
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ],
    },
    followup() {},
    whenIdle: async () => await idle,
    runMaintenance: async (task) => task(new AbortController().signal),
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
    completion.then(() => 'resolved', () => 'rejected'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 20)),
  ]);

  assert.equal(outcome, 'rejected');
  assert.equal(cancellations, 1);
});

test('the DSH executor retries when maintenance admission races with new user work', async () => {
  const pluginUrl = `${pathToFileURL(path.join(__dirname, 'index.js')).href}?maintenance-race=${Date.now()}`;
  const { createDshExecutor } = await import(pluginUrl);
  const events = [
    { type: 'turn/start', data: { turn: 4 } },
    { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } },
  ];
  let idleCalls = 0;
  let maintenanceCalls = 0;
  const agent = {
    session: { snapshotEvents: () => events },
    followup() {
      events.push({ type: 'turn/start', data: { turn: 6 } });
      events.push({ type: 'assistant/message', data: { turn: 6, message: { content: [{ type: 'text', text: 'automation result' }] } } });
      events.push({ type: 'turn/end', data: { turn: 6, reason: { kind: 'completed' } } });
    },
    async whenIdle() {
      idleCalls += 1;
      if (idleCalls === 2) {
        events.push({ type: 'turn/start', data: { turn: 5 } });
        events.push({ type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } });
      }
    },
    runMaintenance(task) {
      maintenanceCalls += 1;
      if (maintenanceCalls === 1) throw new Error('agent is busy');
      return task(new AbortController().signal);
    },
    cancel() {},
  };
  const execute = createDshExecutor({
    agents: { get: () => agent },
    sessions: { flush: async () => {} },
    sessionTitle: { rename: () => {} },
  });

  const result = await execute({
    context: 'continue',
    sourceSessionId: 'session-existing',
    model: { provider: 'opencode', model: 'big-pickle' },
    prompt: 'Continue.',
  }, { id: 'automation-run-1' }, new AbortController().signal);

  assert.equal(result.result, 'automation result');
  assert.equal(maintenanceCalls, 2);
});

test('the DSH executor keeps a continue result inside its single turn', async () => {
  const pluginUrl = `${pathToFileURL(path.join(__dirname, 'index.js')).href}?single-turn=${Date.now()}`;
  const { createDshExecutor } = await import(pluginUrl);
  const events = [
    { type: 'turn/start', data: { turn: 4 } },
    { type: 'assistant/message', data: { turn: 4, message: { content: [{ type: 'text', text: 'old result' }] } } },
    { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } },
  ];
  let idleCalls = 0;
  let inMaintenance = false;
  const agent = {
    session: { snapshotEvents: () => events },
    followup() {
      assert.equal(inMaintenance, true);
      events.push({ type: 'turn/start', data: { turn: 5 } });
      events.push({ type: 'assistant/message', data: { turn: 5, message: { content: [{ type: 'text', text: 'automation result' }] } } });
      events.push({ type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } });
    },
    async whenIdle() {
      idleCalls += 1;
      if (idleCalls === 2) {
        events.push({ type: 'turn/start', data: { turn: 6 } });
        events.push({ type: 'assistant/message', data: { turn: 6, message: { content: [{ type: 'text', text: 'later user work' }] } } });
        events.push({ type: 'turn/end', data: { turn: 6, reason: { kind: 'completed' } } });
      }
    },
    runMaintenance: async (task) => {
      inMaintenance = true;
      try {
        return await task(new AbortController().signal);
      } finally {
        inMaintenance = false;
      }
    },
    cancel() {},
  };
  const execute = createDshExecutor({
    agents: { get: () => agent },
    sessions: { flush: async () => {} },
    sessionTitle: { rename: () => {} },
  });

  const result = await execute({
    context: 'continue',
    sourceSessionId: 'session-existing',
    model: { provider: 'opencode', model: 'big-pickle' },
    prompt: 'Continue.',
  }, { id: 'automation-run-1' }, new AbortController().signal);

  assert.equal(result.result, 'automation result');
});

test('the DSH executor does not follow up when agent creation or resume aborts after await', async () => {
  for (const method of ['create', 'resume']) {
    const pluginUrl = `${pathToFileURL(path.join(__dirname, 'index.js')).href}?abort-after-${method}=${Date.now()}`;
    const { createDshExecutor } = await import(pluginUrl);
    let resolveAgent;
    let followups = 0;
    const agent = {
      session: { snapshotEvents: () => [] },
      followup() { followups += 1; },
      whenIdle: async () => {},
      cancel() {},
      runMaintenance: async (task) => task(new AbortController().signal),
    };
    const ctx = {
      agents: {
        get: () => undefined,
        [method]: () => new Promise((resolve) => {
          resolveAgent = () => resolve({ agent, dispose: async () => {} });
        }),
      },
      sessions: { flush: async () => {} },
      sessionTitle: { rename: () => {} },
    };
    const execute = createDshExecutor(ctx);
    const controller = new AbortController();
    const completion = execute({
      context: method === 'resume' ? 'continue' : 'fresh',
      sourceSessionId: 'session-existing',
      model: { provider: 'opencode', model: 'big-pickle' },
      cwd: '/tmp',
      title: 'Automation',
      prompt: 'Continue.',
    }, { id: `automation-run-${method}` }, controller.signal);

    controller.abort();
    resolveAgent();
    await assert.rejects(completion, /aborted|AbortError/);
    assert.equal(followups, 0);
  }
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

test('automation RPC keeps the active run separate from bounded terminal history', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const created = interval(store, cwd, 30_000);
  const active = store.beginRun(created.id, 2_000);
  for (let index = 0; index < 6; index += 1) {
    store.recordStoppedRun(created.id, 3_000 + index, 'previous_run_active', 3_000 + index);
  }
  const rpc = createAutomationRpcHandler({ store, scheduler: {}, now: () => 10_000 });

  const response = await rpc('list', {});

  assert.equal(response.ok, true);
  assert.equal(response.value.definitions[0].activeRun.id, active.id);
  assert.equal(response.value.definitions[0].recentRuns.length, 5);
  assert.equal(response.value.definitions[0].recentRuns.every((run) => run.state !== 'running'), true);
});

// One dash stood for "finished", "ran out of runs" and "paused" alike, so the
// list could not say which. Paused it already states on its own; the other two
// are what this reason carries.
test('automation RPC says why a definition has no next run', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const rpc = createAutomationRpcHandler({ store, scheduler: {}, now: () => 10_000 });

  const live = interval(store, cwd, 300_000);
  const paused = interval(store, cwd, 300_000);
  store.setPaused(paused.id, true, 2_000);
  const finished = oneShot(store, cwd, 2_000);
  const finishedRun = store.claimDue(finished.id, 2_000, 2_000, { state: 'running', completedAt: null, stopReason: null });
  store.completeRun(finishedRun.run.id, { state: 'succeeded', completedAt: 2_100, sessionId: 'session-0', result: 'done' });
  const limited = store.createDefinition({
    kind: 'recurring',
    title: 'Twice only',
    prompt: 'Run twice.',
    cwd,
    rhythm: { kind: 'interval', everyMs: 300_000 },
    stop: { kind: 'count', count: 1 },
    model: { provider: 'opencode', model: 'big-pickle' },
  }, 1_000);
  const limitedRun = store.beginRun(limited.id, 1_200);
  store.completeRun(limitedRun.id, { state: 'succeeded', completedAt: 1_300, sessionId: 'session-1', result: 'done' });
  // Claiming a one-shot clears its next run before the attempt lands, so this one is
  // running, not finished.
  const running = oneShot(store, cwd, 3_000);
  store.claimDue(running.id, 3_000, 3_000, { state: 'running', completedAt: null, stopReason: null });
  // Resuming a one-shot after its moment drops its next run without ever attempting one.
  const missed = oneShot(store, cwd, 4_000);
  store.setPaused(missed.id, true, 3_500);
  store.setPaused(missed.id, false, 9_000);
  const response = await rpc('list', {});
  const reasonOf = (id) => response.value.definitions.find((entry) => entry.id === id).terminalReason;

  assert.equal(response.ok, true);
  assert.equal(reasonOf(live.id), null);
  assert.equal(reasonOf(paused.id), null);
  assert.equal(reasonOf(finished.id), 'completed');
  assert.equal(reasonOf(limited.id), 'run-limit');
  assert.equal(reasonOf(running.id), null);
  assert.equal(reasonOf(missed.id), 'missed');
});

// The reason above never has to describe a schedule that cannot resolve, because
// no write path accepts one. Said here so the guarantee survives a change to
// either side: a cron whose date never comes is refused where it is written.
test('every write path refuses a cron expression whose date never comes', () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  // February 30th: syntactically valid, never a real date.
  const input = {
    kind: 'recurring',
    title: 'Never resolves',
    prompt: 'Clean up.',
    cwd,
    rhythm: { kind: 'cron', expression: '0 9 30 2 *' },
    model: { provider: 'opencode', model: 'big-pickle' },
  };

  assert.throws(() => store.createDefinition(input, 1_000), /invalid cron expression/);

  const existing = interval(store, cwd, 300_000);
  assert.throws(
    () => store.updateDefinition(existing.id, { rhythm: input.rhythm }, 2_000),
    /invalid cron expression/,
  );
  assert.equal(store.getDefinition(existing.id).rhythm.kind, 'interval');

  assert.throws(() => store.importDefinition({
    id: 'pawwork-v1-automation_never',
    title: 'Never resolves',
    prompt: 'Clean up.',
    revision: 1,
    paused: false,
    context: 'fresh',
    cwd,
    model: { provider: 'opencode', model: 'big-pickle' },
    timezone: 'UTC',
    createdAt: 1_000,
    updatedAt: 1_000,
    kind: 'recurring',
    rhythm: input.rhythm,
    stop: { kind: 'never' },
    migration: { source: 'pawwork-v1', sourceId: 'automation_never', warnings: [] },
  }), /invalid cron expression/);
});

// The editor cannot repeat the cron rule without copying the parser, so it reads
// this issue to know it may say so in the user's language. Plain, the user met
// the store's own English sentence in a Chinese UI. The reason travels in
// `issues` rather than `code` because DSH validates `code` against its own enum
// and rejects the whole response for one it does not know.
test('a refused cron expression reaches the editor as an issue it can localize', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const definition = interval(store, cwd, 300_000);
  const rpc = createAutomationRpcHandler({ store, scheduler: { refresh: () => {} }, now: () => 10_000 });

  const response = await rpc('update', {
    id: definition.id,
    expectedRevision: definition.revision,
    rhythm: { kind: 'cron', expression: '0 9 30 2 *' },
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'bad-request');
  assert.deepEqual(response.error.details.issues, [{ code: 'invalid-cron' }]);
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

test('automation RPC updates definitions', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const definition = interval(store, cwd, 300_000);
  let refreshCalls = 0;
  const rpc = createAutomationRpcHandler({
    store,
    scheduler: { refresh: () => { refreshCalls += 1; } },
    now: () => Date.parse('2026-08-18T00:00:00.000Z'),
  });
  const updated = await rpc('update', {
    id: definition.id, expectedRevision: definition.revision,
    title: 'Morning brief', prompt: 'Summarize important changes.',
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.value.title, 'Morning brief');
  assert.equal(refreshCalls, 1);

  const stale = await rpc('update', {
    id: definition.id, expectedRevision: definition.revision, title: 'Stale title',
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'conflict');
  assert.equal(store.getDefinition(definition.id).title, 'Morning brief');
  assert.equal(refreshCalls, 1);
});

test('conversation tools manage only the current workspace and keep model choice with the definition', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const startedNow = [];
  const scheduler = {
    refresh() {},
    startNow: (id) => {
      startedNow.push(id);
      return { completion: Promise.resolve({ id: 'automation-run-1', state: 'succeeded' }) };
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
  assert.deepEqual(startedNow, [created.id]);
  assert.deepEqual(await byName.automation_delete.execute({ id: created.id }), { id: created.id });
  assert.throws(() => store.getDefinition(created.id), /automation not found/);
  await assert.rejects(() => byName.automation_delete.execute({ id: created.id }), /automation not found/);
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

// The Settings editor validates the interval before sending it, so the user gets
// a localized message instead of the backend's English one. It runs in the
// renderer and cannot require this module, so the two numbers are pinned
// together here — the one place that can see both.
test('the Settings editor rejects the same interval floor the store does', () => {
  const client = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
  const floors = [...client.matchAll(/everyMs < ([\d_]+)/g)].map((match) => Number(match[1].replaceAll('_', '')));

  assert.deepEqual(floors, [MIN_INTERVAL_MS]);
});

// claimDue is what makes two schedulers, or a runDue racing a startNow, unable
// to fire the same occurrence twice: the claim only succeeds while nextFireAt is
// still the target the caller read. Nothing exercised that, so the guard could
// have been dropped and every test would have passed.
test('claims a due occurrence exactly once', () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const definition = store.createDefinition({
    title: 'Brief',
    prompt: 'Write the brief.',
    cwd,
    model: { provider: 'opencode', model: 'big-pickle' },
    timezone: 'UTC',
    kind: 'recurring',
    rhythm: { kind: 'interval', everyMs: 60_000 },
  }, 1_000);
  const target = definition.nextFireAt;
  const now = target + 5;

  const claimed = store.claimDue(definition.id, target, now, { state: 'running' });
  assert.notEqual(claimed, null);
  // A second caller still holding the same target has lost the race.
  assert.equal(store.claimDue(definition.id, target, now, { state: 'running' }), null);
  // Not due yet, paused, and unknown all refuse too.
  assert.equal(store.claimDue(definition.id, store.getDefinition(definition.id).nextFireAt, now, { state: 'running' }), null);
  store.setPaused(definition.id, true, now);
  const paused = store.getDefinition(definition.id);
  assert.equal(store.claimDue(definition.id, paused.nextFireAt, now + 120_000, { state: 'running' }), null);
  assert.equal(store.claimDue('automation-missing', target, now, { state: 'running' }), null);

  assert.equal(store.listRuns(definition.id).length, 1);
});

// Neutering the store's rhythm rule left every test green: the tool layer catches
// its own arg shapes first, so nothing reached the store with a bad rhythm. The
// store is what the RPC client and the v1 importer talk to directly.
test('the store keeps one rhythm rule for creates, updates and imports', () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const base = {
    title: 'Brief',
    prompt: 'Write the brief.',
    cwd,
    model: { provider: 'opencode', model: 'big-pickle' },
    timezone: 'UTC',
    kind: 'recurring',
  };

  for (const rhythm of [
    { kind: 'interval', everyMs: 29_999 },
    { kind: 'interval', everyMs: 60_000.5 },
    { kind: 'cron', expression: '0 9 * *' },
    { kind: 'cron', expression: 42 },
    { kind: 'daily' },
    undefined,
  ]) {
    assert.throws(() => store.createDefinition({ ...base, rhythm }, 1_000), Error);
  }

  const created = store.createDefinition({ ...base, rhythm: { kind: 'interval', everyMs: 30_000 } }, 1_000);
  assert.throws(
    () => store.updateDefinition(created.id, { rhythm: { kind: 'interval', everyMs: 29_999 } }, 2_000),
    /everyMs must be an integer of at least 30000/,
  );
  assert.throws(
    () => store.importDefinition({
      ...base,
      id: 'pawwork-v1-automation_bad',
      revision: 1,
      context: 'fresh',
      createdAt: 1_000,
      updatedAt: 1_000,
      migration: { source: 'pawwork-v1', sourceId: 'automation_bad' },
      rhythm: { kind: 'cron', expression: 'not a cron' },
    }),
    /invalid cron expression: not a cron/,
  );
});

// The three schedule fields reach the store through one arg-shape rule each, and
// nothing asserted any of them: a create that took a bad value and an update that
// refused a good one would both have stayed green.
// The store hands the run record back to the scheduler, which reports it, and
// writes it to the file the next launch reads. A rejected outcome used to leave
// those three disagreeing: completed in memory, running on disk, and an error
// the caller could not act on.
test('a rejected completion leaves the run untouched in memory and on disk', () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const created = oneShot(store, cwd, 2_000);
  const run = store.beginRun(created.id, 1_500);

  assert.throws(
    () => store.completeRun(run.id, { state: 'failed', completedAt: 2_000, error: '' }),
    /error must be a non-empty string/,
  );

  assert.equal(store.listRuns(created.id)[0].state, 'running');
  assert.equal(new AutomationStore(file).listRuns(created.id)[0].state, 'running');

  // And the same record still completes once the outcome is well formed.
  const completed = store.completeRun(run.id, { state: 'failed', completedAt: 2_000, error: 'model unavailable' });
  assert.equal(completed.state, 'failed');
  assert.equal(new AutomationStore(file).listRuns(created.id)[0].error, 'model unavailable');
});

test('a failed persistence leaves Automation memory at the last durable document', () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const created = oneShot(store, cwd, 2_000);
  store.file = path.join(file, 'cannot-be-created');

  assert.throws(() => store.setPaused(created.id, true, 1_500));
  assert.equal(store.getDefinition(created.id).paused, false);
  assert.equal(store.getDefinition(created.id).revision, 1);
});

// A fresh run gets its own session and never sees these tools. A continue-mode
// run appends to the session that created it, where they are registered for the
// user — so the run, not the session, is what has to be excluded. Without this
// a scheduled turn could bind another automation to the same session, on every
// firing, unattended.
// Every mutation lands through one writer, and the file holds the user's
// prompts. Nothing asserted either property: replacing the write with an
// in-place fs.writeFileSync at the default mode kept the whole suite green.
// Windows has no POSIX mode bits — the mode passed to writeFileSync is ignored
// there and stat reports 0o666 — so only the rename half is checkable on it.
function assertOwnerOnly(file) {
  if (process.platform === 'win32') return;
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
}

test('persists through a temporary file the reader never sees, owner-readable only', () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  oneShot(store, cwd, 2_000);

  assertOwnerOnly(file);
  assert.equal(fs.existsSync(`${file}.next`), false);

  // A crash between two saves leaves the previous document intact, never a
  // partial one: the reader's path is only ever replaced by rename.
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(before).definitions.length, 1);
  oneShot(store, cwd, 3_000);
  assertOwnerOnly(file);
  assert.equal(fs.existsSync(`${file}.next`), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).definitions.length, 2);
});

test('conversation tools refuse to run inside a continue-mode automation turn', async () => {
  const { file, cwd } = fixture();
  const store = new AutomationStore(file);
  const scheduler = new AutomationScheduler({ store, execute: async () => ({ result: 'done' }), clock: fakeClock(1_000) });
  const tools = createAutomationToolDefinitions({
    store,
    scheduler,
    cwd: () => cwd,
    sessionId: () => 'session-user-1',
    model: () => ({ provider: 'opencode', model: 'big-pickle' }),
    now: () => 1_000,
  });
  const byName = Object.fromEntries(tools.map((entry) => [entry.name, entry]));

  const created = await byName.automation_create.execute({
    title: 'Digest', prompt: 'Write the digest.', timezone: 'UTC', every_seconds: 60, continue_session: true,
  });
  assert.equal(created.context, 'continue');
  assert.equal(created.sourceSessionId, 'session-user-1');

  // Nothing is running yet, so the same session still manages automations.
  assert.equal((await byName.automation_list.execute({})).items.length, 1);

  store.beginRun(created.id, 2_000);
  for (const name of Object.keys(byName)) {
    await assert.rejects(
      () => byName[name].execute({ id: created.id, title: 'Digest', prompt: 'Write it.', timezone: 'UTC', every_seconds: 60 }),
      /automations cannot be managed from inside an automation run/,
      name,
    );
  }

  // A different conversation is unaffected while that run is in flight.
  const other = createAutomationToolDefinitions({
    store, scheduler, cwd: () => cwd, sessionId: () => 'session-user-2',
    model: () => ({ provider: 'opencode', model: 'big-pickle' }), now: () => 1_000,
  });
  const otherByName = Object.fromEntries(other.map((entry) => [entry.name, entry]));
  assert.equal((await otherByName.automation_list.execute({})).items.length, 1);
});

test('conversation tools apply one schedule arg rule to create and update alike', async () => {
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
  const base = { title: 'Brief', prompt: 'Write the brief.', timezone: 'UTC' };

  await assert.rejects(
    () => byName.automation_create.execute({ ...base, at: '2026-08-19T09:00:00' }),
    /at must be an RFC 3339 timestamp with an explicit offset/,
  );
  await assert.rejects(
    () => byName.automation_create.execute({ ...base, at: '2026-13-40T09:00:00Z' }),
    /at must be a valid timestamp/,
  );
  await assert.rejects(
    () => byName.automation_create.execute({ ...base, every_seconds: 29 }),
    /every_seconds must be an integer of at least 30/,
  );
  await assert.rejects(
    () => byName.automation_create.execute({ ...base, cron: '0 9 * *' }),
    /cron must be a valid five-field cron expression/,
  );
  await assert.rejects(
    () => byName.automation_create.execute({ ...base, every_seconds: 60, run_count: 1.5 }),
    /run_count must be a non-negative integer/,
  );
  await assert.rejects(
    () => byName.automation_create.execute({ ...base, at: '2026-08-19T09:00:00Z', run_count: 2 }),
    /run_count is only supported for recurring automations/,
  );
  // A model filling an optional numeric field with null is ordinary. Reading it
  // as absent let create accept what update rejects, for the same argument.
  await assert.rejects(
    () => byName.automation_create.execute({ ...base, every_seconds: 60, run_count: null }),
    /run_count must be a non-negative integer/,
  );

  const recurring = await byName.automation_create.execute({ ...base, every_seconds: 30 });
  assert.deepEqual(recurring.rhythm, { kind: 'interval', everyMs: 30_000 });
  assert.deepEqual(recurring.stop, { kind: 'never' });

  await assert.rejects(
    () => byName.automation_update.execute({ id: recurring.id, every_seconds: 29 }),
    /every_seconds must be an integer of at least 30/,
  );
  await assert.rejects(
    () => byName.automation_update.execute({ id: recurring.id, cron: '0 9 * *' }),
    /cron must be a valid five-field cron expression/,
  );
  await assert.rejects(
    () => byName.automation_update.execute({ id: recurring.id, run_count: -1 }),
    /run_count must be a non-negative integer/,
  );

  const cleared = await byName.automation_update.execute({ id: recurring.id, run_count: 0 });
  assert.deepEqual(cleared.stop, { kind: 'never' });

  const oneshot = await byName.automation_create.execute({ ...base, at: '2026-08-19T09:00:00+08:00' });
  await assert.rejects(
    () => byName.automation_update.execute({ id: oneshot.id, at: '2026-08-19T09:00:00' }),
    /at must be an RFC 3339 timestamp with an explicit offset/,
  );
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
