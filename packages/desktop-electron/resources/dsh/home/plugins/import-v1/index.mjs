import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const importer = require('./import-v1.cjs');
const settingsImporter = require('./import-v1-settings.cjs');
const automationImporter = require('./import-v1-automations.cjs');
const migrationIo = require('./migration-io.cjs');

export const name = 'pawwork-import-v1';
export const inject = [
  'agentDefaultModel',
  'attachments',
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

function isMissingSession(error, id) {
  return error instanceof Error && error.message === `session "${id}" not found`;
}

function persistedImportMatches(imported, inspection) {
  const source = inspection.events[0];
  return source?.type === 'pawwork-v1/session'
    && source.data?.sourceSessionId === imported.seed[0]?.data?.sourceSessionId
    && inspection.meta?.cwd === imported.meta.cwd
    && inspection.meta?.seedLength === imported.meta.seedLength;
}

async function hasPersistedV1Session(sessionPersistence, id) {
  let inspection;
  try {
    inspection = await sessionPersistence.inspect(id);
  } catch (error) {
    if (isMissingSession(error, id)) return false;
    throw error;
  }
  const source = inspection.events[0];
  return source?.type === 'pawwork-v1/session'
    && id === `pawwork-v1-${source.data?.sourceSessionId}`
    && Number.isInteger(inspection.meta?.seedLength)
    && inspection.events.length >= inspection.meta.seedLength;
}

export function createDshSessionImporter(ctx) {
  return async (imported) => {
    let inspection;
    try {
      inspection = await ctx.sessionPersistence.inspect(imported.id);
    } catch (error) {
      if (!isMissingSession(error, imported.id)) throw error;
    }
    if (inspection && !persistedImportMatches(imported, inspection)) {
      throw new Error(`v1 session target does not match source: ${imported.id}`);
    }

    const contentImported = inspection && inspection.events.length >= imported.meta.seedLength;
    if (!contentImported) {
      await importer.materializeLegacyImages(
        imported,
        (image) => ctx.attachments.saveImage(image),
      );
      const session = ctx.sessions.prepare(imported.id, {
        seed: imported.seed,
        meta: imported.meta,
      });
      const detach = ctx.sessions.enter(session);
      try {
        ctx.sessionTitle.rename(session, imported.title);
        await ctx.sessions.flush(session);
        ctx.sessions.announce(session);
      } finally {
        detach();
      }
    }
    return await importer.attachDshWorkspace(imported, ctx.workspaceRegistry);
  };
}

export function apply(ctx) {
  const controller = new AbortController();
  const importTask = (async () => {
    // The two database-backed stages read one private copy of the v1 database,
    // opened once for the whole run: before, each of them VACUUMed the user's
    // entire v1 database into a copy of its own. The settings stage reads JSON
    // files and needs no snapshot; a snapshot that fails to open lets the two
    // database stages report it as their own failure.
    const sourceDatabase = migrationIo.discoverV1Database();
    let snapshot;
    if (sourceDatabase) {
      try {
        snapshot = await migrationIo.openV1Snapshot({ home: process.env.DSH_HOME, sourceDatabase });
      } catch (error) {
        ctx.logger.warn(`v1 database snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      // Each successful session is announced as it lands; one malformed source
      // must not hide the rest or require a separate completion channel.
      try {
        const importSession = createDshSessionImporter(ctx);
        controller.signal.throwIfAborted();
        await importer.runV1SessionImport({
          home: process.env.DSH_HOME,
          sourceDatabase,
          snapshot: snapshot?.path,
          importSession,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
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
        await automationImporter.runV1AutomationImport({
          home: process.env.DSH_HOME,
          sourceDatabase,
          snapshot: snapshot?.path,
          resolveModel: createAutomationModelResolver(ctx),
          importDefinition: async (definition) => {
            if (definition.context === 'continue'
              && !await hasPersistedV1Session(ctx.sessionPersistence, definition.sourceSessionId)) {
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
    } finally {
      // Everything else in this task is caught per stage, so this is the one
      // statement that can reject it — and nothing awaits importTask until the
      // plugin is disposed, so a rejection here reaches DSH's fail-loud handler
      // and exits the backend. rmSync's `force` only swallows ENOENT; a handle
      // held on the snapshot (an indexer, an AV scanner) raises EBUSY.
      try {
        snapshot?.close();
      } catch (error) {
        ctx.logger.warn(`v1 database snapshot cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  })();
  ctx.effect(() => async () => {
    controller.abort(new Error('PawWork v1 importer stopped'));
    await importTask;
  });
}
