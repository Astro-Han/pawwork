import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  AutomationScheduler,
  AutomationStore,
  automationRunSessionId,
  createAutomationRpcHandler,
  createAutomationToolDefinitions,
  isAutomationRunSession,
} = require('./automations.cjs');

export const name = 'pawwork-automations';
export const inject = ['agentDefaultModel', 'agents', 'connection', 'llm', 'sessions', 'sessionTitle'];

function eventTurn(event) {
  return Number.isSafeInteger(event?.data?.turn) ? event.data.turn : null;
}

function automationResult(events, turn) {
  if (turn === null) return null;
  const turnEvents = events.filter((event) => eventTurn(event) === turn);
  const end = [...turnEvents].reverse().find((event) => event.type === 'turn/end');
  if (!end || !['completed', 'max-tokens'].includes(end.data.reason.kind)) {
    if (end?.data.reason.kind === 'error') throw new Error(end.data.reason.error.message);
    throw new Error(`automation turn ended as ${end?.data.reason.kind || 'unknown'}`);
  }
  const message = [...turnEvents].reverse().find((event) => event.type === 'assistant/message');
  if (!message) return null;
  const text = message.data.message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  return text || null;
}

// The adapter that would serve the request is the only judge of whether it can. Its
// UNKNOWN_MODEL answer is "cannot"; so is NO_ADAPTER once any adapter is registered, because
// pi-ai swaps its routes synchronously and a configured provider is never briefly missing.
// With no adapter registered yet there is no verdict, and neither is any other failure.
export async function modelIsUnknown(ctx, model, signal) {
  try {
    await ctx.llm.resolveModelInfo(model.provider, model.model, signal);
    return false;
  } catch (error) {
    if (error?.code === 'UNKNOWN_MODEL') return true;
    if (error?.code === 'NO_ADAPTER') return ctx.llm.listProviders().length > 0;
    return false;
  }
}

// Writers may refuse a pair the adapter rejects; they never substitute another one.
export function createModelCheck(ctx) {
  return async (model) => {
    if (!await modelIsUnknown(ctx, model)) return;
    const error = new Error(`model ${model.provider}/${model.model} is not available`);
    error.code = 'unknown-model';
    throw error;
  };
}

// The substitution a run gets, or null when it keeps the definition's pair: also when the
// default model is itself unknown, so the failure names the pair the user actually chose.
export async function resolveRunModel(ctx, requested, signal) {
  if (!await modelIsUnknown(ctx, requested, signal)) return null;
  const current = ctx.agentDefaultModel.currentSelection();
  const used = { provider: current.provider, model: current.model };
  if (used.provider === requested.provider && used.model === requested.model) return null;
  if (await modelIsUnknown(ctx, used, signal)) return null;
  return { requested: { ...requested }, used };
}

export function createDshExecutor(ctx, store) {
  return async (definition, run, signal) => {
    signal.throwIfAborted();
    const sessionId = definition.context === 'continue'
      ? definition.sourceSessionId
      : automationRunSessionId(run.id);
    let handle;
    let agent = definition.context === 'continue' ? ctx.agents.get(sessionId) : undefined;
    if (!agent) {
      const modelFallback = await resolveRunModel(ctx, definition.model, signal);
      signal.throwIfAborted();
      // The record is bookkeeping about the run, not a condition for it.
      if (modelFallback) {
        try {
          store.recordRunModel(run.id, modelFallback);
        } catch (error) {
          ctx.logger.warn(`automation run ${run.id} could not record its model: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const used = modelFallback?.used ?? definition.model;
      const agentOptions = { provider: used.provider, model: used.model };
      handle = definition.context === 'continue'
        ? await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, signal })
        : await ctx.agents.create({ sessionId, meta: { cwd: definition.cwd }, agentOptions, signal });
      agent = handle.agent;
    }
    signal.throwIfAborted();
    const cancel = () => agent.cancel({ kind: 'hook', reason: 'automation scheduler stopped' });
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (definition.context === 'fresh') ctx.sessionTitle.rename(agent.session, `Automation: ${definition.title}`);
      const followup = {
        id: `pawwork-automation-message-${run.id}`,
        role: 'user',
        content: [{ type: 'text', text: definition.prompt }],
        source: { kind: 'user' },
      };
      let previousTurn;
      for (;;) {
        await agent.whenIdle();
        signal.throwIfAborted();
        previousTurn = [...agent.session.snapshotEvents()]
          .reverse()
          .map(eventTurn)
          .find((turn) => turn !== null) ?? null;
        let maintenance;
        try {
          maintenance = agent.runMaintenance(async (maintenanceSignal) => {
            maintenanceSignal.throwIfAborted();
            signal.throwIfAborted();
            agent.followup(followup);
          });
        } catch (_maintenanceFailure) {
          signal.throwIfAborted();
          continue;
        }
        await maintenance;
        break;
      }
      await agent.whenIdle();
      signal.throwIfAborted();
      const events = [...agent.session.snapshotEvents()];
      const turn = events
        .find((event) => event.type === 'turn/start'
          && eventTurn(event) !== null
          && (previousTurn === null || eventTurn(event) > previousTurn));
      const turnNumber = turn ? eventTurn(turn) : null;
      const result = automationResult(events, turnNumber);
      await ctx.sessions.flush(agent.session);
      return { sessionId, result };
    } finally {
      signal.removeEventListener('abort', cancel);
      await handle?.dispose();
    }
  };
}

function registerAgentTools(ctx, agent, store, scheduler, checkModel) {
  if (isAutomationRunSession(agent.id)) return;
  agent.ctx.effect(() => {
    const definitions = createAutomationToolDefinitions({
      store,
      scheduler,
      checkModel,
      cwd: () => agent.session.header.cwd || process.cwd(),
      sessionId: () => agent.id,
      model: () => {
        const { provider, model } = agent.options;
        if (provider && model) return { provider, model };
        const current = ctx.agentDefaultModel.currentSelection();
        return { provider: current.provider, model: current.model };
      },
    });
    const disposers = definitions.map((definition) => agent.ctx.tools.register({
      ...definition,
      async execute(args, exec) {
        if (exec.agent !== agent) throw new Error('automation tool owner mismatch');
        return definition.execute(args, exec);
      },
    }));
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  }, 'pawwork.automations.tools()');
}

export function apply(ctx) {
  const home = process.env.DSH_HOME;
  if (!home || !path.isAbsolute(home)) throw new Error('PawWork automations require an absolute DSH_HOME');
  const store = new AutomationStore(path.join(home, 'automations.json'));
  const scheduler = new AutomationScheduler({ store, execute: createDshExecutor(ctx, store) });
  const checkModel = createModelCheck(ctx);
  const rpc = createAutomationRpcHandler({ store, scheduler });
  ctx.provide('pawworkAutomations', { store, scheduler });
  ctx.effect(() => {
    const stopRpc = ctx.connection.rpc.handle('/pawwork-automations', rpc, { authority: 'loopback' });
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (!ctx.agents.roots().includes(agent)) return;
      registerAgentTools(ctx, agent, store, scheduler, checkModel);
    });
    void scheduler.start().catch((error) => {
      ctx.logger.warn(`automation scheduler failed to start: ${error instanceof Error ? error.message : String(error)}`);
    });
    return async () => {
      stopCreated();
      await stopRpc();
      await scheduler.stop();
    };
  }, 'pawwork.automations.lifecycle()');
}
