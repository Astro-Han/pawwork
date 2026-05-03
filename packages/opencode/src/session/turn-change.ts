import crypto from "crypto"
import fs from "fs/promises"
import path from "path"
import { createTwoFilesPatch, diffLines } from "diff"
import z from "zod"
import { eq, and, ne, Database } from "@/storage/db"
import { count } from "drizzle-orm"
import { MessageID, SessionID } from "./schema"
import { TurnChangeDisplayTable, TurnChangeRestoreTable } from "./session.sql"
import { Instance } from "@/project/instance"
import { isSensitivePath, sensitivityPath } from "@/tool/sensitive"
import { trimDiff } from "@/tool/edit"
import { Global } from "@/global"
import * as Bom from "@/util/bom"
import { Log } from "@opencode-ai/core/util/log"
import { Context, Effect, Layer } from "effect"
import { makeRuntime } from "@/effect/run-service"

export type FileState =
  | { exists: false; content?: undefined; hash?: string; restorable?: boolean; bom?: boolean; large?: boolean; binary?: boolean }
  | { exists: true; content?: string; hash?: string; restorable?: boolean; bom?: boolean; large?: boolean; binary?: boolean }
type Status = "added" | "modified" | "deleted"

export type DisplayFile = {
  path: string
  openPath?: string
  status: Status
  additions?: number
  deletions?: number
  patch?: string
  sensitive?: boolean
  binary?: boolean
  large?: boolean
  restoreAvailable?: boolean
  expandable: boolean
}

export type Display = {
  sessionID: SessionID
  turnID: MessageID
  messageID: MessageID
  undoAvailable: boolean
  redoAvailable: boolean
  truncated?: boolean
  omittedCount?: number
  files: DisplayFile[]
}

export type RecordWriteInput = {
  sessionID: SessionID
  messageID: MessageID
  path: string
  before: FileState
  after: FileState
}

export type MutationResult =
  | { status: "applied"; display: Display }
  | {
      status: "blocked"
      reason: "conflict" | "restore_missing" | "permission_denied" | "unsupported_size" | "write_failed"
      files: Array<{ path: string; reason: string; omittedCount?: number }>
    }

type RestoreFile = {
  path: string
  displayPath: string
  before: FileState
  after: FileState
}

type RestoreOverflow = {
  overflow: true
  omittedCount: number
}

type RestoreRow = {
  session_id: SessionID
  message_id: MessageID
  file_path: string
  position: number
  data: RestoreFile
  finalized: boolean
}

type RestoreTableRow = Omit<RestoreRow, "data"> & {
  data: RestoreFile | RestoreOverflow
}

const DISPLAY_LIMIT = 2 * 1024 * 1024
const RESTORE_LIMIT = 2 * 1024 * 1024
const MAX_FILES = 200
const OVERFLOW_PATH = "__pawwork_turn_change_overflow__"
const log = Log.create({ service: "session.turn-change" })

class RestoreConflictError extends Error {
  constructor(
    readonly file: string,
    readonly displayPath: string,
  ) {
    super("restore conflict")
  }
}

function now() {
  return Date.now()
}

function hash(state: FileState) {
  if (!state.exists) return "missing"
  if (state.hash) return state.hash
  return stateHash(state.content ?? "", state.bom)
}

function same(a: FileState, b: FileState) {
  return hash(a) === hash(b)
}

function status(before: FileState, after: FileState): Status {
  if (!before.exists && after.exists) return "added"
  if (before.exists && !after.exists) return "deleted"
  return "modified"
}

function displayPath(file: string) {
  const directory = Instance.directory
  if (file.startsWith(directory + path.sep) || file === directory)
    return path.relative(directory, file).replaceAll("\\", "/")
  const worktree = Instance.worktree
  if (file.startsWith(worktree + path.sep) || file === worktree) return path.relative(worktree, file).replaceAll("\\", "/")
  const home = Global.Path.home
  if (home && (file === home || file.startsWith(home + path.sep))) return `~/${path.relative(home, file).replaceAll("\\", "/")}`
  return path.basename(file)
}

