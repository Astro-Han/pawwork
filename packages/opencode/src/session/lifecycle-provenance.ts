import type { LifecycleKind } from "./run-observability/types"

export type LifecycleCloseAction = {
  actionID: string
  kind: LifecycleKind
}

let nextActionID = 0
const activeByDirectory = new Map<string, LifecycleCloseAction[]>()

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
  for (const directory of directories) {
    const stack = activeByDirectory.get(directory) ?? []
    stack.push(action)
    activeByDirectory.set(directory, stack)
  }
  try {
    return await fn()
  } finally {
    for (const directory of directories) {
      const stack = activeByDirectory.get(directory)
      if (!stack) continue
      const index = stack.lastIndexOf(action)
      if (index >= 0) stack.splice(index, 1)
      if (stack.length) activeByDirectory.set(directory, stack)
      else activeByDirectory.delete(directory)
    }
  }
}

export function currentLifecycleCloseAction(directory: string): LifecycleCloseAction | undefined {
  return activeByDirectory.get(directory)?.at(-1)
}
