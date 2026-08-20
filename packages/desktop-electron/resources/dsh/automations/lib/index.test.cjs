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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pawwork-automations-plugin-'));
  const originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const teardowns = [];
  const listeners = new Map();
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'opencode', model: 'big-pickle' }) },
    agents: { roots: () => overrides.roots ?? [] },
    connection: { rpc: { handle: () => async () => {} } },
    effect: (setup) => { teardowns.push(setup()); },
    logger: { warn: () => {} },
    on: (event, handler) => {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    provide: () => {},
  };
  try {
    const { apply } = await import(`${pathToFileURL(path.join(__dirname, 'index.js')).href}?t=${Date.now()}`);
    apply(ctx);
    return { ctx, home, emit: (event, payload) => listeners.get(event)?.(payload) };
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
