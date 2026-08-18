'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MIN_INTERVAL_MS = 30_000;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function assertTimestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function recurringNext(createdAt, everyMs, after) {
  const elapsed = Math.max(0, after - createdAt);
  return createdAt + (Math.floor(elapsed / everyMs) + 1) * everyMs;
}

function definitionNext(definition, after) {
  if (definition.paused) return null;
  if (definition.kind === 'oneshot') return definition.fireAt > after ? definition.fireAt : null;
  return recurringNext(definition.createdAt, definition.rhythm.everyMs, after);
}

function initialDocument() {
  return {
    schema: 1,
    nextDefinition: 1,
    nextRun: 1,
    definitions: [],
    runs: [],
  };
}

function writeJsonAtomically(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.next`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

class AutomationStore {
  constructor(file) {
    if (!path.isAbsolute(file)) throw new Error('automation store path must be absolute');
    this.file = file;
    this.document = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : initialDocument();
    if (this.document.schema !== 1) {
      throw new Error(`unsupported automation store schema: ${this.document.schema}`);
    }
    if (!Array.isArray(this.document.definitions) || !Array.isArray(this.document.runs)) {
      throw new Error('invalid automation store document');
    }
  }

  save() {
    writeJsonAtomically(this.file, this.document);
  }

  createDefinition(input, now = Date.now()) {
    const createdAt = assertTimestamp(now, 'now');
    const title = assertText(input?.title, 'title');
    const prompt = assertText(input?.prompt, 'prompt');
    const cwd = assertText(input?.cwd, 'cwd');
    if (!path.isAbsolute(cwd)) throw new Error('cwd must be absolute');
    const provider = assertText(input?.model?.provider, 'model.provider');
    const model = assertText(input?.model?.model, 'model.model');
    const common = {
      id: `automation-${this.document.nextDefinition++}`,
      title,
      prompt,
      revision: 1,
      paused: false,
      context: 'fresh',
      cwd,
      model: { provider, model },
      createdAt,
      updatedAt: createdAt,
    };
    let definition;
    if (input.kind === 'oneshot') {
      const fireAt = assertTimestamp(input.fireAt, 'fireAt');
      if (fireAt <= createdAt) throw new Error('fireAt must be in the future');
      definition = { ...common, kind: 'oneshot', fireAt, nextFireAt: fireAt };
    } else if (input.kind === 'recurring' && input.rhythm?.kind === 'interval') {
      const everyMs = input.rhythm.everyMs;
      if (!Number.isSafeInteger(everyMs) || everyMs < MIN_INTERVAL_MS) {
        throw new Error(`everyMs must be an integer of at least ${MIN_INTERVAL_MS}`);
      }
      definition = {
        ...common,
        kind: 'recurring',
        rhythm: { kind: 'interval', everyMs },
        nextFireAt: createdAt + everyMs,
      };
    } else {
      throw new Error('automation kind must be oneshot or recurring interval');
    }
    this.document.definitions.push(definition);
    this.save();
    return structuredClone(definition);
  }

  listDefinitions(cwd) {
    return this.document.definitions
      .filter((definition) => cwd === undefined || definition.cwd === cwd)
      .map((definition) => structuredClone(definition));
  }

  getDefinition(id) {
    const definition = this.document.definitions.find((entry) => entry.id === id);
    if (!definition) throw new Error(`automation not found: ${id}`);
    return structuredClone(definition);
  }

  setPaused(id, paused, now = Date.now()) {
    const definition = this.document.definitions.find((entry) => entry.id === id);
    if (!definition) throw new Error(`automation not found: ${id}`);
    if (typeof paused !== 'boolean') throw new Error('paused must be a boolean');
    definition.paused = paused;
    definition.revision += 1;
    definition.updatedAt = assertTimestamp(now, 'now');
    definition.nextFireAt = paused ? null : definitionNext(definition, definition.updatedAt);
    this.save();
    return structuredClone(definition);
  }

  deleteDefinition(id) {
    const index = this.document.definitions.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.document.definitions.splice(index, 1);
    this.save();
    return true;
  }

  listRuns(automationId) {
    return this.document.runs
      .filter((run) => automationId === undefined || run.automationId === automationId)
      .sort((left, right) => right.triggeredAt - left.triggeredAt)
      .map((run) => structuredClone(run));
  }

  hasActiveRun(automationId) {
    return this.document.runs.some((run) => (
      run.automationId === automationId && (run.state === 'scheduled' || run.state === 'running')
    ));
  }

  beginRun(automationId, triggeredAt, _scheduled = true) {
    const definition = this.document.definitions.find((entry) => entry.id === automationId);
    if (!definition) throw new Error(`automation not found: ${automationId}`);
    const startedAt = assertTimestamp(triggeredAt, 'triggeredAt');
    const run = {
      id: `automation-run-${this.document.nextRun++}`,
      automationId,
      definitionRevision: definition.revision,
      triggeredAt: startedAt,
      startedAt,
      completedAt: null,
      state: 'running',
      sessionId: null,
      result: null,
      error: null,
      stopReason: null,
    };
    this.document.runs.push(run);
    this.save();
    return structuredClone(run);
  }

  recordStoppedRun(automationId, triggeredAt, stopReason, completedAt = Date.now()) {
    const definition = this.document.definitions.find((entry) => entry.id === automationId);
    if (!definition) throw new Error(`automation not found: ${automationId}`);
    const run = {
      id: `automation-run-${this.document.nextRun++}`,
      automationId,
      definitionRevision: definition.revision,
      triggeredAt: assertTimestamp(triggeredAt, 'triggeredAt'),
      startedAt: null,
      completedAt: assertTimestamp(completedAt, 'completedAt'),
      state: 'stopped',
      sessionId: null,
      result: null,
      error: null,
      stopReason,
    };
    this.document.runs.push(run);
    this.save();
    return structuredClone(run);
  }

  completeRun(id, outcome) {
    const run = this.document.runs.find((entry) => entry.id === id);
    if (!run) throw new Error(`automation run not found: ${id}`);
    if (!['succeeded', 'failed', 'stopped'].includes(outcome.state)) {
      throw new Error(`invalid automation run outcome: ${outcome.state}`);
    }
    run.state = outcome.state;
    run.completedAt = assertTimestamp(outcome.completedAt, 'completedAt');
    run.sessionId = outcome.sessionId ?? run.sessionId;
    run.result = outcome.state === 'succeeded' ? (outcome.result ?? null) : null;
    run.error = outcome.state === 'failed' ? assertText(outcome.error, 'error') : null;
    run.stopReason = outcome.state === 'stopped' ? assertText(outcome.stopReason, 'stopReason') : null;
    this.save();
    return structuredClone(run);
  }

  interruptActiveRuns(now = Date.now()) {
    let changed = false;
    for (const run of this.document.runs) {
      if (run.state !== 'scheduled' && run.state !== 'running') continue;
      run.state = 'stopped';
      run.completedAt = assertTimestamp(now, 'now');
      run.result = null;
      run.error = null;
      run.stopReason = 'interrupted';
      changed = true;
    }
    if (changed) this.save();
  }

  claimDue(id, target, now) {
    const definition = this.document.definitions.find((entry) => entry.id === id);
    if (!definition || definition.paused || definition.nextFireAt !== target || target > now) return null;
    definition.nextFireAt = definition.kind === 'oneshot'
      ? null
      : recurringNext(definition.createdAt, definition.rhythm.everyMs, now);
    definition.updatedAt = now;
    this.save();
    return structuredClone(definition);
  }
}

function liveClock() {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  };
}

class AutomationScheduler {
  constructor({ store, execute, clock = liveClock() }) {
    if (!(store instanceof AutomationStore)) throw new Error('AutomationScheduler requires AutomationStore');
    if (typeof execute !== 'function') throw new Error('AutomationScheduler requires execute');
    this.store = store;
    this.execute = execute;
    this.clock = clock;
    this.timer = null;
    this.started = false;
    this.stopping = false;
    this.controllers = new Map();
    this.running = new Set();
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    const now = this.clock.now();
    this.store.interruptActiveRuns(now);
    for (const definition of this.store.listDefinitions()) {
      const target = definition.nextFireAt;
      if (target === null || target > now || definition.paused) continue;
      const claimed = this.store.claimDue(definition.id, target, now);
      if (claimed) this.store.recordStoppedRun(definition.id, target, 'missed_schedule', now);
    }
    this.arm();
  }

  refresh() {
    if (this.started && !this.stopping) this.arm();
  }

  arm() {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (this.stopping) return;
    const targets = this.store.listDefinitions()
      .map((definition) => definition.nextFireAt)
      .filter((value) => value !== null);
    if (targets.length === 0) return;
    const delay = Math.max(0, Math.min(Math.min(...targets) - this.clock.now(), MAX_TIMER_DELAY_MS));
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.runDue().finally(() => this.arm());
    }, delay);
    this.timer?.unref?.();
  }

  async runDue(now = this.clock.now()) {
    if (this.stopping) return;
    const due = this.store.listDefinitions()
      .filter((definition) => definition.nextFireAt !== null && definition.nextFireAt <= now)
      .sort((left, right) => left.nextFireAt - right.nextFireAt);
    const executions = [];
    for (const candidate of due) {
      const target = candidate.nextFireAt;
      const definition = this.store.claimDue(candidate.id, target, now);
      if (!definition) continue;
      if (this.store.hasActiveRun(definition.id)) {
        this.store.recordStoppedRun(definition.id, target, 'previous_run_active', now);
        continue;
      }
      const run = this.store.beginRun(definition.id, target);
      executions.push(this.executeRun(definition, run));
    }
    await Promise.all(executions);
    this.refresh();
  }

  async runNow(id, now = this.clock.now()) {
    const definition = this.store.getDefinition(id);
    if (this.store.hasActiveRun(id)) {
      return this.store.recordStoppedRun(id, now, 'previous_run_active', now);
    }
    const run = this.store.beginRun(id, now);
    return this.executeRun(definition, run);
  }

  executeRun(definition, run) {
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    let running;
    running = (async () => {
      try {
        const output = await this.execute(definition, run, controller.signal);
        return this.store.completeRun(run.id, {
          state: 'succeeded',
          completedAt: this.clock.now(),
          sessionId: output?.sessionId ?? null,
          result: output?.result ?? null,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return this.store.completeRun(run.id, {
            state: 'stopped',
            completedAt: this.clock.now(),
            stopReason: 'cancelled',
          });
        }
        return this.store.completeRun(run.id, {
          state: 'failed',
          completedAt: this.clock.now(),
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.controllers.delete(run.id);
        this.running.delete(running);
      }
    })();
    this.running.add(running);
    return running;
  }

  async stop() {
    this.stopping = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.controllers.values()) {
      controller.abort(new Error('PawWork automation scheduler stopped'));
    }
    await Promise.allSettled([...this.running]);
    this.started = false;
  }
}

function textResult(value) {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

const OPEN_OBJECT = { type: 'object', additionalProperties: true };

function tool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: { schema: OPEN_OBJECT, render: (_args, value) => textResult(value) },
    execute,
  };
}

function createAutomationToolDefinitions({ store, scheduler, cwd, model, now = () => Date.now() }) {
  const current = (id) => {
    const definition = store.getDefinition(id);
    if (definition.cwd !== cwd()) throw new Error(`automation not found: ${id}`);
    return definition;
  };
  const objectParameters = (properties, required = []) => ({
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  });

  return [
    tool(
      'automation_create',
      'Create a durable PawWork automation. Use exactly one of at (absolute RFC 3339 time with offset) or every_seconds (fixed interval of at least 30 seconds). The automation runs even after its creating conversation is closed.',
      objectParameters({
        title: { type: 'string' },
        prompt: { type: 'string' },
        at: { type: 'string' },
        every_seconds: { type: 'number' },
      }, ['title', 'prompt']),
      async (args) => {
        if (!isRecord(args) || Number(args.at !== undefined) + Number(args.every_seconds !== undefined) !== 1) {
          throw new Error('automation_create requires exactly one of at or every_seconds');
        }
        const createdAt = now();
        let schedule;
        if (args.at !== undefined) {
          if (typeof args.at !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(args.at)) {
            throw new Error('at must be an RFC 3339 timestamp with an explicit offset');
          }
          const fireAt = Date.parse(args.at);
          if (!Number.isFinite(fireAt)) throw new Error('at must be a valid timestamp');
          schedule = { kind: 'oneshot', fireAt };
        } else {
          if (!Number.isSafeInteger(args.every_seconds) || args.every_seconds < MIN_INTERVAL_MS / 1_000) {
            throw new Error(`every_seconds must be an integer of at least ${MIN_INTERVAL_MS / 1_000}`);
          }
          schedule = { kind: 'recurring', rhythm: { kind: 'interval', everyMs: args.every_seconds * 1_000 } };
        }
        const definition = store.createDefinition({
          ...schedule,
          title: args.title,
          prompt: args.prompt,
          cwd: cwd(),
          model: model(),
        }, createdAt);
        scheduler.refresh();
        return definition;
      },
    ),
    tool(
      'automation_list',
      'List durable PawWork automations for the current workspace, including their recent run history.',
      objectParameters({}),
      async () => ({
        items: store.listDefinitions(cwd()).map((definition) => ({
          ...definition,
          recentRuns: store.listRuns(definition.id).slice(0, 5),
        })),
      }),
    ),
    tool(
      'automation_set_paused',
      'Pause or resume one durable PawWork automation in the current workspace.',
      objectParameters({ id: { type: 'string' }, paused: { type: 'boolean' } }, ['id', 'paused']),
      async (args) => {
        current(args.id);
        const definition = store.setPaused(args.id, args.paused, now());
        scheduler.refresh();
        return definition;
      },
    ),
    tool(
      'automation_run_now',
      'Run one durable PawWork automation in the current workspace now without changing its schedule.',
      objectParameters({ id: { type: 'string' } }, ['id']),
      async (args) => {
        current(args.id);
        return scheduler.runNow(args.id, now());
      },
    ),
    tool(
      'automation_delete',
      'Delete one durable PawWork automation in the current workspace. Historical runs remain in durable history.',
      objectParameters({ id: { type: 'string' } }, ['id']),
      async (args) => {
        current(args.id);
        const deleted = store.deleteDefinition(args.id);
        scheduler.refresh();
        return { id: args.id, deleted };
      },
    ),
  ];
}

module.exports = {
  AutomationScheduler,
  AutomationStore,
  MIN_INTERVAL_MS,
  createAutomationToolDefinitions,
  definitionNext,
  recurringNext,
};
