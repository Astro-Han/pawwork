import type { Session } from "@opencode-ai/sdk/v2"
import { showToast } from "@opencode-ai/ui/toast"
import type { useLanguage } from "@/context/language"
import type { usePrompt } from "@/context/prompt"
import type { useSDK } from "@/context/sdk"
import type { useSync } from "@/context/sync"
import { promptScopeForSession } from "@/pages/session/prompt-route-scope"
import type { ExecutionScope } from "@/pages/session/execution-scope"
import { extractPromptFromParts } from "@/utils/prompt"
import { formatServerError } from "@/utils/server-errors"

type SyncStore = ReturnType<typeof useSync>["data"]
type SyncSetter = ReturnType<typeof useSync>["set"]
type Translate = ReturnType<typeof useLanguage>["t"]

export function createSessionRevertSupport(input: {
  directory: () => string
  routeDir: () => string | undefined
  sessionID: () => string | undefined
  attachmentLabel: () => string
  t: Translate
  prompt: ReturnType<typeof usePrompt>
  sync: ReturnType<typeof useSync>
  createClient: ReturnType<typeof useSDK>["createClient"]
  currentExecutionScope: () => ExecutionScope
}) {
  const draftFrom = (source: { directory: string; store: SyncStore }, id: string) =>
    extractPromptFromParts(source.store.part[id] ?? [], {
      directory: source.directory,
      attachmentName: input.attachmentLabel(),
    })

  const line = (id: string) => {
    const text = draftFrom({ directory: input.directory(), store: input.sync.data }, id)
      .map((part) => {
        if (part.type === "image") return `[image:${part.filename}]`
        if (part.type === "attachment") return `[file:${part.path}]`
        return part.content
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text
    return `[${input.attachmentLabel()}]`
  }

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: input.t("common.requestFailed"),
      description: formatServerError(err, input.t),
    })
  }

  const merge = (setStore: SyncSetter, next: Session) =>
    setStore("session", (list) => {
      const idx = list.findIndex((item) => item.id === next.id)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = next
      return out
    })

  const roll = (setStore: SyncSetter, sessionID: string, next: Session["revert"]) =>
    setStore("session", (list) => {
      const idx = list.findIndex((item) => item.id === sessionID)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = { ...out[idx], revert: next }
      return out
    })

  const snapshot = () => {
    const directory = input.directory()
    const handle = input.sync.retainDirectory(directory)
    const scope = input.currentExecutionScope()
    return {
      scope,
      currentScope: input.currentExecutionScope,
      client: input.createClient({ directory, throwOnError: true }),
      store: handle.store,
      setStore: handle.setStore,
      prompt: input.prompt.current().slice(),
      promptScope: promptScopeForSession({
        routeDir: input.routeDir(),
        routeDirectory: directory,
        targetDirectory: directory,
        sessionID: input.sessionID(),
      }),
      release: handle.release,
      directory,
    }
  }

  return {
    draftFrom,
    fail,
    line,
    merge,
    roll,
    snapshot,
  }
}
