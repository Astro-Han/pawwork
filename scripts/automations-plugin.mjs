import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  AutomationScheduler,
  AutomationStore,
  createAutomationToolDefinitions,
} = require('./automations.cjs');

export const name = 'pawwork-automations';
export const inject = [
  'agentDefaultModel',
  'agents',
  'sessions',
  'sessionPersistence',
  'sessionTitle',
  'tools',
];

const AUTOMATION_SESSION_PREFIX = 'pawwork-automation-run-';

function automationResult(agent) {
  const events = agent.session.events;
  const end = [...events].reverse().find((event) => event.type === 'turn/end');
  if (!end || !['completed', 'max-tokens'].includes(end.data.reason.kind)) {
    if (end?.data.reason.kind === 'error') throw new Error(end.data.reason.error.message);
    throw new Error(`automation turn ended as ${end?.data.reason.kind || 'unknown'}`);
  }
  const message = [...events].reverse().find((event) => event.type === 'assistant/message');
  if (!message) return null;
  const text = message.data.message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  return text || null;
}

function createDshExecutor(ctx) {
  return async (definition, run, signal) => {
    signal.throwIfAborted();
    const sessionId = `pawwork-${run.id}`;
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: definition.cwd },
      agentOptions: {
        provider: definition.model.provider,
        model: definition.model.model,
      },
      signal,
    });
    const cancel = () => handle.agent.cancel({ kind: 'hook', reason: 'automation scheduler stopped' });
    signal.addEventListener('abort', cancel, { once: true });
    try {
      ctx.sessionTitle.rename(handle.agent.session, `Automation: ${definition.title}`);
      handle.agent.followup({
        id: `pawwork-automation-message-${run.id}`,
        role: 'user',
        content: [{ type: 'text', text: definition.prompt }],
        source: { kind: 'user' },
      });
      await handle.agent.whenIdle();
      await ctx.sessions.flush(handle.agent.session);
      return { sessionId, result: automationResult(handle.agent) };
    } finally {
      signal.removeEventListener('abort', cancel);
      await handle.dispose();
    }
  };
}

function registerAgentTools(ctx, agent, store, scheduler) {
  if (agent.id.startsWith(AUTOMATION_SESSION_PREFIX)) return;
  agent.ctx.effect(() => {
    const definitions = createAutomationToolDefinitions({
      store,
      scheduler,
      cwd: () => agent.session.header.cwd || process.cwd(),
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
  ctx.effect(() => {
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (!ctx.agents.roots().includes(agent)) return;
      registerAgentTools(ctx, agent, store, scheduler);
    });
    void scheduler.start().catch((error) => {
      ctx.logger.warn(`automation scheduler failed to start: ${error instanceof Error ? error.message : String(error)}`);
    });
    return async () => {
      stopCreated();
      await scheduler.stop();
    };
  }, 'pawwork.automations.lifecycle()');
}
