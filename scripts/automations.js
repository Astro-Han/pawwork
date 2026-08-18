'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {
  isValidCronExpression,
  isValidTimezone,
  nextCronFireAfter,
} = require('./automation-cron');

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

function definitionNext(definition, after, completedRunCount = 0) {
  if (definition.paused) return null;
  if (definition.stop?.kind === 'count' && completedRunCount >= definition.stop.count) return null;
  if (definition.kind === 'oneshot') return definition.fireAt > after ? definition.fireAt : null;
  if (definition.rhythm.kind === 'cron') {
    return nextCronFireAfter(definition.rhythm.expression, definition.timezone || 'UTC', after);
  }
  return recurringNext(definition.createdAt, definition.rhythm.everyMs, after);
}

function recurringStop(value) {
  if (value === undefined || value?.kind === 'never') return { kind: 'never' };
  if (value?.kind === 'count' && Number.isSafeInteger(value.count) && value.count > 0) {
    return { kind: 'count', count: value.count };
  }
  throw new Error('stop must be never or a positive count');
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
    const timezone = input.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    if (!isValidTimezone(timezone)) throw new Error(`invalid timezone: ${timezone}`);
    const context = input.context || 'fresh';
    if (context !== 'fresh' && context !== 'continue') throw new Error('context must be fresh or continue');
    const sourceSessionId = context === 'continue'
      ? assertText(input.sourceSessionId, 'sourceSessionId')
      : null;
    const common = {
      id: `automation-${this.document.nextDefinition++}`,
      title,
      prompt,
      revision: 1,
      paused: false,
      context,
      cwd,
      model: { provider, model },
      timezone,
      ...(sourceSessionId === null ? {} : { sourceSessionId }),
      createdAt,
      updatedAt: createdAt,
    };
    let definition;
    if (input.kind === 'oneshot') {
      const fireAt = assertTimestamp(input.fireAt, 'fireAt');
      if (fireAt <= createdAt) throw new Error('fireAt must be in the future');
      definition = { ...common, kind: 'oneshot', fireAt, nextFireAt: fireAt };
    } else if (input.kind === 'recurring') {
      let rhythm;
      if (input.rhythm?.kind === 'interval') {
        const everyMs = input.rhythm.everyMs;
        if (!Number.isSafeInteger(everyMs) || everyMs < MIN_INTERVAL_MS) {
          throw new Error(`everyMs must be an integer of at least ${MIN_INTERVAL_MS}`);
        }
        rhythm = { kind: 'interval', everyMs };
      } else if (input.rhythm?.kind === 'cron') {
        const expression = assertText(input.rhythm.expression, 'rhythm.expression');
        if (!isValidCronExpression(expression)) throw new Error(`invalid cron expression: ${expression}`);
        rhythm = { kind: 'cron', expression };
      } else {
        throw new Error('recurring rhythm must be interval or cron');
      }
      definition = {
        ...common,
        kind: 'recurring',
        rhythm,
        stop: recurringStop(input.stop),
        nextFireAt: null,
      };
      definition.nextFireAt = definitionNext(definition, createdAt);
    } else {
      throw new Error('automation kind must be oneshot or recurring');
    }
    this.document.definitions.push(definition);
    this.save();
    return structuredClone(definition);
  }

  importDefinition(input) {
    const id = assertText(input?.id, 'id');
    const existing = this.document.definitions.find((entry) => entry.id === id);
    if (existing) {
      if (existing.migration?.source === 'pawwork-v1'
        && existing.migration.sourceId === input.migration?.sourceId) return 'skipped';
      throw new Error(`automation id conflict: ${id}`);
    }
    assertText(input.title, 'title');
    assertText(input.prompt, 'prompt');
    if (!path.isAbsolute(assertText(input.cwd, 'cwd'))) throw new Error('cwd must be absolute');
    assertText(input.model?.provider, 'model.provider');
    assertText(input.model?.model, 'model.model');
    if (!isValidTimezone(input.timezone)) throw new Error(`invalid timezone: ${input.timezone}`);
    assertTimestamp(input.createdAt, 'createdAt');
    assertTimestamp(input.updatedAt, 'updatedAt');
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error('revision must be positive');
    if (input.context === 'continue') assertText(input.sourceSessionId, 'sourceSessionId');
    else if (input.context !== 'fresh') throw new Error('context must be fresh or continue');
    if (input.migration?.source !== 'pawwork-v1' || !input.migration.sourceId) {
      throw new Error('imported automation requires v1 migration identity');
    }
    if (input.migration.takeover === 'pending' && (!input.paused || input.nextFireAt !== null)) {
      throw new Error('pending v1 automation must be paused without a next fire');
    }
    if (input.kind === 'oneshot') assertTimestamp(input.fireAt, 'fireAt');
    else if (input.kind === 'recurring') {
      if (input.rhythm?.kind === 'interval') {
        if (!Number.isSafeInteger(input.rhythm.everyMs) || input.rhythm.everyMs < MIN_INTERVAL_MS) {
          throw new Error(`everyMs must be an integer of at least ${MIN_INTERVAL_MS}`);
        }
      } else if (input.rhythm?.kind === 'cron') {
        if (!isValidCronExpression(input.rhythm.expression)) {
          throw new Error(`invalid cron expression: ${input.rhythm.expression}`);
        }
      } else throw new Error('recurring rhythm must be interval or cron');
      recurringStop(input.stop);
    } else throw new Error(`unsupported automation kind: ${input.kind}`);
    this.document.definitions.push(structuredClone(input));
    this.save();
    return 'imported';
  }

  importRun(input) {
    const id = assertText(input?.id, 'id');
    const existing = this.document.runs.find((entry) => entry.id === id);
    if (existing) {
      if (existing.migration?.source === 'pawwork-v1'
        && existing.migration.sourceId === input.migration?.sourceId) return 'skipped';
      throw new Error(`automation run id conflict: ${id}`);
    }
    const orphanedV1History = input.migration?.source === 'pawwork-v1'
      && input.migration.orphanedDefinition === true;
    if (!this.document.definitions.some((entry) => entry.id === input.automationId) && !orphanedV1History) {
      throw new Error(`automation not found: ${input.automationId}`);
    }
    if (!['succeeded', 'failed', 'stopped'].includes(input.state)) {
      throw new Error(`imported automation run must be terminal: ${input.state}`);
    }
    assertTimestamp(input.triggeredAt, 'triggeredAt');
    assertTimestamp(input.completedAt, 'completedAt');
    if (input.startedAt !== null) assertTimestamp(input.startedAt, 'startedAt');
    this.document.runs.push(structuredClone(input));
    this.save();
    return 'imported';
  }

  pendingV1Takeover(cwd) {
    return this.document.definitions.filter((definition) => (
      definition.migration?.source === 'pawwork-v1'
      && definition.migration.takeover === 'pending'
      && (cwd === undefined || definition.cwd === cwd)
    )).map((definition) => structuredClone(definition));
  }

  confirmV1Takeover(now = Date.now()) {
    const confirmedAt = assertTimestamp(now, 'now');
    const confirmed = [];
    for (const definition of this.document.definitions) {
      if (definition.migration?.source !== 'pawwork-v1' || definition.migration.takeover !== 'pending') continue;
      definition.migration.takeover = 'confirmed';
      definition.paused = false;
      definition.revision += 1;
      definition.updatedAt = confirmedAt;
      definition.nextFireAt = definitionNext(
        definition,
        confirmedAt,
        this.completedRunCount(definition.id),
      );
      confirmed.push(structuredClone(definition));
    }
    if (confirmed.length > 0) this.save();
    return confirmed;
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

  updateDefinition(id, patch, now = Date.now()) {
    const index = this.document.definitions.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error(`automation not found: ${id}`);
    const previous = this.document.definitions[index];
    const next = structuredClone(previous);
    const updatedAt = assertTimestamp(now, 'now');
    let scheduleChanged = false;
    if (patch.title !== undefined) next.title = assertText(patch.title, 'title');
    if (patch.prompt !== undefined) next.prompt = assertText(patch.prompt, 'prompt');
    if (patch.model !== undefined) {
      next.model = {
        provider: assertText(patch.model.provider, 'model.provider'),
        model: assertText(patch.model.model, 'model.model'),
      };
    }
    if (patch.timezone !== undefined) {
      if (!isValidTimezone(patch.timezone)) throw new Error(`invalid timezone: ${patch.timezone}`);
      next.timezone = patch.timezone;
      scheduleChanged = true;
    }
    if (patch.fireAt !== undefined) {
      if (next.kind !== 'oneshot') throw new Error('at cannot update a recurring automation');
      const fireAt = assertTimestamp(patch.fireAt, 'fireAt');
      if (fireAt <= updatedAt) throw new Error('fireAt must be in the future');
      next.fireAt = fireAt;
      scheduleChanged = true;
    }
    if (patch.rhythm !== undefined) {
      if (next.kind !== 'recurring') throw new Error('rhythm cannot update a one-shot automation');
      if (patch.rhythm.kind === 'interval') {
        if (!Number.isSafeInteger(patch.rhythm.everyMs) || patch.rhythm.everyMs < MIN_INTERVAL_MS) {
          throw new Error(`everyMs must be an integer of at least ${MIN_INTERVAL_MS}`);
        }
        next.rhythm = { kind: 'interval', everyMs: patch.rhythm.everyMs };
      } else if (patch.rhythm.kind === 'cron') {
        const expression = assertText(patch.rhythm.expression, 'rhythm.expression');
        if (!isValidCronExpression(expression)) throw new Error(`invalid cron expression: ${expression}`);
        next.rhythm = { kind: 'cron', expression };
      } else {
        throw new Error('recurring rhythm must be interval or cron');
      }
      scheduleChanged = true;
    }
    if (patch.stop !== undefined) {
      if (next.kind !== 'recurring') throw new Error('run_count cannot update a one-shot automation');
      next.stop = recurringStop(patch.stop);
      scheduleChanged = true;
    }
    next.revision += 1;
    next.updatedAt = updatedAt;
    if (scheduleChanged) {
      next.nextFireAt = definitionNext(next, updatedAt, this.completedRunCount(id));
    }
    this.document.definitions[index] = next;
    this.save();
    return structuredClone(next);
  }

  setPaused(id, paused, now = Date.now()) {
    const definition = this.document.definitions.find((entry) => entry.id === id);
    if (!definition) throw new Error(`automation not found: ${id}`);
    if (typeof paused !== 'boolean') throw new Error('paused must be a boolean');
    definition.paused = paused;
    definition.revision += 1;
    definition.updatedAt = assertTimestamp(now, 'now');
    definition.nextFireAt = paused
      ? null
      : definitionNext(definition, definition.updatedAt, this.completedRunCount(id));
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

  completedRunCount(automationId) {
    return this.document.runs.filter((run) => (
      run.automationId === automationId && (run.state === 'succeeded' || run.state === 'failed')
    )).length;
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
    const definition = this.document.definitions.find((entry) => entry.id === run.automationId);
    if (definition?.kind === 'recurring' && definition.stop?.kind === 'count') {
      const completed = this.completedRunCount(definition.id);
      if (completed >= definition.stop.count) definition.nextFireAt = null;
    }
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
      : definitionNext(definition, now, this.completedRunCount(id));
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

function parseModelSelection(value) {
  const text = assertText(value, 'model');
  const separator = text.indexOf('/');
  if (separator <= 0 || separator === text.length - 1) {
    throw new Error('model must use provider/model format');
  }
  return { provider: text.slice(0, separator), model: text.slice(separator + 1) };
}

function createAutomationToolDefinitions({
  store,
  scheduler,
  cwd,
  model,
  sessionId = () => null,
  now = () => Date.now(),
}) {
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
      'Create a durable PawWork automation. Use exactly one of at (absolute RFC 3339 time with offset), every_seconds (fixed interval of at least 30 seconds), or cron (five fields evaluated in timezone). run_count optionally stops a recurring automation after that many completed attempts; 0 means no limit. Set continue_session only when the user explicitly wants every run appended to this conversation; otherwise each run gets a fresh DSH session. The automation runs even after its creating conversation is closed.',
      objectParameters({
        title: { type: 'string' },
        prompt: { type: 'string' },
        at: { type: 'string' },
        every_seconds: { type: 'number' },
        cron: { type: 'string' },
        timezone: { type: 'string' },
        run_count: { type: 'number' },
        model: { type: 'string' },
        continue_session: { type: 'boolean' },
      }, ['title', 'prompt']),
      async (args) => {
        const scheduleFields = Number(args?.at !== undefined)
          + Number(args?.every_seconds !== undefined)
          + Number(args?.cron !== undefined);
        if (!isRecord(args) || scheduleFields !== 1) {
          throw new Error('automation_create requires exactly one of at, every_seconds, or cron');
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
        } else if (args.every_seconds !== undefined) {
          if (!Number.isSafeInteger(args.every_seconds) || args.every_seconds < MIN_INTERVAL_MS / 1_000) {
            throw new Error(`every_seconds must be an integer of at least ${MIN_INTERVAL_MS / 1_000}`);
          }
          schedule = { kind: 'recurring', rhythm: { kind: 'interval', everyMs: args.every_seconds * 1_000 } };
        } else {
          if (typeof args.cron !== 'string' || !isValidCronExpression(args.cron)) {
            throw new Error('cron must be a valid five-field cron expression');
          }
          schedule = { kind: 'recurring', rhythm: { kind: 'cron', expression: args.cron } };
        }
        if (args.run_count !== undefined && schedule.kind !== 'recurring') {
          throw new Error('run_count is only supported for recurring automations');
        }
        if (args.run_count !== undefined && (!Number.isSafeInteger(args.run_count) || args.run_count < 0)) {
          throw new Error('run_count must be a non-negative integer');
        }
        const definition = store.createDefinition({
          ...schedule,
          title: args.title,
          prompt: args.prompt,
          cwd: cwd(),
          model: args.model === undefined ? model() : parseModelSelection(args.model),
          timezone: args.timezone,
          context: args.continue_session ? 'continue' : 'fresh',
          ...(args.continue_session ? { sourceSessionId: sessionId() } : {}),
          ...(schedule.kind === 'recurring'
            ? { stop: !args.run_count ? { kind: 'never' } : { kind: 'count', count: args.run_count } }
            : {}),
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
        takeoverPending: store.pendingV1Takeover(cwd()).length,
        items: store.listDefinitions(cwd()).map((definition) => ({
          ...definition,
          recentRuns: store.listRuns(definition.id).slice(0, 5),
        })),
      }),
    ),
    tool(
      'automation_takeover_v1',
      'Finish migration of all active v1 automations. First call with confirmed false to show what is pending. Call with confirmed true only after the user explicitly confirms that PawWork v2 should take over all pending v1 automations. Confirmation is global, happens once, never replays missed work, and schedules only future occurrences.',
      objectParameters({ confirmed: { type: 'boolean' } }, ['confirmed']),
      async (args) => {
        const pending = store.pendingV1Takeover();
        if (args.confirmed !== true) {
          return {
            confirmed: false,
            pending: pending.map((definition) => ({
              id: definition.id,
              title: definition.title,
              cwd: definition.cwd,
            })),
          };
        }
        const definitions = store.confirmV1Takeover(now());
        scheduler.refresh();
        return { confirmed: true, activated: definitions.length, definitions };
      },
    ),
    tool(
      'automation_update',
      'Update an existing PawWork automation in the current workspace without replacing its identity or history. Supply at only for a one-shot automation; supply every_seconds or cron only for a recurring automation. run_count is the completed-attempt limit and 0 removes the limit. model uses provider/model format.',
      objectParameters({
        id: { type: 'string' },
        title: { type: 'string' },
        prompt: { type: 'string' },
        at: { type: 'string' },
        every_seconds: { type: 'number' },
        cron: { type: 'string' },
        timezone: { type: 'string' },
        run_count: { type: 'number' },
        model: { type: 'string' },
      }, ['id']),
      async (args) => {
        const previous = current(args.id);
        const scheduleFields = Number(args.at !== undefined)
          + Number(args.every_seconds !== undefined)
          + Number(args.cron !== undefined);
        if (scheduleFields > 1) throw new Error('automation_update accepts at most one schedule field');
        const patch = {};
        for (const field of ['title', 'prompt', 'timezone']) {
          if (args[field] !== undefined) patch[field] = args[field];
        }
        if (args.model !== undefined) patch.model = parseModelSelection(args.model);
        if (args.at !== undefined) {
          if (previous.kind !== 'oneshot') throw new Error('at cannot update a recurring automation');
          if (typeof args.at !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(args.at)) {
            throw new Error('at must be an RFC 3339 timestamp with an explicit offset');
          }
          const fireAt = Date.parse(args.at);
          if (!Number.isFinite(fireAt)) throw new Error('at must be a valid timestamp');
          patch.fireAt = fireAt;
        }
        if (args.every_seconds !== undefined) {
          if (previous.kind !== 'recurring') throw new Error('every_seconds cannot update a one-shot automation');
          if (!Number.isSafeInteger(args.every_seconds) || args.every_seconds < MIN_INTERVAL_MS / 1_000) {
            throw new Error(`every_seconds must be an integer of at least ${MIN_INTERVAL_MS / 1_000}`);
          }
          patch.rhythm = { kind: 'interval', everyMs: args.every_seconds * 1_000 };
        }
        if (args.cron !== undefined) {
          if (previous.kind !== 'recurring') throw new Error('cron cannot update a one-shot automation');
          if (typeof args.cron !== 'string' || !isValidCronExpression(args.cron)) {
            throw new Error('cron must be a valid five-field cron expression');
          }
          patch.rhythm = { kind: 'cron', expression: args.cron };
        }
        if (args.run_count !== undefined) {
          if (previous.kind !== 'recurring') throw new Error('run_count cannot update a one-shot automation');
          if (!Number.isSafeInteger(args.run_count) || args.run_count < 0) {
            throw new Error('run_count must be a non-negative integer');
          }
          patch.stop = args.run_count === 0 ? { kind: 'never' } : { kind: 'count', count: args.run_count };
        }
        if (Object.keys(patch).length === 0) throw new Error('automation_update requires at least one change');
        const definition = store.updateDefinition(args.id, patch, now());
        scheduler.refresh();
        return definition;
      },
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
