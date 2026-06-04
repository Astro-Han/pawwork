type SessionExecutionDirectoryInfo = {
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
