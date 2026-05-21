export const ROW_LOCAL_PERSISTED_STATE_LIMIT = 500

export type BoundedStateMap<Value> = {
  readonly size: number
  get(key: string): Value | undefined
  has(key: string): boolean
  set(key: string, value: Value): void
}

export function createBoundedStateMap<Value>(limit = ROW_LOCAL_PERSISTED_STATE_LIMIT): BoundedStateMap<Value> {
  const entries = new Map<string, Value>()

  return {
    get size() {
      return entries.size
    },
    get(key) {
      if (!entries.has(key)) return undefined
      const value = entries.get(key) as Value
      entries.delete(key)
      entries.set(key, value)
      return value
    },
    has(key) {
      return entries.has(key)
    },
    set(key, value) {
      if (entries.has(key)) {
        entries.delete(key)
      } else {
        while (entries.size >= limit) {
          const oldest = entries.keys().next()
          if (oldest.done) break
          entries.delete(oldest.value)
        }
      }
      entries.set(key, value)
    },
  }
}
