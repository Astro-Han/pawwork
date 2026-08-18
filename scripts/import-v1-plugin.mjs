import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

const require = createRequire(import.meta.url);
const importer = require('./import-v1.cjs');
const settingsImporter = require('./import-v1-settings.cjs');

export const name = 'pawwork-import-v1';
export const inject = [
  'agentDefaultModel',
  'attachments',
  'llm',
  'sessions',
  'sessionPersistence',
  'sessionTitle',
  'settings',
];

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
    await importer.materializeLegacyImages(imported, (image) => ctx.attachments.saveImage(image));
    if (persisted.has(imported.id)) {
      const inspection = await ctx.sessionPersistence.inspect(imported.id);
      if (importedPrefixIsComplete(inspection.events, imported)) return 'skipped';
    }

    const session = ctx.sessions.prepare(imported.id, {
      seed: imported.seed,
      meta: imported.meta,
    });
    const detach = ctx.sessions.enter(session);
    try {
      ctx.sessions.announce(session);
      ctx.sessionTitle.rename(session, imported.title);
      await ctx.sessions.flush(session);
      persisted.add(imported.id);
      return 'imported';
    } finally {
      detach();
    }
  };
}

export function apply(ctx) {
  const controller = new AbortController();
  void (async () => {
    try {
      const importSession = await createDshSessionImporter(ctx);
      await importer.runV1SessionImport({
        home: process.env.DSH_HOME,
        importSession,
        signal: controller.signal,
      });
    } catch (error) {
      ctx.logger.warn(`v1 session import failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const importSetting = settingsImporter.createDshSettingImporter(ctx);
      await settingsImporter.runV1SettingsImport({
        home: process.env.DSH_HOME,
        importSetting,
        signal: controller.signal,
      });
    } catch (error) {
      ctx.logger.warn(`v1 settings import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  ctx.effect(() => () => controller.abort(new Error('PawWork v1 importer stopped')));
}
