'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { AutomationStore, automationRunSessionId } = require('./automations.cjs');

// The automation tools are registered per agent by an agent/created listener, and
// two of that listener's guards have no other expression anywhere: an automation's
// own run session must not be handed the tools that create automations, and a
// registered tool must refuse an execution routed from a different agent. Both are
// only reachable through apply(), so drive the plugin the way DSH does.
async function applyPlugin(overrides = {}) {
  const home = overrides.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pawwork-automations-plugin-'));
  const originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const teardowns = [];
  const listeners = new Map();
  let rpc;
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'opencode', model: 'big-pickle' }) },
    agents: { roots: () => overrides.roots ?? [], get: () => undefined, ...overrides.agents },
    connection: { rpc: { handle: (_endpoint, handler) => { rpc = handler; return async () => {}; } } },
    effect: (setup) => { teardowns.push(setup()); },
    llm: overrides.llm,
    logger: { warn: () => {} },
    on: (event, handler) => {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    provide: () => {},
    sessions: { flush: async () => {} },
    sessionTitle: { rename: () => {} },
  };
  try {
    const { apply } = await import(`${pathToFileURL(path.join(__dirname, 'index.js')).href}?t=${Date.now()}`);
    apply(ctx);
    return {
      ctx,
      home,
      emit: (event, payload) => listeners.get(event)?.(payload),
      rpc: (endpoint, payload) => rpc(endpoint, payload),
      dispose: async () => { for (const teardown of teardowns.reverse()) await teardown?.(); },
    };
  } finally {
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
  }
}

function fakeAgent(id) {
  const registered = [];
  return {
    id,
    options: {},
    session: { header: { cwd: '/workspace' } },
    ctx: {
      effect: (setup) => { setup(); },
      tools: { register: (definition) => { registered.push(definition); return () => {}; } },
    },
    registered,
  };
}

test('gives a root agent the automation tools', async () => {
  const agent = fakeAgent('agent-1');
  const { emit } = await applyPlugin({ roots: [agent] });

  emit('agent/created', { agent });

  assert.deepEqual(agent.registered.map((definition) => definition.name).sort(), [
    'automation_create',
    'automation_delete',
    'automation_list',
    'automation_run_now',
    'automation_set_paused',
    'automation_update',
  ]);
});

test('withholds the automation tools from an automation run session', async () => {
  // Named from a real run record rather than a literal: the executor and this
  // exclusion derive the session id from the same rule, so a change to the
  // run-id format has to break here instead of silently re-arming the tools.
  const store = new AutomationStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pawwork-run-id-')), 'automations.json'));
  const definition = store.createDefinition({
    title: 'Brief',
    prompt: 'Write the brief.',
    cwd: '/workspace',
    model: { provider: 'opencode', model: 'big-pickle' },
    timezone: 'UTC',
    kind: 'recurring',
    rhythm: { kind: 'interval', everyMs: 60_000 },
  }, 1_000);
  const run = store.createRunRecord(definition.id, 2_000);
  const agent = fakeAgent(automationRunSessionId(run.id));
  const { emit } = await applyPlugin({ roots: [agent] });

  emit('agent/created', { agent });

  assert.deepEqual(agent.registered, []);
});

test('withholds the automation tools from a non-root agent', async () => {
  const agent = fakeAgent('subagent-1');
  const { emit } = await applyPlugin({ roots: [] });

  emit('agent/created', { agent });

  assert.deepEqual(agent.registered, []);
});