function byteSize(text: string) {
  return Buffer.byteLength(text, "utf8")
}

function stateHash(content: string, bom?: boolean) {
  return "sha256:" + crypto.createHash("sha256").update(`${bom ? "bom:1" : "bom:0"}\0${content}`).digest("hex")
}

function isPermissionCode(code: string | undefined) {
  return code === "EACCES" || code === "EPERM"
}

function stateErrorCode(state: FileState) {
  if (!state.hash?.startsWith("error:")) return
  return state.hash.slice("error:".length)
}

function additionsDeletions(before: string, after: string) {
  let additions = 0
  let deletions = 0
  for (const change of diffLines(before, after)) {
    if (change.added) additions += change.count || 0
    if (change.removed) deletions += change.count || 0
  }
  return { additions, deletions }
}

function isBinary(text: string) {
  return text.includes("\0")
}

function canRestore(state: FileState) {
  return !state.exists || (state.content !== undefined && state.restorable !== false && !state.large && !state.binary)
}

function toDisplay(file: RestoreFile): DisplayFile | undefined {
  if (same(file.before, file.after)) return
  const currentStatus = status(file.before, file.after)
  const sensitive = isSensitivePath(sensitivityPath(file.path, Instance.worktree))
  if (sensitive) {
    return {
      path: file.displayPath,
      status: currentStatus,
      sensitive: true,
      expandable: false,
    }
  }

  const beforeText = file.before.exists ? (file.before.content ?? "") : ""
  const afterText = file.after.exists ? (file.after.content ?? "") : ""
  const binary = !!file.before.binary || !!file.after.binary || isBinary(beforeText ?? "") || isBinary(afterText ?? "")
  const large = !!file.before.large || !!file.after.large || byteSize(beforeText ?? "") > DISPLAY_LIMIT || byteSize(afterText ?? "") > DISPLAY_LIMIT
  if (binary || large) {
    return {
      path: file.displayPath,
      status: currentStatus,
      ...(binary ? { binary: true } : {}),
      ...(large ? { large: true } : {}),
      restoreAvailable: canRestore(file.before) && canRestore(file.after),
      expandable: false,
    }
  }

  const counts = additionsDeletions(beforeText, afterText)
  return {
    path: file.displayPath,
    status: currentStatus,
    ...counts,
    patch: trimDiff(createTwoFilesPatch(file.displayPath, file.displayPath, beforeText, afterText, undefined, undefined, { context: 3 })),
    expandable: true,
  }
}

function isOverflow(data: RestoreFile | RestoreOverflow): data is RestoreOverflow {
  return "overflow" in data && data.overflow === true
}

function rows(sessionID: SessionID, messageID: MessageID) {
  const result = Database.use((db) =>
    db
      .select()
      .from(TurnChangeRestoreTable)
      .where(and(eq(TurnChangeRestoreTable.session_id, sessionID), eq(TurnChangeRestoreTable.message_id, messageID)))
      .orderBy(TurnChangeRestoreTable.position)
      .all(),
  ) as RestoreTableRow[]
  return result.filter((row): row is RestoreRow => !isOverflow(row.data))
}

function overflowRow(sessionID: SessionID, messageID: MessageID) {
  return Database.use((db) =>
    db
      .select()
      .from(TurnChangeRestoreTable)
      .where(
        and(
          eq(TurnChangeRestoreTable.session_id, sessionID),
          eq(TurnChangeRestoreTable.message_id, messageID),
          eq(TurnChangeRestoreTable.file_path, OVERFLOW_PATH),
        ),
      )
      .get(),
  ) as RestoreTableRow | undefined
}

function displayRow(sessionID: SessionID, messageID: MessageID) {
  return Database.use((db) =>
    db
      .select()
      .from(TurnChangeDisplayTable)
      .where(and(eq(TurnChangeDisplayTable.session_id, sessionID), eq(TurnChangeDisplayTable.message_id, messageID)))
      .get(),
  ) as { data: Display; state: "applied" | "undone" | "redo_invalidated" } | undefined
}

