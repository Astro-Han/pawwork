import type { useSDK } from "@/context/sdk"
import { emitRendererDiagnostic, sessionAbortDiagnosticEvent } from "@/context/renderer-diagnostics"
import { rendererAbortDiagnosticSource, type RendererAbortSource } from "@/session/abort-source"

export type AbortSource = Extract<RendererAbortSource, "ctrlG" | "escape" | "stopButton">

export type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

export const pending = new Map<string, PendingPrompt>()

const emitAbortDiagnostic = (input: {
  routeSessionID?: string
  visibleSessionID?: string
  timelineSessionID?: string
  source: AbortSource
  result: "aborted" | "ignored_awaiting_question"
}) => {
  void emitRendererDiagnostic(sessionAbortDiagnosticEvent(input)).catch(() => undefined)
}

export function createAbort(deps: {
  abortReady: () => boolean
  sessionID: () => string | undefined
  onAbort?: () => void
  client: () => ReturnType<typeof useSDK>["client"]
}) {
  return async (source: AbortSource = "stopButton") => {
    if (!deps.abortReady()) return Promise.resolve()

    const activeSessionID = deps.sessionID()
    if (!activeSessionID) return Promise.resolve()

    deps.onAbort?.()

    const queued = pending.get(activeSessionID)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(activeSessionID)
      emitAbortDiagnostic({
        routeSessionID: activeSessionID,
        visibleSessionID: activeSessionID,
        timelineSessionID: activeSessionID,
        source,
        result: "aborted",
      })
      return Promise.resolve()
    }
    return deps.client().session
      .abort({
        sessionID: activeSessionID,
        source: rendererAbortDiagnosticSource({ sessionID: activeSessionID, source }),
      })
      .then((result) => {
        emitAbortDiagnostic({
          routeSessionID: activeSessionID,
          visibleSessionID: activeSessionID,
          timelineSessionID: activeSessionID,
          source,
          result: result.data === false ? "ignored_awaiting_question" : "aborted",
        })
      })
      .catch(() => {})
  }
}
