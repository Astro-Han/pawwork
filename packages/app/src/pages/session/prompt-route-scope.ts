import { base64Encode } from "@opencode-ai/util/encode"

export type PromptRouteScope = {
  dir: string
  id?: string
}

export function promptScopeForSession(input: {
  routeDir: string | undefined
  routeDirectory: string | undefined
  targetDirectory: string
  sessionID: string | undefined
}): PromptRouteScope {
  const dir =
    input.routeDir && input.routeDirectory === input.targetDirectory
      ? input.routeDir
      : base64Encode(input.targetDirectory)
  return { dir, id: input.sessionID }
}
