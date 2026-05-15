import { titleNumber } from "./terminal-title"
import {
  terminalTabID,
  type PersistedTerminalStateV2,
  type TerminalSnapshot,
  type TerminalTab,
  type TerminalTabID,
} from "./terminal-types"

const TERMINAL_STORAGE_VERSION = 2
const MAX_TERMINAL_SESSIONS = 20

export const unsafeTerminalStorageFieldNames = [
  "ptyID",
  "ptyId",
  "runtimePtyID",
  "runtimePtyId",
  "runtimePTYID",
] as const

type LegacyTerminal = {
  id: string
  title: string
  titleNumber: number
  rows?: number
  cols?: number
  buffer?: string
  cursor?: number
  scrollY?: number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function positiveInteger(value: unknown) {
  const number = num(value)
  if (number === undefined) return
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

function isV2(value: unknown): value is PersistedTerminalStateV2 {
  return record(value) && value.version === TERMINAL_STORAGE_VERSION && Array.isArray(value.tabs)
}

function legacyTerminal(value: unknown): LegacyTerminal | undefined {
  if (!record(value)) return

  const id = text(value.id)
  if (!id) return

  const title = text(value.title) ?? ""
  const directNumber = positiveInteger(value.titleNumber)
  const parsedNumber = titleNumber(title, MAX_TERMINAL_SESSIONS)
  const rows = positiveInteger(value.rows)
  const cols = positiveInteger(value.cols)
  const buffer = text(value.buffer)
  const cursor = num(value.cursor)
  const scrollY = num(value.scrollY)

  return {
    id,
    title,
    titleNumber: directNumber ?? parsedNumber ?? 0,
    ...(rows !== undefined ? { rows } : {}),
    ...(cols !== undefined ? { cols } : {}),
    ...(buffer !== undefined ? { buffer } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(scrollY !== undefined ? { scrollY } : {}),
  }
}

function snapshotFromLegacy(value: LegacyTerminal): TerminalSnapshot | undefined {
  const snapshot: TerminalSnapshot = {}
  if (value.rows !== undefined && value.cols !== undefined) {
    snapshot.size = { rows: value.rows, cols: value.cols }
  }
  if (value.buffer !== undefined) snapshot.buffer = value.buffer
  if (value.cursor !== undefined) snapshot.cursor = value.cursor
  if (value.scrollY !== undefined) snapshot.scrollY = value.scrollY
  return Object.keys(snapshot).length ? snapshot : undefined
}

function snapshotFromValue(value: unknown): TerminalSnapshot | undefined {
  if (!record(value)) return
  const size = record(value.size) ? value.size : undefined
  const rows = positiveInteger(size?.rows)
  const cols = positiveInteger(size?.cols)
  const buffer = text(value.buffer)
  const cursor = num(value.cursor)
  const scrollY = num(value.scrollY)
  const snapshot: TerminalSnapshot = {}
  if (rows !== undefined && cols !== undefined) snapshot.size = { rows, cols }
  if (buffer !== undefined) snapshot.buffer = buffer
  if (cursor !== undefined) snapshot.cursor = cursor
  if (scrollY !== undefined) snapshot.scrollY = scrollY
  return Object.keys(snapshot).length ? snapshot : undefined
}

function stableTabID(legacyID: string, order: number, seen: Set<string>): TerminalTabID {
  let candidate = terminalTabID(`tab_${hash(`${legacyID}:${order}`)}`)
  let suffix = 1
  while (seen.has(candidate)) {
    candidate = terminalTabID(`tab_${hash(`${legacyID}:${order}:${suffix}`)}`)
    suffix += 1
  }
  return candidate
}

function hash(value: string) {
  let next = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    next ^= value.charCodeAt(i)
    next = Math.imul(next, 0x01000193)
  }
  return (next >>> 0).toString(16).padStart(8, "0")
}

function sanitizeTab(value: unknown, fallbackOrder: number): TerminalTab | undefined {
  if (!record(value)) return
  const rawTabID = text(value.tabID)
  if (!rawTabID || rawTabID.startsWith("pty_")) return
  const title = text(value.title) ?? ""
  const order = num(value.order)
  const snapshot = snapshotFromValue(value.snapshot)
  return {
    tabID: terminalTabID(rawTabID),
    title,
    titleNumber: positiveInteger(value.titleNumber) ?? titleNumber(title, MAX_TERMINAL_SESSIONS) ?? 0,
    order: order !== undefined ? order : fallbackOrder,
    ...(snapshot ? { snapshot } : {}),
  }
}

function sanitizeV2(value: unknown): PersistedTerminalStateV2 {
  if (!record(value)) return { version: TERMINAL_STORAGE_VERSION, tabs: [] }
  const tabs = Array.isArray(value.tabs) ? value.tabs.flatMap((tab, index) => sanitizeTab(tab, index) ?? []) : []
  const seen = new Set<string>()
  const uniqueTabs = tabs.flatMap((tab) => {
    if (seen.has(tab.tabID)) return []
    seen.add(tab.tabID)
    return [tab]
  })
  const active = text(value.activeTabID)
  return {
    version: TERMINAL_STORAGE_VERSION,
    ...(active && seen.has(active) ? { activeTabID: terminalTabID(active) } : {}),
    tabs: uniqueTabs,
  }
}

export function migratePersistedTerminalState(value: unknown): PersistedTerminalStateV2 {
  if (isV2(value)) return sanitizeV2(value)
  if (!record(value)) return { version: TERMINAL_STORAGE_VERSION, tabs: [] }

  const seenLegacy = new Set<string>()
  const seenTabs = new Set<string>()
  const legacy = Array.isArray(value.all)
    ? value.all.flatMap((item) => {
        const terminal = legacyTerminal(item)
        if (!terminal || seenLegacy.has(terminal.id)) return []
        seenLegacy.add(terminal.id)
        return [terminal]
      })
    : []

  const active = text(value.active)
  const tabs = legacy.map((terminal, order) => {
    const snapshot = snapshotFromLegacy(terminal)
    const tabID = stableTabID(terminal.id, order, seenTabs)
    seenTabs.add(tabID)
    return {
      tabID,
      title: terminal.title,
      titleNumber: terminal.titleNumber,
      order,
      ...(snapshot ? { snapshot } : {}),
    }
  })

  const activeIndex = active ? legacy.findIndex((terminal) => terminal.id === active) : -1
  return {
    version: TERMINAL_STORAGE_VERSION,
    ...(activeIndex >= 0 ? { activeTabID: tabs[activeIndex]?.tabID } : tabs[0] ? { activeTabID: tabs[0].tabID } : {}),
    tabs,
  }
}

export function sanitizePersistedTerminalState(value: unknown): PersistedTerminalStateV2 {
  return sanitizeV2(value)
}

export function assertNoUnsafeTerminalStorageFields(value: unknown) {
  const path = findUnsafeField(value)
  if (!path) return
  throw new Error(`Unsafe terminal storage field: ${path}`)
}

function findUnsafeField(value: unknown, path = ""): string | undefined {
  if (!record(value)) return
  for (const [key, child] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key
    if ((unsafeTerminalStorageFieldNames as readonly string[]).includes(key)) return nextPath
    if (Array.isArray(child)) {
      for (let index = 0; index < child.length; index += 1) {
        const found = findUnsafeField(child[index], `${nextPath}.${index}`)
        if (found) return found
      }
      continue
    }
    const found = findUnsafeField(child, nextPath)
    if (found) return found
  }
  return
}
