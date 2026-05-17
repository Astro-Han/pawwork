import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function merge(defaults: unknown, value: unknown): unknown {
  if (value === undefined) return defaults
  if (value === null) return value

  if (Array.isArray(defaults)) {
    if (Array.isArray(value)) return value
    return defaults
  }

  if (isRecord(defaults)) {
    if (!isRecord(value)) return defaults

    const result: Record<string, unknown> = { ...defaults }
    for (const key of Object.keys(value)) {
      if (key in defaults) {
        result[key] = merge((defaults as Record<string, unknown>)[key], (value as Record<string, unknown>)[key])
      } else {
        result[key] = (value as Record<string, unknown>)[key]
      }
    }
    return result
  }

  return value
}

function parse(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

export function normalize(defaults: unknown, raw: string, migrate?: (value: unknown) => unknown) {
  const parsed = parse(raw)
  if (parsed === undefined) return
  const migrated = migrate ? migrate(parsed) : parsed
  if (migrate && migrated === undefined) return
  const merged = merge(defaults, migrated)
  return JSON.stringify(merged)
}

export function readPersistedSync(input: {
  current: SyncStorage
  legacyStore: SyncStorage
  key: string
  defaults: unknown
  legacy: string[]
  currentLegacy: string[]
  migrate?: (value: unknown) => unknown
}) {
  const raw = input.current.getItem(input.key)
  if (raw !== null) {
    const next = normalize(input.defaults, raw, input.migrate)
    if (next === undefined) {
      input.current.removeItem(input.key)
      return null
    }
    if (raw !== next) input.current.setItem(input.key, next)
    return next
  }

  for (const legacyKey of input.currentLegacy) {
    const legacyRaw = input.current.getItem(legacyKey)
    if (legacyRaw === null) continue

    const next = normalize(input.defaults, legacyRaw, input.migrate)
    if (next === undefined) continue
    input.current.setItem(input.key, next)
    return next
  }

  for (const legacyKey of input.legacy) {
    const legacyRaw = input.legacyStore.getItem(legacyKey)
    if (legacyRaw === null) continue

    const next = normalize(input.defaults, legacyRaw, input.migrate)
    if (next === undefined) {
      input.legacyStore.removeItem(legacyKey)
      continue
    }
    input.current.setItem(input.key, next)
    input.legacyStore.removeItem(legacyKey)
    return next
  }

  return null
}

export async function readPersistedAsync(input: {
  current: AsyncStorage
  legacyStore?: AsyncStorage
  key: string
  defaults: unknown
  legacy: string[]
  currentLegacy: string[]
  migrate?: (value: unknown) => unknown
}) {
  const raw = await input.current.getItem(input.key)
  if (raw !== null) {
    const next = normalize(input.defaults, raw, input.migrate)
    if (next === undefined) {
      await input.current.removeItem(input.key).catch(() => undefined)
      return null
    }
    if (raw !== next) await input.current.setItem(input.key, next)
    return next
  }

  for (const legacyKey of input.currentLegacy) {
    const legacyRaw = await input.current.getItem(legacyKey)
    if (legacyRaw === null) continue

    const next = normalize(input.defaults, legacyRaw, input.migrate)
    if (next === undefined) continue
    await input.current.setItem(input.key, next)
    return next
  }

  if (!input.legacyStore) return null

  for (const legacyKey of input.legacy) {
    const legacyRaw = await input.legacyStore.getItem(legacyKey)
    if (legacyRaw === null) continue

    const next = normalize(input.defaults, legacyRaw, input.migrate)
    if (next === undefined) {
      await input.legacyStore.removeItem(legacyKey).catch(() => undefined)
      continue
    }
    await input.current.setItem(input.key, next)
    await input.legacyStore.removeItem(legacyKey)
    return next
  }

  return null
}
