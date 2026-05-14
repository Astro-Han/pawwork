export const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list"])
export const HIDDEN_TOOLS = new Set(["todowrite"])

export function list<T>(value: T[] | undefined | null, fallback: T[]) {
  if (Array.isArray(value)) return value
  return fallback
}

export function latestDefined<T>(value: () => T | undefined) {
  let latest: T | undefined
  return () => {
    const next = value()
    if (next !== undefined) latest = next
    return latest
  }
}

export function same<T>(a: readonly T[] | undefined, b: readonly T[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

export function index<T extends { id: string }>(items: readonly T[]) {
  return new Map(items.map((item) => [item.id, item] as const))
}
