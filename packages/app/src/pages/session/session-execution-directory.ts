import { createExecutionScopeTracker, type ExecutionScope } from "./execution-scope"

export type SessionExecutionDirectoryInfo = {
  executionContext?: {
    activeDirectory?: string | null
  } | null
} | null

export function sessionExecutionDirectory(input: {
  routeDirectory: string
  session: SessionExecutionDirectoryInfo | undefined
}) {
  return input.session?.executionContext?.activeDirectory || input.routeDirectory
}

export function createSessionExecutionState(input: {
  serverKey: () => string
  routeDirectory: () => string
  session: () => SessionExecutionDirectoryInfo | undefined
}): {
  directory: () => string
  scope: () => ExecutionScope
} {
  const directory = () =>
    sessionExecutionDirectory({ routeDirectory: input.routeDirectory(), session: input.session() })
  const tracker = createExecutionScopeTracker()

  return {
    directory,
    scope: () => tracker({ serverKey: input.serverKey(), directory: directory() }),
  }
}