// The adapter is asked directly whether it can serve the pair. UNKNOWN_MODEL moves the run to
// the default model, and so does NO_ADAPTER once adapters are registered; a lookup that fails
// for any other reason, an empty adapter table, or an abort all leave the definition's choice
// in place, as does a default model that is itself unknown.
test('moves a run to the default model only on a verdict from the adapter table', async () => {
  const { createModelCheck, resolveRunModel } = await import(`${pathToFileURL(path.join(__dirname, 'index.js')).href}?resolve=${Date.now()}`);
  const unknown = (model) => Object.assign(new Error(`no configured model ${model}`), { code: 'UNKNOWN_MODEL' });
  const noAdapter = Object.assign(new Error('no adapter registered'), { code: 'NO_ADAPTER' });
  const answers = {
    'opencode/mimo-v2.5-free': null,
    'opencode/big-pickle': null,
    'opencode/deepseek-v4-flash-free': unknown('deepseek-v4-flash-free'),
    'opencode/other-gone': unknown('other-gone'),
    'anthropic/claude': noAdapter,
    'custom/anything': new Error('catalog offline'),
  };
  let providers = [{ id: 'opencode' }, { id: 'opencode-responses' }];
  let defaultModel = { provider: 'opencode', model: 'big-pickle' };
  const ctx = {
    llm: {
      listProviders: () => providers,
      resolveModelInfo: async (provider, model) => {
        const failure = answers[`${provider}/${model}`];
        if (failure) throw failure;
        return { provider, id: model, name: model };
      },
    },
    agentDefaultModel: { currentSelection: () => defaultModel },
  };
  const moved = (provider, model) => ({ requested: { provider, model }, used: { provider: 'opencode', model: 'big-pickle' } });

  assert.equal(await resolveRunModel(ctx, { provider: 'opencode', model: 'mimo-v2.5-free' }), null);
  assert.deepEqual(await resolveRunModel(ctx, { provider: 'opencode', model: 'deepseek-v4-flash-free' }), moved('opencode', 'deepseek-v4-flash-free'));
  assert.deepEqual(await resolveRunModel(ctx, { provider: 'anthropic', model: 'claude' }), moved('anthropic', 'claude'));
  assert.equal(await resolveRunModel(ctx, { provider: 'custom', model: 'anything' }), null);
  assert.equal(await resolveRunModel(ctx, { provider: 'opencode', model: 'big-pickle' }), null);
  providers = [];
  assert.equal(await resolveRunModel(ctx, { provider: 'anthropic', model: 'claude' }), null);
  providers = [{ id: 'opencode' }];
  defaultModel = { provider: 'opencode', model: 'other-gone' };
  assert.equal(await resolveRunModel(ctx, { provider: 'opencode', model: 'deepseek-v4-flash-free' }), null);
  defaultModel = { provider: 'opencode', model: 'big-pickle' };

  // Writers apply the same verdict and refuse instead of substituting.
  const checkModel = createModelCheck(ctx);
  await checkModel({ provider: 'opencode', model: 'mimo-v2.5-free' });
  await checkModel({ provider: 'custom', model: 'anything' });
  for (const model of [{ provider: 'opencode', model: 'deepseek-v4-flash-free' }, { provider: 'anthropic', model: 'claude' }]) {
    await assert.rejects(checkModel(model), (error) => error.code === 'unknown-model' && error.message === `model ${model.provider}/${model.model} is not available`);
  }
});

