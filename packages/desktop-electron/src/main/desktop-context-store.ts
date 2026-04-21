import type { DesktopContext } from "../preload/types"

export function createDesktopContextStore(fallback: () => DesktopContext) {
  const contexts = new Map<number, DesktopContext>()
  let mostRecent: DesktopContext | undefined

  return {
    set(windowID: number, context: DesktopContext) {
      contexts.set(windowID, context)
      mostRecent = context
    },
    delete(windowID: number) {
      const removed = contexts.get(windowID)
      contexts.delete(windowID)
      if (removed === mostRecent) mostRecent = [...contexts.values()].at(-1)
    },
    current(windowID?: number | null) {
      if (windowID !== undefined && windowID !== null) return contexts.get(windowID) ?? fallback()
      return mostRecent ?? fallback()
    },
  }
}
