import { createMemo, type Accessor } from "solid-js"
import { isWorkInFlightStatus } from "@opencode-ai/ui/util/session-status"
import { type ImageAttachmentPart, type usePrompt } from "@/context/prompt"
import type { useSync } from "@/context/sync"
import type { useSDK } from "@/context/sdk"
import type { usePermission } from "@/context/permission"
import type { useLanguage } from "@/context/language"
import { promptPlaceholder } from "./placeholder"
import type { PromptStore } from "./store-types"

export interface PromptDerivedStateDeps {
  store: PromptStore
  prompt: ReturnType<typeof usePrompt>
  sync: ReturnType<typeof useSync>
  sdk: ReturnType<typeof useSDK>
  permission: ReturnType<typeof usePermission>
  language: ReturnType<typeof useLanguage>
  activeSessionID: Accessor<string | undefined>
  actionReadyProp: () => boolean | undefined
  abortReadyProp: () => boolean | undefined
}

export function createPromptDerivedState(deps: PromptDerivedStateDeps) {
  const { store, prompt, sync, sdk, permission, language, activeSessionID, actionReadyProp, abortReadyProp } = deps

  const info = createMemo(() => (activeSessionID() ? sync.session.get(activeSessionID()!) : undefined))
  const status = createMemo(
    () =>
      sync.data.session_status[activeSessionID() ?? ""] ?? {
        type: "idle",
      },
  )
  const working = createMemo(() => isWorkInFlightStatus(status()))
  const imageAttachments = createMemo(() =>
    prompt.current().filter((part): part is ImageAttachmentPart => part.type === "image"),
  )
  const actionReady = createMemo(() => actionReadyProp() ?? true)
  const abortReady = createMemo(() => abortReadyProp() ?? actionReady())

  const commentCount = createMemo(() => {
    if (store.mode === "shell") return 0
    return prompt.context.items().filter((item) => !!item.comment?.trim()).length
  })
  const blank = createMemo(() => {
    const text = prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    return text.trim().length === 0 && imageAttachments().length === 0 && commentCount() === 0
  })
  const stopping = createMemo(() => working() && blank())

  const contextItems = createMemo(() => {
    const items = prompt.context.items()
    if (store.mode !== "shell") return items
    return items.filter((item) => !item.comment?.trim())
  })

  const placeholder = createMemo(() =>
    promptPlaceholder({
      mode: store.mode,
      commentCount: commentCount(),
      t: (key) => language.t(key as Parameters<typeof language.t>[0]),
    }),
  )

  const accepting = createMemo(() => {
    const id = activeSessionID()
    if (!id) return permission.isAutoAcceptingDirectory(sdk.directory)
    return permission.isAutoAccepting(id, sdk.directory)
  })

  return {
    info,
    working,
    imageAttachments,
    actionReady,
    abortReady,
    commentCount,
    blank,
    stopping,
    contextItems,
    placeholder,
    accepting,
  }
}
