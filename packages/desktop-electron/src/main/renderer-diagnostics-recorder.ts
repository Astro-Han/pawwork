import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import {
  DEFAULT_RENDERER_DIAGNOSTICS_MAX_BYTES,
  DEFAULT_RENDERER_DIAGNOSTICS_RETENTION_CHECK_MS,
  DEFAULT_RENDERER_DIAGNOSTICS_RETENTION_MS,
  GLOBAL_RENDERER_DIAGNOSTICS_EXPORT_MAX_BYTES,
  RENDERER_DIAGNOSTICS_RETENTION_TARGET_RATIO,
  type RecordContext,
  type RecorderOptions,
  type RendererDiagnosticEvent,
  type RendererDiagnosticsExport,
  type RendererDiagnosticsStatus,
  type SliceInput,
} from "./renderer-diagnostics-types"
import { highFrequencyDiagnosticEvents, parseEventLine, sanitizeRendererDiagnosticEvent } from "./renderer-diagnostics-sanitize"
import {
  capEvents,
  emptyRendererDiagnosticsSlice,
  eventMatchesSession,
  eventTime,
  isIncident,
  selectRendererDiagnosticsSlice,
} from "./renderer-diagnostics-slice"

export function rendererDiagnosticsRoot(userDataPath: string) {
  return join(userDataPath, "diagnostics")
}

export function rendererDiagnosticsPath(root: string) {
  return join(root, "renderer-diagnostics.jsonl")
}

