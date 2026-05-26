export type DirectoryEvent = {
  type: string
  properties?: unknown
}

export function directoryEventTargets(input: {
  directory: string
  event: DirectoryEvent
  hasChild: (directory: string) => boolean
}) {
  const targets = [input.directory]
  if (input.event.type !== "session.updated") return targets

  const info = (input.event.properties as { info?: SessionDirectoryInfo } | undefined)?.info
  const ownerDirectory = info?.executionContext?.ownerDirectory ?? info?.directory
  if (!ownerDirectory || ownerDirectory === input.directory || !input.hasChild(ownerDirectory)) return targets

  targets.push(ownerDirectory)
  return targets
}

type SessionDirectoryInfo = {
  directory?: string
  executionContext?: {
    ownerDirectory?: string
  }
}
