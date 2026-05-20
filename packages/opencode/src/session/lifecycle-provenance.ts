import type { LifecycleKind } from "./run-observability/types"

export type LifecycleCloseAction = {
  actionID: string
  kind: LifecycleKind
}

let nextActionID = 0
const activeByDirectory = new Map<string, LifecycleCloseAction>()

export function createLifecycleCloseAction(kind: LifecycleKind): LifecycleCloseAction {
  nextActionID += 1
  return {
    actionID: `lifecycle:${kind}:${Date.now().toString(36)}:${nextActionID.toString(36)}`,
    kind,
  }
}

export async function withLifecycleCloseAction<T>(
  directories: string[],
  action: LifecycleCloseAction,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, LifecycleCloseAction | undefined>()
  for (const directory of directories) {
    previous.set(directory, activeByDirectory.get(directory))
    activeByDirectory.set(directory, action)
  }
  try {
    return await fn()
  } finally {
    for (const directory of directories) {
      const before = previous.get(directory)
      if (before) activeByDirectory.set(directory, before)
      else activeByDirectory.delete(directory)
    }
  }
}

export function currentLifecycleCloseAction(directory: string): LifecycleCloseAction | undefined {
  return activeByDirectory.get(directory)
}