export async function exportRendererDiagnosticsLog(input: {
  path: string
  destination: string
  maxBytes?: number
  now?: Date
}) {
  const maxBytes = input.maxBytes ?? GLOBAL_RENDERER_DIAGNOSTICS_EXPORT_MAX_BYTES
  let content = ""
  let status: RendererDiagnosticsStatus = "ok"
  try {
    content = await readFile(input.path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    status = "missing"
  }
  const lines = content.split(/\r?\n/).filter(Boolean)
  const events: RendererDiagnosticEvent[] = []
  let corruptLineCount = 0
  for (const line of lines) {
    const event = parseEventLine(line)
    if (event) events.push(event)
    else corruptLineCount++
  }
  const capped = capEvents(events, maxBytes)
  if (status === "ok" && capped.omittedEventCount > 0) status = "truncated"
  const output: RendererDiagnosticsExport = {
    schema_version: 1,
    format: "pawwork-renderer-diagnostics",
    source: "renderer-diagnostics",
    generated_at: (input.now ?? new Date()).toISOString(),
    diagnostics: {
      status,
      event_count: capped.events.length,
      incident_count: capped.events.filter(isIncident).length,
      corrupt_line_count: corruptLineCount,
      omitted_event_count: capped.omittedEventCount,
      omitted_bytes: capped.omittedBytes,
    },
    events: capped.events,
  }
  await writeFile(input.destination, `${JSON.stringify(output, null, 2)}\n`, "utf8")
}

function retentionTargetBytes(maxBytes: number) {
  return Math.max(0, Math.floor(maxBytes * RENDERER_DIAGNOSTICS_RETENTION_TARGET_RATIO))
}

export function createRendererDiagnosticsRecorder(options: RecorderOptions) {
  const maxBytes = options.maxBytes ?? DEFAULT_RENDERER_DIAGNOSTICS_MAX_BYTES
  const targetBytes = retentionTargetBytes(maxBytes)
  const retentionMs = options.retentionMs ?? DEFAULT_RENDERER_DIAGNOSTICS_RETENTION_MS
  const retentionCheckIntervalMs = options.retentionCheckIntervalMs ?? DEFAULT_RENDERER_DIAGNOSTICS_RETENTION_CHECK_MS
  const highFrequencyIntervalMs = options.highFrequencyIntervalMs ?? 250
  const now = options.now ?? (() => new Date())
  const path = rendererDiagnosticsPath(options.root)
  const lastHighFrequency = new Map<string, number>()
  let writeFailed = false
  let writeQueue = Promise.resolve()
  let lastRetentionCheck = 0

  const readEventReport = async () => {
    try {
      const content = await readFile(path, "utf8")
      const lines = content.split(/\r?\n/).filter(Boolean)
      const events: RendererDiagnosticEvent[] = []
      let corruptLineCount = 0
      for (const line of lines) {
        const event = parseEventLine(line)
        if (event) events.push(event)
        else corruptLineCount++
      }
      return { status: "ok" as const, events, corruptLineCount }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "missing" as const, events: [], corruptLineCount: 0 }
      }
      return { status: "corrupt" as const, events: [], corruptLineCount: 1 }
    }
  }

  const readEvents = async () => (await readEventReport()).events

  const flushRetentionNow = async () => {
    const events = await readEvents()
    const cutoff = now().getTime() - retentionMs
    const retained = events.filter((event) => eventTime(event) >= cutoff)
    const lines = retained.map((event) => JSON.stringify(event))
    let totalBytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line, "utf8") + 1, 0)
    while (totalBytes > targetBytes && lines.length > 0) {
      const line = lines.shift()
      if (line) totalBytes -= Buffer.byteLength(line, "utf8") + 1
    }
    const content = lines.length > 0 ? `${lines.join("\n")}\n` : ""
    await mkdir(options.root, { recursive: true })
    const temp = join(options.root, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
    await writeFile(temp, content, "utf8")
    await rename(temp, path).catch(async (error) => {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    })
  }

  const enqueueWrite = async <T>(operation: () => Promise<T>) => {
    const next = writeQueue.then(operation, operation)
    writeQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  const drain = async () => {
    await writeQueue
  }

  const maybeFlushRetention = async () => {
    const current = now().getTime()
    const size = await stat(path).then(
      (stats) => stats.size,
      () => 0,
    )
    if (size <= maxBytes && current - lastRetentionCheck < retentionCheckIntervalMs) return
    lastRetentionCheck = current
    await flushRetentionNow()
  }

  const record = async (input: unknown, context: RecordContext) => {
    if (options.disabled) return { ok: false as const, reason: "disabled" as const }
    try {
      const sanitized = sanitizeRendererDiagnosticEvent(input, {
        appLaunchID: options.appLaunchID,
        now,
        windowID: context.windowID,
      })
      if (!sanitized) return { ok: false as const, reason: "dropped" as const }
      if (highFrequencyDiagnosticEvents.has(sanitized["event.name"])) {
        const key = `${sanitized.window_id}:${sanitized["event.name"]}`
        const current = now().getTime()
        const previous = lastHighFrequency.get(key)
        if (previous !== undefined && current - previous < highFrequencyIntervalMs) {
          return { ok: false as const, reason: "rate_limited" as const }
        }
        lastHighFrequency.set(key, current)
      }
      await enqueueWrite(async () => {
        await mkdir(options.root, { recursive: true })
        await appendFile(path, `${JSON.stringify(sanitized)}\n`, "utf8")
        await maybeFlushRetention()
      })
      writeFailed = false
      return { ok: true as const }
    } catch {
      writeFailed = true
      return { ok: false as const, reason: "write_failed" as const }
    }
  }

  const slice = async (input: SliceInput & { windowID?: string | number }) => {
    if (options.disabled) return emptyRendererDiagnosticsSlice("disabled", now())
    await drain()
    const report = await readEventReport()
    if (report.status === "missing") return emptyRendererDiagnosticsSlice(writeFailed ? "write_failed" : "missing", now())
    if (report.status === "corrupt" || (report.events.length === 0 && report.corruptLineCount > 0)) {
      return emptyRendererDiagnosticsSlice(writeFailed && report.status === "corrupt" ? "write_failed" : "corrupt", now())
    }
    writeFailed = false
    const events = report.events
    if (events.length === 0) return emptyRendererDiagnosticsSlice("missing", now())
    const windowID = input.windowID === undefined ? undefined : String(input.windowID)
    const hasMatchingIdentity = events.some((event) => {
      if (event.app_launch_id !== options.appLaunchID) return false
      if (windowID && event.window_id !== windowID) return false
      if (input.traceID && event.trace_id === input.traceID) return true
      if (input.sessionID && eventMatchesSession(event, input.sessionID)) return true
      return !input.sessionID && !input.traceID
    })
    const slice = selectRendererDiagnosticsSlice(events, {
      ...input,
      appLaunchID: options.appLaunchID,
      now: now(),
    })
    if (slice.events.length === 0) return emptyRendererDiagnosticsSlice(hasMatchingIdentity ? "expired" : "missing", now())
    return slice
  }

  return {
    path,
    record,
    flushRetention: () => enqueueWrite(flushRetentionNow),
    drain,
    readEvents,
    readEventReport,
    slice,
  }
}
