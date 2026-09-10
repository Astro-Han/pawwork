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

// The stored header and full log of one session, or undefined when none is stored.
async function readStoredSession(sessionPersistence, id) {
  if (await sessionPersistence.stat(id) === undefined) return undefined;
  const handle = await sessionPersistence.open(id, 'read');
  try {
    const { events } = await handle.read();
    return { header: handle.header, events };
  } finally {
    await handle.close();
  }
}

function persistedImportMatches(imported, stored) {
  const source = stored.events[0];
  return source?.type === 'pawwork-v1/session'
    && source.data?.sourceSessionId === imported.seed[0]?.data?.sourceSessionId
    && stored.header.cwd === imported.meta.cwd;
}

async function hasPersistedV1Session(sessionPersistence, id) {
  const stored = await readStoredSession(sessionPersistence, id);
  const source = stored?.events[0];
  return source?.type === 'pawwork-v1/session'
    && id === `pawwork-v1-${source.data?.sourceSessionId}`
    && stored.events.some((event) => event.type === 'session/end-seed');
}

export function createDshSessionImporter(ctx, onPersisted = () => {}) {
  return async (imported) => {
    const stored = await readStoredSession(ctx.sessionPersistence, imported.id);
    if (stored && !persistedImportMatches(imported, stored)) {
      throw new Error(`v1 session target does not match source: ${imported.id}`);
    }

    const contentImported = stored && stored.events.length >= imported.meta.seedLength;
    if (!contentImported) {
      await importer.materializeLegacyImages(
        imported,
        (image) => ctx.attachments.saveImage(image),
      );
      const session = ctx.sessions.prepare(imported.id, {
        seed: imported.seed,
        meta: imported.meta,
      });
      // The seed never re-emits once the session is entered, so persistence only
      // holds it if it is appended through the write handle first. A stored
      // record that stops short of the seed is an interrupted earlier import:
      // its id cannot be created again, so only the missing tail is appended.
      const storedCount = stored ? stored.events.length : 0;
      const handle = stored
        ? await ctx.sessionPersistence.open(imported.id, 'write')
        : await ctx.sessionPersistence.create(session.header, {
          inheritedEventCount: session.inheritedEventCount,
        });
      try {
        await handle.append(session.snapshotEvents().slice(storedCount));
        const detach = ctx.sessions.enter(session);
        try {
          ctx.sessionTitle.rename(session, imported.title);
          await ctx.sessions.flush(session);
          // Imported sessions are cold after this lifecycle; the status RPC
          // below still supplies the later authoritative sidebar refresh.
          ctx.sessions.announce(session);
        } finally {
          detach();
        }
      } finally {
        await handle.close();
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
            defaultModel: () => {
              const current = ctx.agentDefaultModel.currentSelection();
              return { provider: current.provider, model: current.model };
            },
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
      // "done" means the summary has been recorded, so a reply that carries
      // this phase also carries the notice when there is one. Every path out
      // of the task, abort included, passes through here.
      sessionPhase = 'done';
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