test('records the model a run was moved to before the agent exists, and does not create one after an abort', async () => {
  const { createDshExecutor } = await import(`${pathToFileURL(path.join(__dirname, 'index.js')).href}?fallback=${Date.now()}`);
  const requested = { provider: 'opencode', model: 'deepseek-v4-flash-free' };
  const recorded = [];
  const warnings = [];
  let recordFailure = null;
  const store = {
    recordRunModel: (id, modelFallback) => {
      if (recordFailure) throw recordFailure;
      recorded.push({ id, modelFallback });
    },
  };
  let releaseLookup;
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'opencode' }],
      // The requested pair is answered on release; the default model resolves at once.
      resolveModelInfo: (provider, model) => new Promise((resolve, reject) => {
        if (model !== 'deepseek-v4-flash-free') return resolve({ provider, id: model, name: model });
        releaseLookup = () => reject(Object.assign(new Error('no configured model'), { code: 'UNKNOWN_MODEL' }));
      }),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'opencode', model: 'big-pickle' }) },
    logger: { warn: (message) => warnings.push(message) },
  };

  const created = [];
  let createFailure = null;
  const events = [];
  let turn = 0;
  const agent = {
    session: { snapshotEvents: () => events },
    followup() {
      turn += 1;
      events.push(
        { type: 'turn/start', data: { turn } },
        { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text: 'ran' }] } } },
        { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
      );
    },
    whenIdle: async () => {},
    cancel() {},
    runMaintenance: async (task) => task(new AbortController().signal),
  };
  const execute = createDshExecutor({
    ...ctx,
    agents: {
      get: () => undefined,
      create: async ({ agentOptions }) => {
        if (createFailure) throw createFailure;
        created.push(agentOptions);
        return { agent, dispose: async () => {} };
      },
    },
    sessions: { flush: async () => {} },
    sessionTitle: { rename: () => {} },
  }, store);
  const definition = { context: 'fresh', cwd: '/tmp', title: 'Digest', prompt: 'Go.', model: requested };

  const completion = execute(definition, { id: 'automation-run-1' }, new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(recorded, []);
  releaseLookup();
  const output = await completion;

  assert.deepEqual(recorded, [{ id: 'automation-run-1', modelFallback: { requested, used: { provider: 'opencode', model: 'big-pickle' } } }]);
  assert.deepEqual(created, [{ provider: 'opencode', model: 'big-pickle' }]);
  assert.equal(output.result, 'ran');

  const controller = new AbortController();
  const aborted = execute(definition, { id: 'automation-run-2' }, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  releaseLookup();
  await assert.rejects(aborted, /aborted|AbortError/);
  assert.equal(created.length, 1);
  assert.equal(recorded.length, 1);

  // The record exists before the agent does, so a run that never gets one still says which
  // model it was meant to start on.
  createFailure = new Error('agent quota exhausted');
  const failed = execute(definition, { id: 'automation-run-3' }, new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  releaseLookup();
  await assert.rejects(failed, /agent quota exhausted/);
  assert.equal(recorded.at(-1).id, 'automation-run-3');
  createFailure = null;

  // Bookkeeping that cannot be written does not stop the run.
  recordFailure = new Error('ENOSPC: no space left on device');
  const unrecorded = execute(definition, { id: 'automation-run-4' }, new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  releaseLookup();
  assert.equal((await unrecorded).result, 'ran');
  assert.equal(created.length, 2);
  assert.match(warnings.at(-1), /automation-run-4 could not record its model: ENOSPC/);
});

// Every other test stubs the seam between the executor and the store. This one drives the
// plugin's own wiring: a Settings "run now" on a definition whose model the adapter rejects
// must leave the substitution in automations.json on disk.
test('the plugin as wired writes the substituted model into the run record on disk', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawwork-wired-'));
  const definition = new AutomationStore(path.join(home, 'automations.json')).createDefinition({
    kind: 'oneshot', title: 'Digest', prompt: 'Go.', cwd: '/workspace', fireAt: Date.now() + 86_400_000,
    model: { provider: 'opencode', model: 'deepseek-v4-flash-free' },
  }, Date.now());
  const events = [];
  const agent = {
    session: { snapshotEvents: () => events },
    followup() {
      events.push(
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'ran' }] } } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      );
    },
    whenIdle: async () => {},
    cancel() {},
    runMaintenance: async (task) => task(new AbortController().signal),
  };
  const plugin = await applyPlugin({
    home,
    llm: {
      listProviders: () => [{ id: 'opencode' }],
      resolveModelInfo: async (provider, model) => {
        if (model === 'deepseek-v4-flash-free') throw Object.assign(new Error('no configured model'), { code: 'UNKNOWN_MODEL' });
        return { provider, id: model, name: model };
      },
    },
    agents: { create: async () => ({ agent, dispose: async () => {} }) },
  });
  try {
    const started = await plugin.rpc('run-now', { id: definition.id });
    assert.equal(started.ok, true);
    let run;
    for (let attempt = 0; attempt < 50 && run?.state !== 'succeeded'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      run = JSON.parse(fs.readFileSync(path.join(plugin.home, 'automations.json'), 'utf8')).runs.find((entry) => entry.id === started.value.id);
    }
    assert.equal(run.state, 'succeeded');
    assert.deepEqual(run.modelFallback, {
      requested: { provider: 'opencode', model: 'deepseek-v4-flash-free' },
      used: { provider: 'opencode', model: 'big-pickle' },
    });
  } finally {
    await plugin.dispose();
  }
});

test('refuses a tool execution routed from another agent', async () => {
  const owner = fakeAgent('agent-owner');
  const { emit } = await applyPlugin({ roots: [owner] });

  emit('agent/created', { agent: owner });
  const list = owner.registered.find((definition) => definition.name === 'automation_list');

  await assert.rejects(
    list.execute({}, { agent: fakeAgent('agent-other') }),
    /automation tool owner mismatch/,
  );
  assert.deepEqual(await list.execute({}, { agent: owner }), { items: [] });
});
