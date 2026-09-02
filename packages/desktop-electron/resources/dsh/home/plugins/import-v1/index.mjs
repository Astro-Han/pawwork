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

export function createDshSessionImporter(ctx, onPersisted = () => {}) {
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
        // DSH persistence adopts the session on session/created and retires
        // that ownership on the paired session/disposed emitted by detach.
        // Imported sessions are cold after this lifecycle; the status RPC
        // below still supplies the later authoritative sidebar refresh.
        ctx.sessions.announce(session);
      } finally {
        detach();
      }
    }
    onPersisted(imported.id);
    return await importer.attachDshWorkspace(imported, ctx.workspaceRegistry);
  };
}

// `new DatabaseSync` already waits out a five-second busy timeout of its own, so
// a fixed pause on top of that is about six seconds between attempts.
const SNAPSHOT_RETRY_MS = 1_000;
const NOTICE_REASON_LIMIT = 3;

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

// A running v1 holds its database open. SQLite reports that contention as one
// of two result codes carrying different words, and both mean the same thing
// here: the user still has v1 open, so wait. Extended result codes carry the
// primary code in their low byte. Every other code, CANTOPEN included, names
// something no amount of waiting will change, such as a snapshot directory this
// machine cannot write.
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

export function isLockedV1Database(error) {
  const primary = typeof error?.errcode === 'number' ? error.errcode & 0xff : undefined;
  return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
}

// v1 keeps its database open for as long as it runs, and this import is the
// first thing the upgraded app does. Failing here would silently drop every
// session the user has; waiting costs nothing and finishes on its own once they
// quit v1. The wait is only worth taking while the source is still there: a
// source that disappeared will never unlock.
export async function openSnapshotWhenAvailable({ sourceDatabase, signal, onBlocked, onResumed }) {
  for (;;) {
    signal.throwIfAborted();
    try {
      const snapshot = await migrationIo.openV1Snapshot({ home: process.env.DSH_HOME, sourceDatabase });
      onResumed();
      return snapshot;
    } catch (error) {
      if (!isLockedV1Database(error)) throw error;
      if (migrationIo.discoverV1Database() !== sourceDatabase) throw error;
      onBlocked();
      await delay(SNAPSHOT_RETRY_MS, signal);
    }
  }
}

// A snapshot that cannot be taken belongs to no single v1 session, so it takes
// a reserved key in the same category and is cleared the moment one opens.
const SNAPSHOT_FAILURE_ID = 'snapshot';

async function recordSnapshotFailure(message) {
  const { ledger, save } = migrationIo.openMigrationLedger(process.env.DSH_HOME);
  if (message === undefined) {
    if (ledger.failures.sessions[SNAPSHOT_FAILURE_ID] === undefined) return;
    delete ledger.failures.sessions[SNAPSHOT_FAILURE_ID];
  } else {
    ledger.failures.sessions[SNAPSHOT_FAILURE_ID] = { message };
  }
  await save();
}

function ledgerReasons(ledger) {
  const messages = Object.values(ledger.failures)
    .flatMap((records) => Object.values(records).map((record) => record.message));
  return [...new Set(messages)].slice(0, NOTICE_REASON_LIMIT);
}