async function currentState(file: string): Promise<FileState> {
  try {
    const stat = await fs.stat(file)
    if (stat.isDirectory()) return { exists: true, restorable: false, hash: "directory", binary: true }
    if (stat.size > RESTORE_LIMIT) return { exists: true, restorable: false, hash: `large:${stat.size}`, large: true }
    const current = Bom.split(await fs.readFile(file, "utf-8"))
    return {
      exists: true,
      content: current.text,
      bom: current.bom,
      hash: stateHash(current.text, current.bom),
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { exists: false }
    return { exists: true, restorable: false, hash: `error:${(err as NodeJS.ErrnoException).code ?? "unknown"}` }
  }
}

async function applyState(file: string, state: FileState) {
  if (!canRestore(state)) throw new Error("restore data unavailable")
  if (!state.exists) {
    await fs.rm(file, { force: true })
    return
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, (state.bom ? "\uFEFF" : "") + (state.content ?? ""), "utf-8")
}

function withAvailability(display: Display, state: "applied" | "undone" | "redo_invalidated") {
  return {
    ...display,
    undoAvailable: state === "applied",
    redoAvailable: state === "undone",
  }
}

function withOpenPaths(display: Display, restore: RestoreRow[]) {
  const paths = new Map<string, string[]>()
  for (const row of restore) {
    const current = paths.get(row.data.displayPath) ?? []
    current.push(row.data.path)
    paths.set(row.data.displayPath, current)
  }
  return {
    ...display,
    files: display.files.map((file) => {
      const current = paths.get(file.path)
      const openPath = current?.shift()
      return {
        ...file,
        openPath,
      }
    }),
  }
}

export namespace TurnChange {
  export const DisplayFileSchema = z.object({
    path: z.string(),
    openPath: z.string().optional(),
    status: z.enum(["added", "modified", "deleted"]),
    additions: z.number().optional(),
    deletions: z.number().optional(),
    patch: z.string().optional(),
    sensitive: z.boolean().optional(),
    binary: z.boolean().optional(),
    large: z.boolean().optional(),
    restoreAvailable: z.boolean().optional(),
    expandable: z.boolean(),
  })

  export const DisplaySchema = z.object({
    sessionID: SessionID.zod,
    turnID: MessageID.zod,
    messageID: MessageID.zod,
    undoAvailable: z.boolean(),
    redoAvailable: z.boolean(),
    truncated: z.boolean().optional(),
    omittedCount: z.number().optional(),
    files: z.array(DisplayFileSchema),
  })

  export const MutationResultSchema = z.discriminatedUnion("status", [
    z.object({
      status: z.literal("applied"),
      display: DisplaySchema,
    }),
    z.object({
      status: z.literal("blocked"),
      reason: z.enum(["conflict", "restore_missing", "permission_denied", "unsupported_size", "write_failed"]),
      files: z.array(
        z.object({
          path: z.string(),
          reason: z.string(),
          omittedCount: z.number().optional(),
        }),
      ),
    }),
  ])

  function prepareState(state: FileState): FileState {
    if (!state.exists) return state
    const content = state.content ?? ""
    const binary = isBinary(content)
    const large = byteSize(content) > RESTORE_LIMIT
    const hashValue = stateHash(content, state.bom)
    if (binary || large) {
      return { exists: true, hash: hashValue, restorable: false, binary, large, bom: state.bom }
    }
    return { ...state, hash: hashValue, restorable: true }
  }

  function nextPosition(sessionID: SessionID, messageID: MessageID) {
    const row = Database.use((db) =>
      db
        .select({ value: count() })
        .from(TurnChangeRestoreTable)
        .where(and(eq(TurnChangeRestoreTable.session_id, sessionID), eq(TurnChangeRestoreTable.message_id, messageID)))
        .get(),
    )
    return row?.value ?? 0
  }

  function restoreWhere(input: { sessionID: SessionID; messageID: MessageID; path: string }) {
    return and(
      eq(TurnChangeRestoreTable.session_id, input.sessionID),
      eq(TurnChangeRestoreTable.message_id, input.messageID),
      eq(TurnChangeRestoreTable.file_path, input.path),
    )
  }

  function getRestore(input: { sessionID: SessionID; messageID: MessageID; path: string }) {
    return Database.use((db) => db.select().from(TurnChangeRestoreTable).where(restoreWhere(input)).get()) as RestoreRow | undefined
  }

  type ServiceState = {
    locks: Map<SessionID, Promise<void>>
  }

  function recordOverflow(input: { sessionID: SessionID; messageID: MessageID }) {
    const current = overflowRow(input.sessionID, input.messageID)
    const time = now()
    const currentData = current?.data
    const omittedCount = (currentData && isOverflow(currentData) ? currentData.omittedCount : 0) + 1
    Database.use((db) =>
      db
        .insert(TurnChangeRestoreTable)
        .values({
          session_id: input.sessionID,
          message_id: input.messageID,
          file_path: OVERFLOW_PATH,
          position: MAX_FILES,
          data: { overflow: true, omittedCount } satisfies RestoreOverflow,
          finalized: false,
          time_created: time,
          time_updated: time,
        })
        .onConflictDoUpdate({
          target: [TurnChangeRestoreTable.session_id, TurnChangeRestoreTable.message_id, TurnChangeRestoreTable.file_path],
          set: {
            data: { overflow: true, omittedCount } satisfies RestoreOverflow,
            time_updated: time,
          },
        })
        .run(),
    )
    if (omittedCount === 1)
      log.warn("turn change file limit reached", {
        sessionID: input.sessionID,
        messageID: input.messageID,
        omittedCount,
      })
  }

  function recordWriteInternal(input: RecordWriteInput) {
    if (!input.messageID) return
    try {
      const existing = getRestore(input)

      const time = now()
      const data: RestoreFile = {
        path: input.path,
        displayPath: displayPath(input.path),
        before: existing?.data.before ?? prepareState(input.before),
        after: prepareState(input.after),
      }
      if (existing) {
        Database.use((db) =>
          db
            .update(TurnChangeRestoreTable)
            .set({ data, time_updated: time })
            .where(restoreWhere(input))
            .run(),
        )
        return
      }

      const position = nextPosition(input.sessionID, input.messageID)
      if (position >= MAX_FILES) {
        recordOverflow(input)
        return
      }
      try {
        Database.use((db) =>
          db
            .insert(TurnChangeRestoreTable)
            .values({
              session_id: input.sessionID,
              message_id: input.messageID,
              file_path: input.path,
              position,
              data,
              finalized: false,
              time_created: time,
              time_updated: time,
            })
            .run(),
        )
      } catch {
        try {
          const current = getRestore(input)
          if (!current) {
            log.warn("failed to record turn change restore row after insert conflict", {
              sessionID: input.sessionID,
              messageID: input.messageID,
              error: "missing_restore_row",
            })
            return
          }
          const retryData: RestoreFile = {
            ...data,
            before: current.data.before,
          }
          Database.use((db) =>
            db
              .update(TurnChangeRestoreTable)
              .set({ data: retryData, time_updated: time })
              .where(restoreWhere(input))
              .run(),
          )
        } catch {
          log.warn("failed to update turn change restore row after insert conflict", {
            sessionID: input.sessionID,
            messageID: input.messageID,
            error: "update_failed",
          })
          return
        }
      }
    } catch {
      log.warn("failed to record turn change", {
        sessionID: input.sessionID,
        messageID: input.messageID,
        error: "record_failed",
      })
      return
    }
  }

  function finalizeInternal(input: { sessionID: SessionID; messageID: MessageID }) {
    try {
      const files = rows(input.sessionID, input.messageID)
      if (!files.length) return
      const displayFiles = files.map((row) => toDisplay(row.data)).filter(Boolean) as DisplayFile[]
      if (!displayFiles.length) return
      const time = now()
      const overflow = overflowRow(input.sessionID, input.messageID)
      const overflowData = overflow?.data
      const omittedCount = overflowData && isOverflow(overflowData) ? overflowData.omittedCount : 0
      const display: Display = {
        sessionID: input.sessionID,
        turnID: input.messageID,
        messageID: input.messageID,
        undoAvailable: true,
        redoAvailable: false,
        ...(omittedCount > 0 ? { truncated: true, omittedCount } : {}),
        files: displayFiles,
      }
      Database.transaction((db) => {
        db
          .update(TurnChangeDisplayTable)
          .set({ state: "redo_invalidated", time_updated: time })
          .where(
            and(
              eq(TurnChangeDisplayTable.session_id, input.sessionID),
              ne(TurnChangeDisplayTable.message_id, input.messageID),
              eq(TurnChangeDisplayTable.state, "undone"),
            ),
          )
          .run()
        db
          .insert(TurnChangeDisplayTable)
          .values({
            session_id: input.sessionID,
            message_id: input.messageID,
            data: display,
            state: "applied",
            time_created: time,
            time_updated: time,
          })
          .onConflictDoUpdate({
            target: [TurnChangeDisplayTable.session_id, TurnChangeDisplayTable.message_id],
            set: { data: display, state: "applied", time_updated: time },
          })
          .run()
        db
          .update(TurnChangeRestoreTable)
          .set({ finalized: true, time_updated: time })
          .where(
            and(
              eq(TurnChangeRestoreTable.session_id, input.sessionID),
              eq(TurnChangeRestoreTable.message_id, input.messageID),
            ),
          )
          .run()
      })
      return display
    } catch (err) {
      log.warn("failed to finalize turn changes", {
        sessionID: input.sessionID,
        messageID: input.messageID,
        error: err instanceof Error ? err.name : typeof err,
      })
    }
  }

  function getInternal(input: { sessionID: SessionID; messageID: MessageID }) {
    const row = displayRow(input.sessionID, input.messageID)
    if (!row) return
    return withOpenPaths(withAvailability(row.data, row.state), rows(input.sessionID, input.messageID))
  }

  async function mutate(input: { sessionID: SessionID; messageID: MessageID; mode: "undo" | "redo" }): Promise<MutationResult> {
    const display = displayRow(input.sessionID, input.messageID)
    if (!display) return { status: "blocked", reason: "restore_missing", files: [] }
    const sourceState = input.mode === "undo" ? "applied" : "undone"
    if (display.state !== sourceState) return { status: "blocked", reason: "conflict", files: [] }
    const overflow = overflowRow(input.sessionID, input.messageID)
    const overflowData = overflow?.data
    if (overflowData && isOverflow(overflowData)) {
      return {
        status: "blocked",
        reason: "unsupported_size",
        files: [{ path: "omitted files", reason: "truncated", omittedCount: overflowData.omittedCount }],
      }
    }
    const restore = rows(input.sessionID, input.messageID)
    if (!restore.length) return { status: "blocked", reason: "restore_missing", files: [] }

    const blocked: Array<{ path: string; reason: string }> = []
    for (const row of restore) {
      const expected = input.mode === "undo" ? row.data.after : row.data.before
      if (!canRestore(input.mode === "undo" ? row.data.before : row.data.after)) {
        blocked.push({ path: row.data.displayPath, reason: "restore_unavailable" })
        continue
      }
      const current = await currentState(row.data.path)
      if (isPermissionCode(stateErrorCode(current))) blocked.push({ path: row.data.displayPath, reason: "permission_denied" })
      else if (!canRestore(current)) blocked.push({ path: row.data.displayPath, reason: "unavailable" })
      else if (!same(current, expected)) blocked.push({ path: row.data.displayPath, reason: "changed" })
    }
    if (blocked.length)
      return {
        status: "blocked",
        reason: blocked.some((item) => item.reason === "permission_denied")
          ? "permission_denied"
          : blocked.some((item) => item.reason === "restore_unavailable")
            ? "unsupported_size"
            : "conflict",
        files: blocked,
      }

    const rollback: Array<{ file: string; state: FileState }> = []
    try {
      for (const row of restore) {
        const expected = input.mode === "undo" ? row.data.after : row.data.before
        const current = await currentState(row.data.path)
        if (!same(current, expected)) throw new RestoreConflictError(row.data.path, row.data.displayPath)
        rollback.push({ file: row.data.path, state: current })
        await applyState(row.data.path, input.mode === "undo" ? row.data.before : row.data.after)
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      for (const item of rollback.reverse()) {
        await applyState(item.file, item.state).catch(() => undefined)
      }
      if (isPermissionCode(code))
        return {
          status: "blocked",
          reason: "permission_denied",
          files: rollback.map((item) => ({ path: displayPath(item.file), reason: "permission_denied" })),
        }
      if (err instanceof RestoreConflictError)
        return { status: "blocked", reason: "conflict", files: [{ path: err.displayPath, reason: "changed" }] }
      return { status: "blocked", reason: "write_failed", files: rollback.map((item) => ({ path: displayPath(item.file), reason: "rollback" })) }
    }

    const nextState = input.mode === "undo" ? "undone" : "applied"
    const persistedDisplay = withAvailability(display.data, nextState)
    const nextDisplay = withOpenPaths(persistedDisplay, restore)
    const time = now()
    try {
      Database.use((db) =>
        db
          .update(TurnChangeDisplayTable)
          .set({ state: nextState, data: persistedDisplay, time_updated: time })
          .where(and(eq(TurnChangeDisplayTable.session_id, input.sessionID), eq(TurnChangeDisplayTable.message_id, input.messageID)))
          .run(),
      )
    } catch (err) {
      log.warn("failed to persist turn change mutation state", {
        sessionID: input.sessionID,
        messageID: input.messageID,
        error: err instanceof Error ? err.name : typeof err,
      })
      for (const item of rollback.reverse()) {
        await applyState(item.file, item.state).catch(() => undefined)
      }
      return {
        status: "blocked",
        reason: "write_failed",
        files: rollback.map((item) => ({ path: displayPath(item.file), reason: "state_persist_failed" })),
      }
    }
    return { status: "applied", display: nextDisplay }
  }

  async function locked<T>(state: ServiceState, sessionID: SessionID, fn: () => Promise<T>) {
    const previous = state.locks.get(sessionID) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous.then(() => current)
    state.locks.set(sessionID, queued)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (state.locks.get(sessionID) === queued) state.locks.delete(sessionID)
    }
  }

  export interface Interface {
    readonly recordWrite: (input: RecordWriteInput) => Effect.Effect<void>
    readonly finalize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<Display | undefined>
    readonly get: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<Display | undefined>
    readonly undo: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<MutationResult>
    readonly redo: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<MutationResult>
  }

  export class Service extends Context.Service<Service, Interface>()("@pawwork/TurnChange") {}

  export const layer: Layer.Layer<Service, never, never> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const state: ServiceState = { locks: new Map() }
      return Service.of({
        recordWrite: Effect.fn("TurnChange.recordWrite")(function* (input) {
          recordWriteInternal(input)
        }),
        finalize: Effect.fn("TurnChange.finalize")(function* (input) {
          return finalizeInternal(input)
        }),
        get: Effect.fn("TurnChange.get")(function* (input) {
          return getInternal(input)
        }),
        undo: Effect.fn("TurnChange.undo")(function* (input) {
          return yield* Effect.promise(() => locked(state, input.sessionID, () => mutate({ ...input, mode: "undo" })))
        }),
        redo: Effect.fn("TurnChange.redo")(function* (input) {
          return yield* Effect.promise(() => locked(state, input.sessionID, () => mutate({ ...input, mode: "redo" })))
        }),
      })
    }),
  )

  export const defaultLayer = layer
  const runtime = makeRuntime(Service, defaultLayer)

  export function recordWrite(input: RecordWriteInput) {
    return runtime.runSync((svc) => svc.recordWrite(input))
  }

  export function finalize(input: { sessionID: SessionID; messageID: MessageID }) {
    return runtime.runSync((svc) => svc.finalize(input))
  }

  export function get(input: { sessionID: SessionID; messageID: MessageID }) {
    return runtime.runSync((svc) => svc.get(input))
  }

  export function undo(input: { sessionID: SessionID; messageID: MessageID }) {
    return runtime.runPromise((svc) => svc.undo(input))
  }

  export function redo(input: { sessionID: SessionID; messageID: MessageID }) {
    return runtime.runPromise((svc) => svc.redo(input))
  }
}
