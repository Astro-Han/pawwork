import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

const require = createRequire(import.meta.url);
const importer = require('./import-v1.cjs');
const settingsImporter = require('./import-v1-settings.cjs');
const automationImporter = require('./import-v1-automations.cjs');

export const name = 'pawwork-import-v1';
export const inject = [
  'agentDefaultModel',
  'attachments',
  'connection',
  'llm',
  'pawworkAutomations',
  'sessions',
  'sessionPersistence',
  'sessionTitle',
  'settings',
  'workspaceRegistry',
];

function createAutomationModelResolver(ctx) {
  const providers = new Set(ctx.llm.listProviders().map((provider) => provider.id));
  const models = new Map();
  return async (source) => {
    const selected = source.data?.model;
    if (providers.has(selected?.providerID)) {
      let available = models.get(selected.providerID);
      if (!available) {
        available = new Set((await ctx.llm.listModels(selected.providerID)).map((model) => model.id));
        models.set(selected.providerID, available);
      }
      if (available.has(selected.modelID)) {
        return { model: { provider: selected.providerID, model: selected.modelID } };
      }
    }
    const fallback = ctx.agentDefaultModel.currentSelection();
    return {
      model: { provider: fallback.provider, model: fallback.model },
      modelWarning: 'model_not_available',
    };
  };
}

function importedPrefixIsComplete(events, imported) {
  if (events.length <= imported.seed.length) return false;
  for (let index = 0; index < imported.seed.length; index += 1) {
    if (!isDeepStrictEqual(events[index], imported.seed[index])) return false;
  }
  if (events[imported.seed.length]?.type !== 'session/end-seed') return false;
  return events.slice(imported.seed.length + 1).some((event) => event.type === 'session/title');
}

async function createDshSessionImporter(ctx) {
  const persisted = new Set((await ctx.sessionPersistence.list()).map((header) => header.id));
  return async (imported) => {
    let outcome = 'imported';
    if (persisted.has(imported.id)) {
      const inspection = await ctx.sessionPersistence.inspect(imported.id);
      if (importedPrefixIsComplete(inspection.events, imported)) outcome = 'skipped';
    }

    if (outcome === 'imported') {
      await importer.materializeLegacyImages(imported, (image) => ctx.attachments.saveImage(image));
      const session = ctx.sessions.prepare(imported.id, {
        seed: imported.seed,
        meta: imported.meta,
      });
      const detach = ctx.sessions.enter(session);
      try {
        ctx.sessionTitle.rename(session, imported.title);
        await ctx.sessions.flush(session);
        persisted.add(imported.id);
      } finally {
        detach();
      }
      const workspace = await importer.attachDshWorkspace(imported, ctx.workspaceRegistry);
      return { session: outcome, workspace };
    }
    const workspace = await importer.attachDshWorkspace(imported, ctx.workspaceRegistry);
    return { session: outcome, workspace };
  };
}

export function apply(ctx) {
  const controller = new AbortController();
  let sessionsComplete = false;
  const stopRpc = ctx.connection.rpc.handle('/pawwork-import-v1', async (endpoint) => {
    if (endpoint === 'status') return { ok: true, value: { sessionsComplete } };
    return { ok: false, error: { code: 'bad-request', message: `unknown v1 import endpoint: ${endpoint}`, details: {} } };
  }, { authority: 'loopback' });
  const importTask = (async () => {
    try {
      const importSession = await createDshSessionImporter(ctx);
      controller.signal.throwIfAborted();
      const result = await importer.runV1SessionImport({
        home: process.env.DSH_HOME,
        importSession,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      sessionsComplete = result.status === 'complete' || result.status === 'not-found';
    } catch (error) {
      if (controller.signal.aborted) return;
      ctx.logger.warn(`v1 session import failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      controller.signal.throwIfAborted();
      const importSetting = settingsImporter.createDshSettingImporter(ctx);
      await settingsImporter.runV1SettingsImport({
        home: process.env.DSH_HOME,
        importSetting,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
    } catch (error) {
      if (controller.signal.aborted) return;
      ctx.logger.warn(`v1 settings import failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      controller.signal.throwIfAborted();
      const completedSessions = importer.completedV1SessionTargetIds(process.env.DSH_HOME);
      await automationImporter.runV1AutomationImport({
        home: process.env.DSH_HOME,
        resolveModel: createAutomationModelResolver(ctx),
        importDefinition: async (definition) => {
          if (definition.context === 'continue' && !completedSessions.has(definition.sourceSessionId)) {
            throw new Error(`v1 automation source session is unavailable: ${definition.sourceSessionId}`);
          }
          return ctx.pawworkAutomations.store.importDefinition(definition);
        },
        importRun: async (run) => ctx.pawworkAutomations.store.importRun(run),
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      ctx.pawworkAutomations.store.activateImportedDefinitions();
      ctx.pawworkAutomations.scheduler.refresh();
    } catch (error) {
      if (controller.signal.aborted) return;
      ctx.logger.warn(`v1 automation import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  ctx.effect(() => async () => {
    controller.abort(new Error('PawWork v1 importer stopped'));
    await importTask;
    await stopRpc();
  });
}