export function apply(ctx) {
  const controller = new AbortController();
  let lastPersistedSessionId;
  let sessionPhase = 'running';
  let notice;
  let importedTotal = 0;
  const count = (imported) => { importedTotal += imported || 0; };

  // The result is worth one sentence to the user, once. The counts of the last
  // run that carried something live in the ledger, because that is the only
  // thing that survives the window and the next launch has to recognise its own
  // earlier work.
  function recordImportSummary() {
    const { file, ledger, save } = migrationIo.openMigrationLedger(process.env.DSH_HOME);
    // Every stage records each failure under its own key in the ledger, so what
    // did not make it is read back from there rather than tallied a second time.
    const failed = Object.values(ledger.failures).reduce((sum, records) => sum + Object.keys(records).length, 0);
    // A later launch reconciles the same data again and reports less than the
    // run that did the work: a stage that recognises its own earlier result
    // answers "skipped", and no total counts a skip. So the question is not
    // whether the summary changed but whether this run carried more than the
    // recorded one; anything else is the same result reached again and must not
    // greet the user a second time.
    const advanced = (importedTotal > 0 || failed > 0) && (
      ledger.summary === undefined
      || importedTotal > ledger.summary.imported
      || failed > ledger.summary.failed
    );
    if (!advanced) return;
    ledger.summary = { imported: importedTotal, failed, reasons: ledgerReasons(ledger) };
    notice = { ...ledger.summary, ledgerPath: file };
    return save();
  }

  const importTask = (async () => {
    let sourceDatabase;
    let snapshot;
    try {
      // Each stage is caught individually so one malformed source must not
      // hide the rest. The two database-backed stages share one private copy
      // of the v1 database; settings read independent JSON files.
      try {
        sourceDatabase = migrationIo.discoverV1Database();
        if (sourceDatabase) {
          try {
            snapshot = await openSnapshotWhenAvailable({
              sourceDatabase,
              signal: controller.signal,
              onBlocked: () => { sessionPhase = 'blocked'; },
              onResumed: () => { sessionPhase = 'running'; },
            });
            await recordSnapshotFailure(undefined);
          } catch (error) {
            sessionPhase = 'running';
            if (controller.signal.aborted) throw error;
            const message = error instanceof Error ? error.message : String(error);
            // Both database-backed stages read this one snapshot, so a snapshot
            // this machine cannot take is a single failure the user is told
            // about once. The stages that read files instead still run.
            ctx.logger.warn(`v1 database snapshot failed: ${message}`);
            await recordSnapshotFailure(message);
          }
        }
        if (!sourceDatabase || snapshot) {
          const importSession = createDshSessionImporter(ctx, (id) => { lastPersistedSessionId = id; });
          controller.signal.throwIfAborted();
          count(await importer.runV1SessionImport({
            home: process.env.DSH_HOME,
            sourceDatabase,
            snapshot: snapshot?.path,
            importSession,
            signal: controller.signal,
          }));
          controller.signal.throwIfAborted();
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        ctx.logger.warn(`v1 session import failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        // The sidebar consumes only session persistence. Settings and
        // Automation continue independently after this barrier and must not
        // delay the client's cold-session list refresh.
        sessionPhase = 'done';
      }
      try {
        controller.signal.throwIfAborted();
        const importSetting = settingsImporter.createDshSettingImporter(ctx);
        count(await settingsImporter.runV1SettingsImport({
          home: process.env.DSH_HOME,
          importSetting,
          signal: controller.signal,
        }));
        controller.signal.throwIfAborted();
      } catch (error) {
        if (controller.signal.aborted) return;
        ctx.logger.warn(`v1 settings import failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (!sourceDatabase || snapshot) {
        try {
          controller.signal.throwIfAborted();
          count(await automationImporter.runV1AutomationImport({
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
          }));
          controller.signal.throwIfAborted();
          ctx.pawworkAutomations.store.activateImportedDefinitions();
          ctx.pawworkAutomations.scheduler.refresh();
        } catch (error) {
          if (controller.signal.aborted) return;
          ctx.logger.warn(`v1 automation import failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      try {
        controller.signal.throwIfAborted();
        await recordImportSummary();
      } catch (error) {
        if (controller.signal.aborted) return;
        ctx.logger.warn(`v1 import summary failed: ${error instanceof Error ? error.message : String(error)}`);
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
  ctx.effect(() => {
    const stopStatusRpc = ctx.connection.rpc.handle(
      '/pawwork-import-v1',
      async () => {
        // The result goes out with the first reply that carries it and is gone
        // from this task afterwards, so a poll that keeps running cannot put a
        // dismissed strip back on screen.
        const carried = notice;
        notice = undefined;
        return {
          ok: true,
          value: {
            phase: sessionPhase,
            ...(lastPersistedSessionId === undefined ? {} : { sessionId: lastPersistedSessionId }),
            ...(carried === undefined ? {} : { notice: carried }),
          },
        };
      },
      { authority: 'loopback' },
    );
    return async () => {
      await stopStatusRpc();
      controller.abort(new Error('PawWork v1 importer stopped'));
      await importTask;
    };
  });
}
