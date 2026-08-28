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
export const inject = ['agentDefaultModel', 'agents', 'connection', 'sessions', 'sessionTitle'];

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

export function createDshExecutor(ctx) {
  return async (definition, run, signal) => {
    signal.throwIfAborted();
    const sessionId = definition.context === 'continue'
      ? definition.sourceSessionId
      : automationRunSessionId(run.id);
    let handle;
    let agent = definition.context === 'continue' ? ctx.agents.get(sessionId) : undefined;
    if (!agent) {
      const agentOptions = {
        provider: definition.model.provider,
        model: definition.model.model,
      };
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
        previousTurn = [...agent.session.events]
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
      const events = [...agent.session.events];
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

function registerAgentTools(ctx, agent, store, scheduler) {
  if (isAutomationRunSession(agent.id)) return;
  agent.ctx.effect(() => {
    const definitions = createAutomationToolDefinitions({
      store,
      scheduler,
      cwd: () => agent.session.header.cwd || process.cwd(),
      sessionId: () => agent.id,
      model: () => {
        const current = ctx.agentDefaultModel.currentSelection();
        return {
          provider: agent.options.provider || current.provider,
          model: agent.options.model || current.model,
        };
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
  const scheduler = new AutomationScheduler({ store, execute: createDshExecutor(ctx) });
  const rpc = createAutomationRpcHandler({
    store,
    scheduler,
  });
  ctx.provide('pawworkAutomations', { store, scheduler });
  ctx.effect(() => {
    const stopRpc = ctx.connection.rpc.handle('/pawwork-automations', rpc, { authority: 'loopback' });
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (!ctx.agents.roots().includes(agent)) return;
      registerAgentTools(ctx, agent, store, scheduler);
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
