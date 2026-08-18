import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

const require = createRequire(import.meta.url);
const importer = require('./import-v1.cjs');

export const name = 'pawwork-import-v1';
export const inject = ['attachments', 'sessions', 'sessionPersistence', 'sessionTitle'];

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
  const running = createDshSessionImporter(ctx).then((importSession) => importer.runV1SessionImport({
    home: process.env.DSH_HOME,
    importSession,
    signal: controller.signal,
  }));
  running.catch((error) => {
    ctx.logger.warn(`v1 session import failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  ctx.effect(() => () => controller.abort(new Error('PawWork v1 importer stopped')));
}
