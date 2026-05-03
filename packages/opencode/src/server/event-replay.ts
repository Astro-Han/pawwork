import { randomUUID } from "node:crypto"

export type GlobalEventEnvelope = {
  directory?: string
  project?: string
  workspace?: string
  payload: {
    type: string
    properties: unknown
  }
}

export type ReplayCursor = {
  bootID: string
  seq: number
}

export type ReplayRecord = {
  id: string
  seq: number
  createdAt: number
  envelope: GlobalEventEnvelope
}

export type ReplaySnapshot = {
  bootID: string
  fenceSeq: number
  fenceID: string
  replay: ReplayRecord[]
  gap: boolean
  invalidCursor: boolean
}

const DEFAULT_MAX_RECORDS = 2048
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000

// Keep this list intentionally small. These events are low-volume and session
// or blocker critical; high-volume streaming events recover through bootstrap.
const REPLAYABLE_EVENT_TYPES = new Set([
  "question.asked",
  "question.replied",
  "question.rejected",
  "permission.asked",
  "permission.replied",
  "session.created",
  "session.updated",
  "session.deleted",
  "session.status",
])

export function parseReplayCursor(input: string | undefined): ReplayCursor | undefined {
  if (!input) return undefined
  const index = input.lastIndexOf(":")
  if (index <= 0 || index === input.length - 1) return undefined

  const bootID = input.slice(0, index)
  const seq = Number(input.slice(index + 1))
  if (!Number.isSafeInteger(seq) || seq < 0) return undefined

  return { bootID, seq }
}

export function isReplayableGlobalEvent(envelope: GlobalEventEnvelope): boolean {
  return REPLAYABLE_EVENT_TYPES.has(envelope.payload?.type)
}

export class EventReplayStore {
  private bootID: string
  private readonly maxRecords: number
  private readonly maxAgeMs: number
  private readonly now: () => number
  private seq = 0
  private records: ReplayRecord[] = []

  constructor(input?: { bootID?: string; maxRecords?: number; maxAgeMs?: number; now?: () => number }) {
    this.bootID = input?.bootID ?? `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    this.maxRecords = input?.maxRecords ?? DEFAULT_MAX_RECORDS
    this.maxAgeMs = input?.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    this.now = input?.now ?? Date.now
  }

  latestID(): string {
    return this.formatID(this.seq)
  }

  append(envelope: GlobalEventEnvelope): ReplayRecord | undefined {
    if (!isReplayableGlobalEvent(envelope)) return undefined

    const seq = ++this.seq
    const record: ReplayRecord = {
      id: this.formatID(seq),
      seq,
      createdAt: this.now(),
      envelope: structuredClone(envelope),
    }

    this.records.push(record)
    this.prune()

    return record
  }

  snapshot(lastEventID: string | undefined): ReplaySnapshot {
    this.prune()
    const fenceSeq = this.seq
    const fenceID = this.formatID(fenceSeq)
    const parsed = parseReplayCursor(lastEventID)
    const invalidCursor = !!lastEventID && (!parsed || parsed.bootID !== this.bootID || parsed.seq > fenceSeq)
    const cursorSeq = invalidCursor || !parsed ? fenceSeq : parsed.seq
    const earliestSeq = this.records[0]?.seq
    const gap =
      !invalidCursor &&
      !!parsed &&
      parsed.seq < fenceSeq &&
      (earliestSeq === undefined || parsed.seq < earliestSeq - 1)
    const replay =
      invalidCursor || !parsed
        ? []
        : this.records.filter((record) => record.seq > cursorSeq && record.seq <= fenceSeq)

    return {
      bootID: this.bootID,
      fenceSeq,
      fenceID,
      replay,
      gap,
      invalidCursor,
    }
  }

  reset() {
    this.bootID = `${this.now().toString(36)}-${randomUUID().slice(0, 8)}`
    this.seq = 0
    this.records = []
  }

  clearDirectory(directory: string) {
    this.records = this.records.filter((record) => record.envelope.directory !== directory)
  }

  recordsForTest(): readonly ReplayRecord[] {
    return this.records.slice()
  }

  private formatID(seq: number): string {
    return `${this.bootID}:${seq}`
  }

  private prune() {
    const cutoff = this.now() - this.maxAgeMs
    while (this.records.length > this.maxRecords) this.records.shift()
    while (this.records[0] && this.records[0].createdAt < cutoff) this.records.shift()
  }
}
